import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';
import { normalizeConfig } from '../src/config.js';
import {
  buildAllStates,
  buildDiscoveredDevices,
  formatSilentNames,
  summaryExternalIds,
  SUMMARY_FEATURE,
  zigbeeExternalIds,
  ZIGBEE_FEATURE,
} from '../src/devices/index.js';
import { DevicesMonitor } from '../src/monitor.js';
import { parseBridgeDevices } from '../src/z2m/payloads.js';
import { createFakeGladys } from './helpers/fakeGladys.js';
import {
  BRIDGE_DEVICES_PAYLOAD,
  createClock,
  DISABLED_IEEE,
  MOTION_IEEE,
  PLUG_IEEE,
} from './helpers/z2mFixtures.js';

const gladys = createFakeGladys();

/**
 * Build a monitor fed with the fixture network.
 * @param {Record<string, unknown>} [overrides] - Configuration overrides.
 * @returns {{monitor: DevicesMonitor, clock: object}} The monitor and its clock.
 */
function createMonitor(overrides = {}) {
  const clock = createClock();
  const monitor = new DevicesMonitor({ config: normalizeConfig(overrides), now: clock.now });
  monitor.setZ2mDevices(parseBridgeDevices(BRIDGE_DEVICES_PAYLOAD));
  return { monitor, clock };
}

/**
 * Read the state of one feature out of a candidate state list.
 * @param {Array<object>} states - Candidate states.
 * @param {string} externalId - Feature external id.
 * @returns {unknown} The state, or undefined.
 */
function stateOf(states, externalId) {
  return states.find((state) => state.device_feature_external_id === externalId)?.state;
}

test('the discovery list holds the summary device plus the watched devices', () => {
  const { monitor } = createMonitor();
  const devices = buildDiscoveredDevices(gladys, monitor.snapshot());
  assert.equal(devices.length, 3, 'summary + 2 watched devices (the disabled one is left out)');
  assert.equal(devices[0].external_id, summaryExternalIds(gladys).device);
});

test('excluded devices never reach the "add a device" screen', () => {
  const { monitor } = createMonitor({ ignored_devices: 'kitchen/motion' });
  const ids = buildDiscoveredDevices(gladys, monitor.snapshot()).map((d) => d.external_id);
  assert.equal(ids.includes(zigbeeExternalIds(gladys, MOTION_IEEE).device), false);
  assert.equal(ids.includes(zigbeeExternalIds(gladys, DISABLED_IEEE).device), false);
  assert.equal(ids.includes(zigbeeExternalIds(gladys, PLUG_IEEE).device), true);
});

test('every published device carries a name, an external id and features', () => {
  const { monitor } = createMonitor();
  for (const device of buildDiscoveredDevices(gladys, monitor.snapshot())) {
    assert.equal(typeof device.name, 'string');
    assert.ok(device.name.length > 0);
    assert.ok(device.external_id);
    assert.ok(Array.isArray(device.features) && device.features.length > 0);
    for (const feature of device.features) {
      assert.ok(feature.external_id, `${device.name}: every feature needs an external id`);
      assert.ok(feature.category, `${device.name}: every feature needs a category`);
      assert.ok(feature.type, `${device.name}: every feature needs a type`);
    }
  }
});

test('device and feature external ids are unique across the catalog', () => {
  const { monitor } = createMonitor();
  const devices = buildDiscoveredDevices(gladys, monitor.snapshot());
  const deviceIds = devices.map((device) => device.external_id);
  assert.equal(new Set(deviceIds).size, deviceIds.length);
  const featureIds = devices.flatMap((device) => device.features.map((f) => f.external_id));
  assert.equal(new Set(featureIds).size, featureIds.length);
});

// Renaming a device in Zigbee2MQTT is one click; keying on the friendly name
// would orphan its history in Gladys every time.
test('devices are keyed on the IEEE address, not on the friendly name', () => {
  const { monitor } = createMonitor();
  const before = buildDiscoveredDevices(gladys, monitor.snapshot());

  const renamed = BRIDGE_DEVICES_PAYLOAD.map((entry) =>
    entry.ieee_address === PLUG_IEEE ? { ...entry, friendly_name: 'hallway plug' } : entry,
  );
  monitor.setZ2mDevices(parseBridgeDevices(renamed));
  const after = buildDiscoveredDevices(gladys, monitor.snapshot());

  assert.deepEqual(
    after.map((device) => device.external_id).sort(),
    before.map((device) => device.external_id).sort(),
  );
  const plug = after.find((d) => d.external_id === zigbeeExternalIds(gladys, PLUG_IEEE).device);
  assert.equal(plug.name, 'hallway plug', 'the new name is picked up');
});

test('the alive feature is a binary presence sensor kept in history', () => {
  const { monitor } = createMonitor();
  const devices = buildDiscoveredDevices(gladys, monitor.snapshot());
  const plug = devices.find((d) => d.external_id === zigbeeExternalIds(gladys, PLUG_IEEE).device);
  const alive = plug.features.find(
    (f) => f.external_id === zigbeeExternalIds(gladys, PLUG_IEEE).feature(ZIGBEE_FEATURE.ALIVE),
  );
  assert.equal(alive.category, DEVICE_FEATURE_CATEGORIES.PRESENCE_SENSOR);
  assert.equal(alive.type, DEVICE_FEATURE_TYPES.SENSOR.BINARY);
  assert.equal(alive.read_only, true);
  assert.equal(alive.keep_history, true, 'the alert history of the device');
});

test('the silence feature is a duration in minutes', () => {
  const { monitor } = createMonitor();
  const ids = zigbeeExternalIds(gladys, PLUG_IEEE);
  const plug = buildDiscoveredDevices(gladys, monitor.snapshot()).find(
    (d) => d.external_id === ids.device,
  );
  const silence = plug.features.find((f) => f.external_id === ids.feature(ZIGBEE_FEATURE.SILENCE));
  assert.equal(silence.category, DEVICE_FEATURE_CATEGORIES.DURATION);
  assert.equal(silence.unit, DEVICE_FEATURE_UNITS.MINUTES);
  assert.equal(silence.min, 0);
});

test('the states report the verdict, the silence and the signal', () => {
  const { monitor, clock } = createMonitor({ default_timeout_minutes: 60 });
  monitor.recordActivity('office plug', { linkQuality: 96 });
  clock.advanceMinutes(75);

  const ids = zigbeeExternalIds(gladys, PLUG_IEEE);
  const states = buildAllStates(gladys, monitor.snapshot());
  assert.equal(stateOf(states, ids.feature(ZIGBEE_FEATURE.ALIVE)), 0);
  assert.equal(stateOf(states, ids.feature(ZIGBEE_FEATURE.SILENCE)), 75);
  assert.equal(stateOf(states, ids.feature(ZIGBEE_FEATURE.LINK_QUALITY)), 96);
});

test('the link quality is left unpublished until one is known', () => {
  const { monitor } = createMonitor();
  const ids = zigbeeExternalIds(gladys, PLUG_IEEE);
  const states = buildAllStates(gladys, monitor.snapshot());
  assert.equal(stateOf(states, ids.feature(ZIGBEE_FEATURE.LINK_QUALITY)), undefined);
});

test('the alive state is never throttled, the gauges are', () => {
  const { monitor } = createMonitor();
  monitor.recordActivity('office plug', { linkQuality: 96 });
  const ids = zigbeeExternalIds(gladys, PLUG_IEEE);
  const states = buildAllStates(gladys, monitor.snapshot());
  const find = (key) =>
    states.find((state) => state.device_feature_external_id === ids.feature(key));

  assert.equal(find(ZIGBEE_FEATURE.ALIVE).minIntervalMs, undefined, 'an alert goes out at once');
  assert.ok(find(ZIGBEE_FEATURE.LINK_QUALITY).minIntervalMs > 0);
  assert.equal(
    find(ZIGBEE_FEATURE.SILENCE).minIntervalMs,
    0,
    'a counter falling back to zero is good news worth publishing at once',
  );
});

test('no state is published for an excluded device', () => {
  const { monitor } = createMonitor({ ignored_devices: 'kitchen/motion' });
  const states = buildAllStates(gladys, monitor.snapshot());
  const ignoredIds = zigbeeExternalIds(gladys, MOTION_IEEE);
  assert.equal(stateOf(states, ignoredIds.feature(ZIGBEE_FEATURE.ALIVE)), undefined);
});

test('the summary counts the network and names the silent devices', () => {
  const { monitor, clock } = createMonitor({
    default_timeout_minutes: 60,
    battery_timeout_minutes: 1440,
  });
  monitor.recordActivity('office plug');
  monitor.recordActivity('kitchen/motion');
  monitor.setBridgeOnline(true);
  clock.advanceMinutes(61);

  const ids = summaryExternalIds(gladys);
  const states = buildAllStates(gladys, monitor.snapshot());
  assert.equal(stateOf(states, ids.feature(SUMMARY_FEATURE.DEVICES_MONITORED)), 2);
  assert.equal(stateOf(states, ids.feature(SUMMARY_FEATURE.DEVICES_SILENT)), 1);
  assert.equal(stateOf(states, ids.feature(SUMMARY_FEATURE.DEVICES_ALIVE)), 1);
  assert.equal(stateOf(states, ids.feature(SUMMARY_FEATURE.BRIDGE_ONLINE)), 1);
  assert.deepEqual(stateOf(states, ids.feature(SUMMARY_FEATURE.SILENT_NAMES)), {
    text: 'office plug',
  });
});

// "Unknown" is not "offline": publishing a 0 before the bridge said anything
// would show the user a fake outage on every fresh install.
test('the bridge feature stays unpublished until the bridge speaks', () => {
  const { monitor } = createMonitor();
  const ids = summaryExternalIds(gladys);
  const states = buildAllStates(gladys, monitor.snapshot());
  assert.equal(stateOf(states, ids.feature(SUMMARY_FEATURE.BRIDGE_ONLINE)), undefined);
});

test('formatSilentNames stays readable when half the network is down', () => {
  assert.equal(formatSilentNames([]), '');
  assert.equal(formatSilentNames([{ friendlyName: 'a' }, { friendlyName: 'b' }]), 'a, b');
  const many = Array.from({ length: 14 }, (_, index) => ({ friendlyName: `sensor-${index}` }));
  const text = formatSilentNames(many);
  assert.match(text, /\(\+4\)$/);
  assert.ok(text.length <= 255);
});
