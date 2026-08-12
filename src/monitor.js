// -----------------------------------------------------------------------------
// The heart of the integration: the silence watchdog.
//
// Principle: a Zigbee device that is alive TALKS. Sensors send their readings,
// routers answer, everything reports at least periodically. So the only fact
// worth recording is "when did I last hear from this device?", and the only
// question worth asking is "has it been silent for longer than it should?".
//
// Why not the battery level: a Zigbee battery percentage is a coarse, rarely
// refreshed and often plainly wrong estimate — a CR2032 sensor commonly reports
// 100% until the day it stops answering. It says nothing about a device that
// fell off the network, was unplugged, or lost its route. Silence does.
//
// This class holds NO I/O: it is fed by the MQTT layer (`recordActivity`,
// `setZ2mDevices`, ...) and answers with `snapshot()`, which makes the whole
// decision logic testable without a broker.
// -----------------------------------------------------------------------------

import { parseCustomTimeouts, parseDeviceList } from './config.js';

const MINUTE_MS = 60 * 1000;

export class DevicesMonitor {
  /**
   * @param {object} options - Options.
   * @param {Record<string, unknown>} options.config - Normalized configuration.
   * @param {() => number} [options.now] - Clock, injectable for the tests.
   */
  constructor({ config, now = () => Date.now() }) {
    this.now = now;
    // Reference point for devices we have never heard from: without it, a
    // freshly installed integration would declare the whole network dead.
    this.startedAt = now();
    this.setConfig(config);

    /** @type {Map<string, object>} IEEE address -> device descriptor. */
    this.devicesByIeee = new Map();
    /** @type {Map<string, string>} Friendly name -> IEEE address. */
    this.ieeeByFriendlyName = new Map();
    /** @type {Map<string, {lastSeen: number|null, availability: string|null}>} */
    this.activityByIeee = new Map();
    /**
     * Activity received for a friendly name we cannot resolve yet: the device
     * inventory and the device reports race on connection, and a report that
     * arrives first must not be thrown away.
     * @type {Map<string, object>}
     */
    this.pendingByFriendlyName = new Map();

    this.bridgeOnline = null;
    this.inventoryReceivedAt = null;
  }

  /**
   * Apply a new configuration (hot-reloaded from the Gladys UI).
   * @param {Record<string, unknown>} config - Normalized configuration.
   */
  setConfig(config) {
    this.config = config;
    this.customTimeouts = parseCustomTimeouts(config.custom_timeouts);
    this.ignoredDevices = parseDeviceList(config.ignored_devices);
  }

  /**
   * Replace the device inventory with the one just read from `bridge/devices`.
   * @param {Array<object>} devices - Devices parsed by `parseBridgeDevices`.
   */
  setZ2mDevices(devices) {
    this.devicesByIeee = new Map(devices.map((device) => [device.ieeeAddress, device]));
    this.ieeeByFriendlyName = new Map(
      devices.map((device) => [device.friendlyName, device.ieeeAddress]),
    );
    this.inventoryReceivedAt = this.now();

    // Drop the activity of devices that left the network, then replay whatever
    // arrived before we knew who it belonged to.
    for (const ieee of this.activityByIeee.keys()) {
      if (!this.devicesByIeee.has(ieee)) {
        this.activityByIeee.delete(ieee);
      }
    }
    for (const [friendlyName, activity] of this.pendingByFriendlyName) {
      const ieee = this.resolveIeee(friendlyName);
      if (ieee) {
        this.mergeActivity(ieee, activity);
        this.pendingByFriendlyName.delete(friendlyName);
      }
    }
  }

  /**
   * Record that a device gave a sign of life.
   * @param {string} friendlyName - Friendly name (or IEEE address) read from the topic.
   * @param {object} [details] - Details.
   * @param {number} [details.at] - When the device spoke, in milliseconds. Defaults to now.
   */
  recordActivity(friendlyName, { at } = {}) {
    this.mergeActivity(friendlyName, {
      lastSeen: Number.isFinite(at) ? at : this.now(),
    });
  }

  /**
   * Record Zigbee2MQTT's own availability verdict for a device (second opinion,
   * never the source of the alive state — see `parseAvailability`).
   * @param {string} friendlyName - Friendly name (or IEEE address).
   * @param {'online'|'offline'} availability - Reported availability.
   */
  recordAvailability(friendlyName, availability) {
    this.mergeActivity(friendlyName, { availability });
  }

  /**
   * Record the bridge online state.
   * @param {boolean} online - True when the bridge is online.
   */
  setBridgeOnline(online) {
    this.bridgeOnline = online;
  }

  /**
   * Restore the last-seen timestamps persisted by a previous run.
   *
   * Without this, restarting the container would reset every device to "just
   * started, give it the benefit of the doubt" and a device that died last week
   * would look healthy again for a full timeout.
   * @param {Record<string, {last_seen?: number}>} saved - Persisted map, keyed by IEEE address.
   */
  restore(saved) {
    if (!saved || typeof saved !== 'object') {
      return;
    }
    const now = this.now();
    for (const [ieee, entry] of Object.entries(saved)) {
      const lastSeen = Number(entry?.last_seen);
      if (Number.isFinite(lastSeen) && lastSeen > 0 && lastSeen <= now) {
        this.mergeActivity(ieee, { lastSeen });
      }
    }
  }

  /**
   * Build the payload to persist, so `restore()` can replay it after a restart.
   *
   * The unresolved entries are included on purpose: while Zigbee2MQTT is down
   * the inventory never arrives, so everything sits in the pending map — and
   * persisting only the resolved half would quietly erase the whole history on
   * the next scheduled write.
   * @returns {Record<string, {last_seen: number}>} Last-seen timestamps, keyed by IEEE address (or by friendly name while unresolved).
   */
  serialize() {
    const saved = {};
    for (const [key, activity] of [...this.pendingByFriendlyName, ...this.activityByIeee]) {
      if (activity.lastSeen !== null) {
        saved[key] = { last_seen: activity.lastSeen };
      }
    }
    return saved;
  }

  /**
   * The friendly names currently known, used to parse the incoming topics.
   * @returns {Set<string>} Known friendly names.
   */
  knownFriendlyNames() {
    return new Set(this.ieeeByFriendlyName.keys());
  }

  /**
   * Evaluate every device against its silence threshold.
   * @returns {{now: number, devices: Array<object>, summary: object}} The current picture of the network.
   */
  snapshot() {
    const now = this.now();
    const devices = [];

    for (const device of this.devicesByIeee.values()) {
      const activity = this.activityByIeee.get(device.ieeeAddress) ?? emptyActivity();
      const timeoutMinutes = this.timeoutMinutesFor(device);
      // A device we have never heard from is measured from the moment the
      // monitor started: it gets exactly one full threshold to prove itself,
      // instead of being declared dead on the first tick.
      const reference = activity.lastSeen ?? this.startedAt;
      const silenceMinutes = Math.max(0, Math.floor((now - reference) / MINUTE_MS));

      devices.push({
        ...device,
        monitored: this.isMonitored(device),
        battery: isBatteryPowered(device),
        timeoutMinutes,
        lastSeen: activity.lastSeen,
        neverSeen: activity.lastSeen === null,
        silenceMinutes,
        alive: silenceMinutes <= timeoutMinutes,
        availability: activity.availability,
      });
    }

    devices.sort((a, b) => a.friendlyName.localeCompare(b.friendlyName));

    const monitored = devices.filter((device) => device.monitored);
    const silent = monitored.filter((device) => !device.alive);

    return {
      now,
      devices,
      summary: {
        total: devices.length,
        monitored: monitored.length,
        alive: monitored.length - silent.length,
        silent: silent.length,
        silentDevices: silent,
        bridgeOnline: this.bridgeOnline,
        inventoryReceived: this.inventoryReceivedAt !== null,
      },
    };
  }

  /**
   * Should this device be watched at all?
   * @param {object} device - Device descriptor.
   * @returns {boolean} True when the device counts towards the alerts.
   */
  isMonitored(device) {
    if (device.disabled && !this.config.monitor_disabled_devices) {
      return false;
    }
    return !this.isIgnored(device);
  }

  /**
   * Is this device on the user's ignore list (by friendly name or IEEE address)?
   * @param {object} device - Device descriptor.
   * @returns {boolean} True when the user excluded it.
   */
  isIgnored(device) {
    return (
      this.ignoredDevices.has(device.friendlyName.toLowerCase()) ||
      this.ignoredDevices.has(device.ieeeAddress.toLowerCase())
    );
  }

  /**
   * Resolve the silence threshold of a device: the user's per-device override
   * first, then the default for its power source.
   * @param {object} device - Device descriptor.
   * @returns {number} Threshold in minutes.
   */
  timeoutMinutesFor(device) {
    const custom =
      this.customTimeouts.get(device.friendlyName.toLowerCase()) ??
      this.customTimeouts.get(device.ieeeAddress.toLowerCase());
    if (custom !== undefined) {
      return custom;
    }
    return isBatteryPowered(device)
      ? this.config.battery_timeout_minutes
      : this.config.default_timeout_minutes;
  }

  /**
   * Resolve a friendly name (or an IEEE address) to an IEEE address.
   * @param {string} nameOrIeee - Value read from a topic or an event.
   * @returns {string | undefined} The IEEE address, or undefined when unknown.
   */
  resolveIeee(nameOrIeee) {
    if (this.devicesByIeee.has(nameOrIeee)) {
      return nameOrIeee;
    }
    return this.ieeeByFriendlyName.get(nameOrIeee);
  }

  /**
   * Merge a partial activity record, buffering it when the device is not known
   * yet (the inventory has not arrived, or the device was just paired).
   * @param {string} nameOrIeee - Friendly name or IEEE address.
   * @param {object} update - Partial `{ lastSeen, availability }`.
   */
  mergeActivity(nameOrIeee, update) {
    const ieee = this.resolveIeee(nameOrIeee);
    const target = ieee ? this.activityByIeee : this.pendingByFriendlyName;
    const key = ieee ?? nameOrIeee;
    const current = target.get(key) ?? emptyActivity();

    if (update.lastSeen !== undefined) {
      // Keep the most recent proof of life: a retained report carrying an old
      // `last_seen` must never push the timestamp backwards.
      current.lastSeen = Math.max(current.lastSeen ?? 0, update.lastSeen);
    }
    if (update.availability !== undefined) {
      current.availability = update.availability;
    }
    target.set(key, current);
  }
}

/**
 * Is the device battery powered? Battery devices sleep most of the time and are
 * expected to be far more silent than a mains-powered router.
 * @param {object} device - Device descriptor.
 * @returns {boolean} True for a battery device.
 */
export function isBatteryPowered(device) {
  return String(device.powerSource ?? '')
    .toLowerCase()
    .startsWith('battery');
}

/**
 * A blank activity record.
 * @returns {{lastSeen: null, availability: null}} Empty record.
 */
function emptyActivity() {
  return { lastSeen: null, availability: null };
}
