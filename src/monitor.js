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
//
// Silence is only meaningful while we can HEAR the network. While the broker is
// unreachable or the bridge is offline, every device goes quiet for the same
// reason; once the network is back, a mains plug that reports every few minutes
// would still be declared dead on the first tick — its last report predates the
// outage — and "back" right after. So the monitor remembers the outages
// (`setListening`, `setBridgeOnline`) and, for the VERDICT only, measures the
// silence of a device that was alive when an outage began from the end of that
// outage: it gets one full threshold to speak again, exactly like a device
// never heard from gets one from `startedAt`. A device already dead before the
// outage gets nothing — it stays dead. The displayed silence is never adjusted:
// it is the plain time since the last sign of life.
// -----------------------------------------------------------------------------

import { parseCustomTimeouts, parseDeviceList } from './config.js';

const MINUTE_MS = 60 * 1000;

// Activity buffered for a name we cannot resolve is a race with the inventory
// that lasts seconds; past an hour it is a Zigbee2MQTT group, a stale name or a
// removed device, and keeping it would re-serialize it to `/data` forever.
export const PENDING_TTL_MS = 60 * MINUTE_MS;
// Hard bound on the same buffer, whatever publishes under the base topic.
export const MAX_PENDING = 256;
// Only the recent outages can still change a verdict; a flapping broker must
// not grow this list for ever.
const MAX_OUTAGES = 16;

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
    /** @type {Set<string>} Zigbee2MQTT group names: they publish, but are not devices. */
    this.groupNames = new Set();

    this.bridgeOnline = null;
    this.inventoryReceivedAt = null;

    // Can we hear the network right now? Deaf until the MQTT session is up.
    this.mqttConnected = false;
    this.hearing = false;
    /** When the current deafness began, or null while hearing. */
    this.deafSince = this.startedAt;
    /** @type {Array<{from: number, to: number}>} Past periods we could not hear, oldest first. */
    this.outages = [];
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

    // Drop the activity of devices that left the network — unless the network
    // is now EMPTY: a Zigbee2MQTT started on a lost or reset database announces
    // the coordinator alone, and wiping the history then would hand every
    // device a fresh threshold once it is re-paired under the same address.
    if (devices.length > 0) {
      for (const ieee of this.activityByIeee.keys()) {
        if (!this.devicesByIeee.has(ieee)) {
          this.activityByIeee.delete(ieee);
        }
      }
    }
    // Then replay whatever arrived before we knew who it belonged to.
    for (const [friendlyName, activity] of this.pendingByFriendlyName) {
      const ieee = this.resolveIeee(friendlyName);
      if (ieee) {
        this.mergeActivity(ieee, activity);
        this.pendingByFriendlyName.delete(friendlyName);
      }
    }
    this.prunePending();
  }

  /**
   * Record the Zigbee2MQTT group names read from `bridge/groups`. A group
   * publishes its state under the base topic like a device does, but it is no
   * device: its name is never resolved and must not be buffered.
   * @param {string[]} names - Group friendly names.
   */
  setZ2mGroups(names) {
    this.groupNames = new Set(names);
    this.prunePending();
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
    this.updateHearing();
  }

  /**
   * Record the state of the MQTT session.
   * @param {boolean} connected - True while the session to the broker is up.
   */
  setListening(connected) {
    this.mqttConnected = connected;
    this.updateHearing();
  }

  /**
   * The last moment the monitor could hear the network: now while it can, the
   * start of the current outage otherwise. Persisted, so the next run knows
   * when the previous one stopped listening (see `restore`).
   * @returns {number} A timestamp in milliseconds.
   */
  lastHeardAt() {
    return this.hearing ? this.now() : this.deafSince;
  }

  /**
   * Track the moments we start and stop hearing the network: an outage ends
   * when the MQTT session is up AND the bridge is not known to be offline.
   */
  updateHearing() {
    const hearing = this.mqttConnected && this.bridgeOnline !== false;
    if (hearing === this.hearing) {
      return;
    }
    const now = this.now();
    this.hearing = hearing;
    if (!hearing) {
      this.deafSince = now;
      return;
    }
    if (this.deafSince !== null && this.deafSince < now) {
      this.outages.push({ from: this.deafSince, to: now });
      this.outages.splice(0, Math.max(0, this.outages.length - MAX_OUTAGES));
    }
    this.deafSince = null;
  }

  /**
   * Where the silence of a device is measured from, for the verdict: its last
   * sign of life, moved to the end of every outage that began while it was
   * still within its threshold.
   * @param {number} lastSign - Last sign of life (or `startedAt` when never seen).
   * @param {number} timeoutMs - Its silence threshold.
   * @returns {number} The reference timestamp of the verdict.
   */
  verdictReference(lastSign, timeoutMs) {
    let reference = lastSign;
    for (const { from, to } of this.outages) {
      if (to > reference && from - reference <= timeoutMs) {
        reference = to;
      }
    }
    return reference;
  }

  /**
   * Restore the last-seen timestamps persisted by a previous run.
   *
   * Without this, restarting the container would reset every device to "just
   * started, give it the benefit of the doubt" and a device that died last week
   * would look healthy again for a full timeout.
   *
   * `heardAt` is when the previous run last heard the network: the container
   * being down is an outage like any other, and the devices alive at that
   * moment get one threshold from the next reconnection to speak again.
   * Without it (a file written before it existed) the outage is counted from
   * this run's start only — never guessed from the last-seen timestamps, which
   * would revive a device already declared dead.
   * @param {Record<string, {last_seen?: number}>} saved - Persisted map, keyed by IEEE address.
   * @param {object} [options] - Options.
   * @param {number|null} [options.heardAt] - Last moment the previous run heard the network.
   */
  restore(saved, { heardAt } = {}) {
    const now = this.now();
    if (
      !this.hearing &&
      Number.isFinite(heardAt) &&
      heardAt > 0 &&
      heardAt <= now &&
      heardAt < this.deafSince
    ) {
      this.deafSince = heardAt;
    }
    if (!saved || typeof saved !== 'object') {
      return;
    }
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
    const now = this.now();
    const pending = [...this.pendingByFriendlyName].filter(
      ([name, activity]) => !this.isPendingStale(name, activity, now),
    );
    for (const [key, activity] of [...pending, ...this.activityByIeee]) {
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
      const lastSign = activity.lastSeen ?? this.startedAt;
      const silenceMinutes = minutesSince(lastSign, now);
      // The verdict forgives the outages (see the header); the gauge does not.
      const verdictMinutes = minutesSince(
        this.verdictReference(lastSign, timeoutMinutes * MINUTE_MS),
        now,
      );
      const alive = verdictMinutes <= timeoutMinutes;

      devices.push({
        ...device,
        monitored: this.isMonitored(device),
        battery: isBatteryPowered(device),
        timeoutMinutes,
        lastSeen: activity.lastSeen,
        neverSeen: activity.lastSeen === null,
        silenceMinutes,
        alive,
        // Past its threshold, but given time to speak again after an outage.
        inGrace: alive && silenceMinutes > timeoutMinutes,
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
    if (!ieee && this.groupNames.has(nameOrIeee)) {
      return; // a group speaking, not a device
    }
    const target = ieee ? this.activityByIeee : this.pendingByFriendlyName;
    const key = ieee ?? nameOrIeee;
    const isNew = !target.has(key);
    const current = target.get(key) ?? emptyActivity();
    if (!ieee && isNew) {
      // Dated on arrival, never refreshed: the TTL bounds how long a name may
      // stay unresolved, however often it keeps publishing.
      current.bufferedAt = this.now();
    }

    if (update.lastSeen !== undefined) {
      // Keep the most recent proof of life: a retained report carrying an old
      // `last_seen` must never push the timestamp backwards.
      current.lastSeen = Math.max(current.lastSeen ?? 0, update.lastSeen);
    }
    if (update.availability !== undefined) {
      current.availability = update.availability;
    }
    target.set(key, current);
    if (!ieee && isNew && this.pendingByFriendlyName.size > MAX_PENDING) {
      this.prunePending();
    }
  }

  /**
   * Drop the buffered activity that will never be resolved: group names,
   * entries older than `PENDING_TTL_MS`, then the oldest past `MAX_PENDING`.
   *
   * Nothing expires before the first inventory: until then NOTHING can be
   * resolved — that is the Zigbee2MQTT outage case, where the whole restored
   * history waits in this buffer and must survive.
   */
  prunePending() {
    const now = this.now();
    for (const [name, activity] of this.pendingByFriendlyName) {
      if (this.isPendingStale(name, activity, now)) {
        this.pendingByFriendlyName.delete(name);
      }
    }
    const excess = this.pendingByFriendlyName.size - MAX_PENDING;
    if (excess > 0) {
      const oldest = [...this.pendingByFriendlyName]
        .sort(([, a], [, b]) => (a.bufferedAt ?? 0) - (b.bufferedAt ?? 0))
        .slice(0, excess);
      for (const [name] of oldest) {
        this.pendingByFriendlyName.delete(name);
      }
    }
  }

  /**
   * Is a buffered entry one that will never be resolved?
   * @param {string} name - Friendly name (or IEEE address) it is buffered under.
   * @param {{bufferedAt?: number}} activity - The buffered activity.
   * @param {number} now - Current time.
   * @returns {boolean} True when it should be dropped.
   */
  isPendingStale(name, activity, now) {
    if (this.groupNames.has(name)) {
      return true;
    }
    if (this.inventoryReceivedAt === null) {
      return false;
    }
    return now - (activity.bufferedAt ?? now) > PENDING_TTL_MS;
  }
}

/**
 * Whole minutes elapsed since a timestamp, never negative.
 * @param {number} since - Start, in milliseconds.
 * @param {number} now - Current time, in milliseconds.
 * @returns {number} Elapsed minutes, floored.
 */
function minutesSince(since, now) {
  return Math.max(0, Math.floor((now - since) / MINUTE_MS));
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
 * The power source as the scene editor and the widget settings name it: two
 * values only, because the thresholds only know two (see `timeoutMinutesFor`).
 * @param {object} device - Device descriptor.
 * @returns {'battery'|'mains'} The power source.
 */
export function powerSourceOf(device) {
  return isBatteryPowered(device) ? 'battery' : 'mains';
}

/**
 * Keep the devices matching a power source filter.
 * @param {Array<object>} devices - Devices of a monitor snapshot.
 * @param {unknown} powerSource - `battery`, `mains`, or anything else for "all".
 * @returns {Array<object>} The matching devices.
 */
export function filterByPowerSource(devices, powerSource) {
  if (powerSource !== 'battery' && powerSource !== 'mains') {
    return devices;
  }
  return devices.filter((device) => powerSourceOf(device) === powerSource);
}

/**
 * A blank activity record.
 * @returns {{lastSeen: null, availability: null}} Empty record.
 */
function emptyActivity() {
  return { lastSeen: null, availability: null };
}
