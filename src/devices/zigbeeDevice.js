// -----------------------------------------------------------------------------
// One Gladys device per Zigbee2MQTT device.
//
// The devices are NOT hard-coded here: they are built from the inventory
// Zigbee2MQTT publishes on `<base_topic>/bridge/devices`, so pairing a new
// sensor makes it appear in Gladys without touching this file.
//
// Each one carries the two things you want when a sensor goes quiet:
//   - "Alive"     the verdict, and the feature to build a scene on;
//   - "Silence"   how long it has been quiet, to size the thresholds.
//
// The link quality (LQI) is deliberately NOT published: Gladys already exposes
// it through its own Zigbee2MQTT integration, and a second copy of the same
// number only makes the device and scene pickers harder to read.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';

// `Alive` is a read-only on/off flag, so `presence-sensor` + `binary` reads like
// the obvious pair — and it is the one pair the released Gladys front cannot
// draw. Up to and including 4.85.0 it knows `presence-sensor` only as `push`:
// no icon in `DeviceFeatureCategoriesIcon`, no
// `deviceFeatureCategory.presence-sensor.binary` label, so the Discovery screen
// shows an empty grey tag and the feature is invisible — the device looks like
// it only carries `Silence`. The same category also short-circuits the scene
// editor into the "device seen" widget instead of an on/off trigger, which is
// exactly the trigger this feature exists for. Gladys fixed both on master
// (commit 394cbee, "Fix the empty tag shown for a binary presence sensor"),
// which is why a development instance renders it correctly and a production one
// does not.
//
// `input` + `binary` is drawn by every version in the manifest's range: an
// "Input state" tag reading On/Off, and a plain binary trigger in scenes. It is
// already what the summary device uses for `Zigbee2MQTT bridge online`, which is
// the same kind of signal. Revisit once the manifest can require the Gladys
// release carrying the fix.
const ALIVE_CATEGORY = DEVICE_FEATURE_CATEGORIES.INPUT;
const ALIVE_TYPE = DEVICE_FEATURE_TYPES.INPUT.BINARY;

export const ZIGBEE_DEVICE_TYPE = 'z2m-device';

export const ZIGBEE_FEATURE = {
  ALIVE: 'alive',
  SILENCE: 'silence',
};

// A silence longer than a year says nothing more than "a very long time", and
// the feature has to declare a bounded range.
const MAX_SILENCE_MINUTES = 525_600;

// "Silence" grows by one every minute: a gauge, refreshed at most this often so
// a large network does not spend its whole rate-limit budget on it (see
// `StatePublisher`).
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
 * Name to show in Gladys for one watched device.
 *
 * The raw friendly name is almost always already taken: Gladys usually knows the
 * same devices through its own Zigbee2MQTT integration, and two entries reading
 * "office plug" in a scene picker are indistinguishable. The suffix is what
 * tells the watchdog copy apart — the user can change it, or empty it to keep
 * the raw name.
 * @param {object} device - Device entry of a monitor snapshot.
 * @param {Record<string, unknown>} config - Normalized configuration.
 * @returns {string} The device name published to Gladys.
 */
export function zigbeeDeviceName(device, config = {}) {
  const suffix = String(config.device_name_suffix ?? '').trim();
  return suffix ? `${device.friendlyName} ${suffix}` : device.friendlyName;
}

/**
 * Build the discovery payload of one watched Zigbee device.
 * @param {import('@gladysassistant/integration-sdk').GladysIntegration} gladys - The SDK instance.
 * @param {object} device - Device entry of a monitor snapshot.
 * @param {Record<string, unknown>} config - Normalized configuration.
 * @returns {object} The device payload sent to Gladys.
 */
export function buildZigbeeDevice(gladys, device, config) {
  const ids = zigbeeExternalIds(gladys, device.ieeeAddress);
  return {
    name: zigbeeDeviceName(device, config),
    external_id: ids.device,
    model: device.model || undefined,
    features: [
      {
        name: 'Alive',
        external_id: ids.feature(ZIGBEE_FEATURE.ALIVE),
        category: ALIVE_CATEGORY,
        type: ALIVE_TYPE,
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
    ],
  };
}

/**
 * Build the states of one watched Zigbee device.
 *
 * `Alive` carries no `minIntervalMs`: it is the alert, so every flip goes out on
 * the tick that sees it. The silence gauge is throttled, except the moment a
 * device breaks its silence — a counter falling back to zero is the good news
 * worth publishing straight away.
 * @param {import('@gladysassistant/integration-sdk').GladysIntegration} gladys - The SDK instance.
 * @param {object} device - Device entry of a monitor snapshot.
 * @returns {Array<{device_feature_external_id: string, state: number, minIntervalMs?: number}>} Candidate states.
 */
export function buildZigbeeDeviceStates(gladys, device) {
  const ids = zigbeeExternalIds(gladys, device.ieeeAddress);
  return [
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
}
