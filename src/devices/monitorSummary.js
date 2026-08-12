// -----------------------------------------------------------------------------
// The summary device: one Gladys device for the whole Zigbee network.
//
// Watching devices one by one is right for "which sensor died?", but it makes a
// poor alert: nobody builds a scene per sensor, and a new device paired next
// month would not be covered by any of them. So the integration also publishes a
// single device carrying network-wide counters — build ONE scene on
// "Silent devices > 0" and every device, including the ones paired later, is
// covered.
//
// The `Silent devices` text feature exists for that scene's notification: it
// holds the names of the devices currently silent, so the message can say WHICH
// sensor to go and check instead of just "something is wrong".
// -----------------------------------------------------------------------------

import { DEVICE_FEATURE_CATEGORIES, DEVICE_FEATURE_TYPES } from '@gladysassistant/integration-sdk';
import { DEFAULT_CONFIG } from '../config.js';

export const SUMMARY_DEVICE_TYPE = 'z2m-monitor';

// The monitor watches one Zigbee network, so this device is a singleton.
const SUMMARY_PLATFORM_ID = 'summary';

export const SUMMARY_FEATURE = {
  BRIDGE_ONLINE: 'bridge-online',
  DEVICES_MONITORED: 'devices-monitored',
  DEVICES_ALIVE: 'devices-alive',
  DEVICES_SILENT: 'devices-silent',
  SILENT_NAMES: 'silent-names',
};

// Gladys stores text states as strings; keep the list readable rather than
// exhaustive when half the network is down.
const MAX_NAMES_IN_TEXT = 10;
const MAX_TEXT_LENGTH = 255;

// What the text feature reads when nothing is silent. It is a full sentence,
// not a placeholder: this is the value the feature displays almost all the time,
// and a lone dash reads like a feature that never received anything.
//
// It CANNOT be the empty string either: the Gladys core dispatches a text state
// on `if (event.text)`, so an empty one falls through to the numeric branch,
// which has no number to save. The state is accepted, then lost, and the
// feature reads "no value recorded" forever — precisely in the situation it
// spends its life in. `normalizeConfig` guarantees a non-empty value.
export const NO_SILENT_DEVICES_TEXT = DEFAULT_CONFIG.no_silent_devices_text;

/**
 * External ids of the summary device.
 * @param {import('@gladysassistant/integration-sdk').GladysIntegration} gladys - The SDK instance.
 * @returns {{device: string, feature: (key: string) => string}} The device id and its feature id factory.
 */
export function summaryExternalIds(gladys) {
  return gladys.externalIds(SUMMARY_DEVICE_TYPE, SUMMARY_PLATFORM_ID);
}

/**
 * Build the discovery payload of the summary device.
 * @param {import('@gladysassistant/integration-sdk').GladysIntegration} gladys - The SDK instance.
 * @returns {object} The device payload sent to Gladys.
 */
export function buildSummaryDevice(gladys) {
  const ids = summaryExternalIds(gladys);
  return {
    name: 'Zigbee2MQTT monitor',
    external_id: ids.device,
    features: [
      {
        name: 'Silent devices',
        external_id: ids.feature(SUMMARY_FEATURE.DEVICES_SILENT),
        category: DEVICE_FEATURE_CATEGORIES.COUNTER_SENSOR,
        type: DEVICE_FEATURE_TYPES.SENSOR.INTEGER,
        min: 0,
        max: 1000,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      },
      {
        name: 'Silent device names',
        external_id: ids.feature(SUMMARY_FEATURE.SILENT_NAMES),
        category: DEVICE_FEATURE_CATEGORIES.TEXT,
        type: DEVICE_FEATURE_TYPES.TEXT.TEXT,
        // Meaningless for a text feature, but the Gladys schema declares both
        // columns NOT NULL — omitting them makes the device impossible to create
        // from the Discovery screen (HTTP 422).
        min: 0,
        max: 0,
        read_only: true,
        has_feedback: false,
        keep_history: false,
      },
      {
        name: 'Devices alive',
        external_id: ids.feature(SUMMARY_FEATURE.DEVICES_ALIVE),
        category: DEVICE_FEATURE_CATEGORIES.COUNTER_SENSOR,
        type: DEVICE_FEATURE_TYPES.SENSOR.INTEGER,
        min: 0,
        max: 1000,
        read_only: true,
        has_feedback: false,
        keep_history: false,
      },
      {
        name: 'Devices monitored',
        external_id: ids.feature(SUMMARY_FEATURE.DEVICES_MONITORED),
        category: DEVICE_FEATURE_CATEGORIES.COUNTER_SENSOR,
        type: DEVICE_FEATURE_TYPES.SENSOR.INTEGER,
        min: 0,
        max: 1000,
        read_only: true,
        has_feedback: false,
        keep_history: false,
      },
      {
        name: 'Zigbee2MQTT bridge online',
        external_id: ids.feature(SUMMARY_FEATURE.BRIDGE_ONLINE),
        category: DEVICE_FEATURE_CATEGORIES.INPUT,
        type: DEVICE_FEATURE_TYPES.INPUT.BINARY,
        min: 0,
        max: 1,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      },
    ],
  };
}

/**
 * Build the states of the summary device.
 * @param {import('@gladysassistant/integration-sdk').GladysIntegration} gladys - The SDK instance.
 * @param {object} summary - `summary` block of a monitor snapshot.
 * @param {Record<string, unknown>} [config] - Normalized configuration (it carries the "nothing is silent" text).
 * @returns {Array<{device_feature_external_id: string, state: unknown}>} Candidate states.
 */
export function buildSummaryStates(gladys, summary, config = {}) {
  const ids = summaryExternalIds(gladys);
  const states = [
    {
      device_feature_external_id: ids.feature(SUMMARY_FEATURE.DEVICES_SILENT),
      state: summary.silent,
    },
    {
      device_feature_external_id: ids.feature(SUMMARY_FEATURE.DEVICES_ALIVE),
      state: summary.alive,
    },
    {
      device_feature_external_id: ids.feature(SUMMARY_FEATURE.DEVICES_MONITORED),
      state: summary.monitored,
    },
    {
      // A text feature travels in a `text` field of its own: the host API takes
      // a numeric `state` OR a string `text`, and rejects the whole batch when
      // one state carries neither.
      device_feature_external_id: ids.feature(SUMMARY_FEATURE.SILENT_NAMES),
      text: formatSilentNames(summary.silentDevices, config.no_silent_devices_text),
    },
  ];

  // Stays unpublished until the bridge actually said something: "unknown" is not
  // "offline", and Gladys renders a feature with no value as such.
  if (summary.bridgeOnline !== null) {
    states.push({
      device_feature_external_id: ids.feature(SUMMARY_FEATURE.BRIDGE_ONLINE),
      state: summary.bridgeOnline ? 1 : 0,
    });
  }

  return states;
}

/**
 * Format the silent device names for the text feature, so a scene notification
 * can name them.
 * @param {Array<object>} silentDevices - Silent devices of a monitor snapshot.
 * @param {string} [noSilentDevicesText] - What to read when nothing is silent.
 * @returns {string} A comma-separated list, truncated to stay readable, never empty.
 */
export function formatSilentNames(silentDevices = [], noSilentDevicesText) {
  if (silentDevices.length === 0) {
    return String(noSilentDevicesText ?? '').trim() || NO_SILENT_DEVICES_TEXT;
  }
  const names = silentDevices.slice(0, MAX_NAMES_IN_TEXT).map((device) => device.friendlyName);
  const remaining = silentDevices.length - names.length;
  const text = remaining > 0 ? `${names.join(', ')} (+${remaining})` : names.join(', ');
  return text.length > MAX_TEXT_LENGTH ? `${text.slice(0, MAX_TEXT_LENGTH - 1)}…` : text;
}
