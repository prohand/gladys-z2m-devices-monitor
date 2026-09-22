// -----------------------------------------------------------------------------
// Scene triggers and scene actions (manifest `scene_triggers` / `scene_actions`,
// Gladys >= 5.1.0).
//
// Before them, the alert scene took four steps and a trap: trigger on the
// summary counter, then a "Get device value" block the user had to know about,
// or the message could not name the sensor. A trigger carries its own data, so
// "{{triggerEvent.data.device_name}} went silent" works out of the box — and it
// fires once per device, which the counter never could (see `transitions.js`).
//
// The actions answer the other shape of scene: "every morning, tell me who is
// silent", or "before leaving, check the smoke detector still answers".
//
// Keys, field keys and variable keys are stored by the user's scenes: they are
// NEVER renamed once published — a renamed key is a removed one.
// -----------------------------------------------------------------------------

import { formatSilentNames } from './devices/monitorSummary.js';
import { zigbeeExternalIds } from './devices/zigbeeDevice.js';
import { filterByPowerSource, powerSourceOf } from './monitor.js';

export const SCENE_TRIGGER = {
  DEVICE_SILENT: 'device_silent',
  DEVICE_BACK: 'device_back',
};

export const SCENE_ACTION = {
  GET_SILENT_DEVICES: 'get_silent_devices',
  GET_DEVICE_STATUS: 'get_device_status',
};

/**
 * Turn the flips of `AliveTransitions.diff()` into scene events.
 *
 * The data is flat and carries both the filter keys the scene author fills in
 * (`device`, `power_source`) and the variables the actions read — the core
 * keeps the declared keys and drops the rest.
 * @param {import('@gladysassistant/integration-sdk').GladysIntegration} gladys - The SDK instance.
 * @param {Array<{type: 'silent'|'back', device: object}>} flips - Transitions to announce.
 * @returns {Array<{key: string, data: Record<string, string|number>}>} The events to publish.
 */
export function buildSceneEvents(gladys, flips) {
  return flips.map(({ type, device }) => {
    const data = {
      // The value a `source: "devices"` select stores: the Gladys device id.
      device: zigbeeExternalIds(gladys, device.ieeeAddress).device,
      power_source: powerSourceOf(device),
      device_name: device.friendlyName,
      ieee_address: device.ieeeAddress,
      threshold_minutes: device.timeoutMinutes,
    };
    if (type === 'back') {
      return { key: SCENE_TRIGGER.DEVICE_BACK, data };
    }
    // Only meaningful on the way down: a device that just spoke again has a
    // silence of zero, not the length of the gap it is coming back from.
    return {
      key: SCENE_TRIGGER.DEVICE_SILENT,
      data: { ...data, silence_minutes: device.silenceMinutes },
    };
  });
}

/**
 * `get_silent_devices` scene action: who is silent right now.
 * @param {object} context - Runtime context.
 * @param {import('./monitor.js').DevicesMonitor} context.monitor - The monitor.
 * @param {Record<string, unknown>} context.config - Normalized configuration.
 * @param {Record<string, unknown>} fields - Resolved action fields.
 * @returns {{count: number, names: string, monitored: number}} The declared outputs.
 */
export function getSilentDevices({ monitor, config }, fields = {}) {
  const snapshot = monitor.snapshot();
  // Before the inventory, "0 silent device" would be a lie the scene acts on.
  if (!snapshot.summary.inventoryReceived) {
    throw new Error('The Zigbee2MQTT device inventory has not been received yet');
  }
  const watched = filterByPowerSource(
    snapshot.devices.filter((device) => device.monitored),
    fields.power_source,
  );
  const silent = watched.filter((device) => !device.alive);
  return {
    count: silent.length,
    // Never empty, like the text feature: a message quoting it reads a
    // sentence instead of a blank.
    names: formatSilentNames(silent, config.no_silent_devices_text),
    monitored: watched.length,
  };
}

/**
 * `get_device_status` scene action: the verdict of one device, for a scene
 * that wants to check a critical sensor at a given moment.
 * @param {object} context - Runtime context.
 * @param {import('@gladysassistant/integration-sdk').GladysIntegration} context.gladys - The SDK instance.
 * @param {import('./monitor.js').DevicesMonitor} context.monitor - The monitor.
 * @param {Record<string, unknown>} fields - Resolved action fields (`device` is a Gladys device external id).
 * @returns {{alive: boolean, device_name: string, silence_minutes: number, threshold_minutes: number}} The declared outputs.
 */
export function getDeviceStatus({ gladys, monitor }, fields = {}) {
  const device = monitor
    .snapshot()
    .devices.find(
      (candidate) =>
        candidate.monitored &&
        zigbeeExternalIds(gladys, candidate.ieeeAddress).device === fields.device,
    );
  // Throwing fails this action only; the scene logs why and carries on. Not
  // an output: "not watched" answered as `alive: false` would page someone.
  if (!device) {
    throw new Error(`${fields.device} is not a watched Zigbee2MQTT device`);
  }
  return {
    alive: device.alive,
    device_name: device.friendlyName,
    silence_minutes: device.silenceMinutes,
    threshold_minutes: device.timeoutMinutes,
  };
}
