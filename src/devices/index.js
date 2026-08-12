// -----------------------------------------------------------------------------
// Device registry.
//
// Unlike a template with a fixed catalog, the devices of this integration are
// discovered: they come from the inventory Zigbee2MQTT publishes on
// `<base_topic>/bridge/devices`. This module turns a monitor snapshot into the
// two payloads Gladys expects — the discovery list and the states — and nothing
// else: no I/O, no decision, so it stays trivially testable.
// -----------------------------------------------------------------------------

import { buildSummaryDevice, buildSummaryStates } from './monitorSummary.js';
import { buildZigbeeDevice, buildZigbeeDeviceStates } from './zigbeeDevice.js';

export {
  buildSummaryDevice,
  buildSummaryStates,
  summaryExternalIds,
  SUMMARY_FEATURE,
  formatSilentNames,
} from './monitorSummary.js';
export {
  buildZigbeeDevice,
  buildZigbeeDeviceStates,
  zigbeeDeviceName,
  zigbeeExternalIds,
  ZIGBEE_FEATURE,
} from './zigbeeDevice.js';

/**
 * Build the complete discovery payload: the summary device, then one device per
 * watched Zigbee device.
 *
 * Devices the user excluded (ignore list, or disabled in Zigbee2MQTT) are left
 * out entirely rather than published as permanently silent: an excluded device
 * should not show up in the "add a device" screen at all.
 * @param {import('@gladysassistant/integration-sdk').GladysIntegration} gladys - The SDK instance.
 * @param {object} snapshot - A `DevicesMonitor.snapshot()` result.
 * @param {Record<string, unknown>} config - Normalized configuration (it carries the device naming).
 * @returns {Array<object>} The devices to publish to Gladys.
 */
export function buildDiscoveredDevices(gladys, snapshot, config) {
  return [
    buildSummaryDevice(gladys),
    ...snapshot.devices
      .filter((device) => device.monitored)
      .map((device) => buildZigbeeDevice(gladys, device, config)),
  ];
}

/**
 * Build every candidate state of a snapshot, ready for the `StatePublisher`.
 * @param {import('@gladysassistant/integration-sdk').GladysIntegration} gladys - The SDK instance.
 * @param {object} snapshot - A `DevicesMonitor.snapshot()` result.
 * @returns {Array<{device_feature_external_id: string, state: unknown, minIntervalMs?: number}>} Candidate states.
 */
export function buildAllStates(gladys, snapshot) {
  return [
    ...buildSummaryStates(gladys, snapshot.summary),
    ...snapshot.devices
      .filter((device) => device.monitored)
      .flatMap((device) => buildZigbeeDeviceStates(gladys, device)),
  ];
}
