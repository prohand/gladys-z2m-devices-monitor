// -----------------------------------------------------------------------------
// One Gladys device per Zigbee2MQTT device.
//
// The devices are NOT hard-coded here: they are built from the inventory
// Zigbee2MQTT publishes on `<base_topic>/bridge/devices`, so pairing a new
// sensor makes it appear in Gladys without touching this file.
//
// Each one carries the three things you want when a sensor goes quiet:
//   - "Alive"          the verdict, and the feature to build a scene on;
//   - "Silence"        how long it has been quiet, to size the thresholds;
//   - "Link quality"   the LQI of its last message — a device whose LQI has been
//                      collapsing for a week is usually the next one to die.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';

export const ZIGBEE_DEVICE_TYPE = 'z2m-device';

export const ZIGBEE_FEATURE = {
  ALIVE: 'alive',
  SILENCE: 'silence',
  LINK_QUALITY: 'link-quality',
};

// A silence longer than a year says nothing more than "a very long time", and
// the feature has to declare a bounded range.
const MAX_SILENCE_MINUTES = 525_600;

// "Silence" grows by one every minute and the link quality wobbles on every
// report: both are gauges, refreshed at most this often so a large network does
// not spend its whole rate-limit budget on them (see `StatePublisher`).
const GAUGE_MIN_INTERVAL_MS = 5 * 60 * 1000;

/**
 * External ids of one watched Zigbee device.
 *
 * Keyed by the IEEE address, never by the friendly name: the address is burned
 * into the chip and survives every rename, while renaming a device in
 * Zigbee2MQTT is a one-click operation that would otherwise orphan its history
 * in Gladys.
 * @param {import('@gladysassistant/integration-sdk').GladysIntegration} gladys - The SDK instance.
 * @param {string} ieeeAddress - Zigbee IEEE address of the device.
 * @returns {{device: string, feature: (key: string) => string}} The device id and its feature id factory.
 */
export function zigbeeExternalIds(gladys, ieeeAddress) {
  return gladys.externalIds(ZIGBEE_DEVICE_TYPE, ieeeAddress);
}

/**
 * Build the discovery payload of one watched Zigbee device.
 * @param {import('@gladysassistant/integration-sdk').GladysIntegration} gladys - The SDK instance.
 * @param {object} device - Device entry of a monitor snapshot.
 * @returns {object} The device payload sent to Gladys.
 */
export function buildZigbeeDevice(gladys, device) {
  const ids = zigbeeExternalIds(gladys, device.ieeeAddress);
  return {
    name: device.friendlyName,
    external_id: ids.device,
    model: device.model || undefined,
    features: [
      {
        name: 'Alive',
        external_id: ids.feature(ZIGBEE_FEATURE.ALIVE),
        category: DEVICE_FEATURE_CATEGORIES.PRESENCE_SENSOR,
        type: DEVICE_FEATURE_TYPES.SENSOR.BINARY,
        // `min`/`max` are optional in the SDK typings but NOT NULL in the Gladys
        // schema: a feature published without them makes the device impossible
        // to create from the Discovery screen (HTTP 422). Binary is 0..1.
        min: 0,
        max: 1,
        read_only: true,
        has_feedback: false,
        // The one series worth keeping: it is the alert history of the device.
        keep_history: true,
      },
      {
        name: 'Silence',
        external_id: ids.feature(ZIGBEE_FEATURE.SILENCE),
        category: DEVICE_FEATURE_CATEGORIES.DURATION,
        type: DEVICE_FEATURE_TYPES.DURATION.INTEGER,
        unit: DEVICE_FEATURE_UNITS.MINUTES,
        min: 0,
        max: MAX_SILENCE_MINUTES,
        read_only: true,
        has_feedback: false,
        // A sawtooth that resets on every report: useful live, noisy as history.
        // The user can switch it on from the device screen if they want it.
        keep_history: false,
      },
      {
        name: 'Link quality',
        external_id: ids.feature(ZIGBEE_FEATURE.LINK_QUALITY),
        category: DEVICE_FEATURE_CATEGORIES.SIGNAL,
        type: DEVICE_FEATURE_TYPES.SIGNAL.QUALITY,
        min: 0,
        max: 255,
        read_only: true,
        has_feedback: false,
        keep_history: false,
      },
    ],
  };
}

/**
 * Build the states of one watched Zigbee device.
 *
 * `Alive` carries no `minIntervalMs`: it is the alert, so every flip goes out on
 * the tick that sees it. The two gauges are throttled, except the moment a
 * device breaks its silence — a counter falling back to zero is the good news
 * worth publishing straight away.
 * @param {import('@gladysassistant/integration-sdk').GladysIntegration} gladys - The SDK instance.
 * @param {object} device - Device entry of a monitor snapshot.
 * @returns {Array<{device_feature_external_id: string, state: number, minIntervalMs?: number}>} Candidate states.
 */
export function buildZigbeeDeviceStates(gladys, device) {
  const ids = zigbeeExternalIds(gladys, device.ieeeAddress);
  const states = [
    {
      device_feature_external_id: ids.feature(ZIGBEE_FEATURE.ALIVE),
      state: device.alive ? 1 : 0,
    },
    {
      device_feature_external_id: ids.feature(ZIGBEE_FEATURE.SILENCE),
      state: Math.min(device.silenceMinutes, MAX_SILENCE_MINUTES),
      minIntervalMs: device.silenceMinutes === 0 ? 0 : GAUGE_MIN_INTERVAL_MS,
    },
  ];

  if (device.linkQuality !== null && device.linkQuality !== undefined) {
    states.push({
      device_feature_external_id: ids.feature(ZIGBEE_FEATURE.LINK_QUALITY),
      state: device.linkQuality,
      minIntervalMs: GAUGE_MIN_INTERVAL_MS,
    });
  }

  return states;
}
