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
  NO_SILENT_DEVICES_TEXT,
  summaryExternalIds,
  SUMMARY_FEATURE,
  zigbeeExternalIds,
  ZIGBEE_FEATURE,
} from '../src/devices/index.js';
import { DevicesMonitor } from '../src/monitor.js';
import { StatePublisher } from '../src/statePublisher.js';
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
// The configuration the discovery payloads are built from (it carries the device
// naming). The tests that care about naming pass their own.
const config = normalizeConfig();

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

/**
 * Read the text of one feature out of a candidate state list.
 * @param {Array<object>} states - Candidate states.
 * @param {string} externalId - Feature external id.
 * @returns {unknown} The text, or undefined.
 */
function textOf(states, externalId) {
  return states.find((state) => state.device_feature_external_id === externalId)?.text;
}

test('the discovery list holds the summary device plus the watched devices', () => {
  const { monitor } = createMonitor();
  const devices = buildDiscoveredDevices(gladys, monitor.snapshot(), config);
  assert.equal(devices.length, 3, 'summary + 2 watched devices (the disabled one is left out)');
  assert.equal(devices[0].external_id, summaryExternalIds(gladys).device);
});

test('excluded devices never reach the "add a device" screen', () => {
  const { monitor } = createMonitor({ ignored_devices: 'kitchen/motion' });
  const ids = buildDiscoveredDevices(gladys, monitor.snapshot(), config).map((d) => d.external_id);
  assert.equal(ids.includes(zigbeeExternalIds(gladys, MOTION_IEEE).device), false);
  assert.equal(ids.includes(zigbeeExternalIds(gladys, DISABLED_IEEE).device), false);
  assert.equal(ids.includes(zigbeeExternalIds(gladys, PLUG_IEEE).device), true);
});

test('every published device carries a name, an external id and features', () => {
  const { monitor } = createMonitor();
  for (const device of buildDiscoveredDevices(gladys, monitor.snapshot(), config)) {
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

// `min` and `max` are optional in the SDK typings and left untouched when the
// discovery list is published — but they are NOT NULL in the Gladys schema, so a
// feature missing one is only rejected the day the user presses "Add" on the
// Discovery screen, with an HTTP 422 naming a column instead of a device.
test('every published feature carries the min/max Gladys requires', () => {
  const { monitor } = createMonitor();
  for (const device of buildDiscoveredDevices(gladys, monitor.snapshot(), config)) {
    for (const feature of device.features) {
      assert.equal(
        typeof feature.min,
        'number',
        `${device.name} / ${feature.name}: min is NOT NULL`,
      );
      assert.equal(
        typeof feature.max,
        'number',
        `${device.name} / ${feature.name}: max is NOT NULL`,
      );
      assert.ok(
        feature.max >= feature.min,
        `${device.name} / ${feature.name}: max must not be below min`,
      );
    }
  }
});

test('device and feature external ids are unique across the catalog', () => {
  const { monitor } = createMonitor();
  const devices = buildDiscoveredDevices(gladys, monitor.snapshot(), config);
  const deviceIds = devices.map((device) => device.external_id);
  assert.equal(new Set(deviceIds).size, deviceIds.length);
  const featureIds = devices.flatMap((device) => device.features.map((f) => f.external_id));
  assert.equal(new Set(featureIds).size, featureIds.length);
});

// Renaming a device in Zigbee2MQTT is one click; keying on the friendly name
// would orphan its history in Gladys every time.
test('devices are keyed on the IEEE address, not on the friendly name', () => {
  const { monitor } = createMonitor();
  const before = buildDiscoveredDevices(gladys, monitor.snapshot(), config);

  const renamed = BRIDGE_DEVICES_PAYLOAD.map((entry) =>
    entry.ieee_address === PLUG_IEEE ? { ...entry, friendly_name: 'hallway plug' } : entry,
  );
  monitor.setZ2mDevices(parseBridgeDevices(renamed));
  const after = buildDiscoveredDevices(gladys, monitor.snapshot(), config);

  assert.deepEqual(
    after.map((device) => device.external_id).sort(),
    before.map((device) => device.external_id).sort(),
  );
  const plug = after.find((d) => d.external_id === zigbeeExternalIds(gladys, PLUG_IEEE).device);
  assert.equal(plug.name, 'hallway plug (monitor)', 'the new name is picked up');
});

// Gladys usually already knows these devices under the very same name, through
// its own Zigbee2MQTT integration: published raw, they are indistinguishable
// from the real ones in every device and scene picker.
test('device names are suffixed so they never collide with the Zigbee2MQTT ones', () => {
  const { monitor } = createMonitor();
  const snapshot = monitor.snapshot();
  const ids = zigbeeExternalIds(gladys, PLUG_IEEE);

  const withDefault = buildDiscoveredDevices(gladys, snapshot, config);
  assert.equal(withDefault.find((d) => d.external_id === ids.device).name, 'office plug (monitor)');

  const custom = normalizeConfig({ device_name_suffix: '[watchdog]' });
  const withCustom = buildDiscoveredDevices(gladys, snapshot, custom);
  assert.equal(withCustom.find((d) => d.external_id === ids.device).name, 'office plug [watchdog]');

  // Emptying the field is how the user asks for the raw Zigbee2MQTT name back.
  const noSuffix = normalizeConfig({ device_name_suffix: '' });
  const withNone = buildDiscoveredDevices(gladys, snapshot, noSuffix);
  assert.equal(withNone.find((d) => d.external_id === ids.device).name, 'office plug');
});

test('the alive feature is a binary presence sensor kept in history', () => {
  const { monitor } = createMonitor();
  const devices = buildDiscoveredDevices(gladys, monitor.snapshot(), config);
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
  const plug = buildDiscoveredDevices(gladys, monitor.snapshot(), config).find(
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
  assert.equal(textOf(states, ids.feature(SUMMARY_FEATURE.SILENT_NAMES)), 'office plug');
});

// The host API validates the whole batch before saving any of it: one state
// carrying neither a numeric `state` nor a string `text` costs the entire
// network its update, and every feature reads "no recent value" in the UI.
test('every candidate state carries the shape the host API accepts', () => {
  const { monitor, clock } = createMonitor({ default_timeout_minutes: 60 });
  monitor.recordActivity('office plug', { linkQuality: 96 });
  monitor.setBridgeOnline(true);
  clock.advanceMinutes(75);

  for (const state of buildAllStates(gladys, monitor.snapshot())) {
    const hasState = typeof state.state === 'number' && Number.isFinite(state.state);
    const hasText = typeof state.text === 'string';
    assert.ok(
      hasState !== hasText,
      `${state.device_feature_external_id}: exactly one of "state" (number) or "text" (string)`,
    );
  }
});

// "Unknown" is not "offline": publishing a 0 before the bridge said anything
// would show the user a fake outage on every fresh install.
test('the bridge feature stays unpublished until the bridge speaks', () => {
  const { monitor } = createMonitor();
  const ids = summaryExternalIds(gladys);
  const states = buildAllStates(gladys, monitor.snapshot());
  assert.equal(stateOf(states, ids.feature(SUMMARY_FEATURE.BRIDGE_ONLINE)), undefined);
});

// Passing the host API validation is not the same as being STORED: Gladys routes
// a text state on the truthiness of its `text`, so an empty one is accepted and
// then dropped, and the feature reads "no value recorded" forever — which is
// precisely the state of a healthy network, where nothing is silent.
test('every candidate state is one Gladys actually stores', async () => {
  const { monitor, clock } = createMonitor({ default_timeout_minutes: 60 });
  const fake = createFakeGladys();
  monitor.recordActivity('office plug', { linkQuality: 96 });
  monitor.recordActivity('kitchen/motion');
  monitor.setBridgeOnline(true);
  clock.advanceMinutes(10);

  const states = buildAllStates(fake, monitor.snapshot());
  await fake.publishStates(states);

  for (const state of states) {
    assert.ok(
      fake.stored.has(state.device_feature_external_id),
      `${state.device_feature_external_id}: published but never stored by Gladys`,
    );
  }
});

// The scenario the user actually lives: the integration publishes its whole
// network long before anything exists in Gladys, the user then adds one device
// from the Discovery screen. Everything published so far was dropped, so the
// publisher has to forget that device to give it a value straight away.
test('a device created from the Discovery screen gets its states without waiting', async () => {
  const { monitor, clock } = createMonitor({ default_timeout_minutes: 60 });
  const fake = createFakeGladys();
  const publisher = new StatePublisher({ gladys: fake, now: clock.now });
  monitor.recordActivity('office plug', { linkQuality: 96 });

  // Tick 1: nothing exists in Gladys yet, every state is dropped on arrival.
  await publisher.publish(buildAllStates(fake, monitor.snapshot()));
  fake.batches.length = 0;

  // The user presses "Add" on the plug: only its states are published again.
  const plug = zigbeeExternalIds(fake, PLUG_IEEE);
  publisher.forgetDevice(plug.device);
  await publisher.publish(buildAllStates(fake, monitor.snapshot()));

  const republished = fake.batches.flat().map((s) => s.device_feature_external_id);
  assert.deepEqual(republished, [
    plug.feature(ZIGBEE_FEATURE.ALIVE),
    plug.feature(ZIGBEE_FEATURE.SILENCE),
    plug.feature(ZIGBEE_FEATURE.LINK_QUALITY),
  ]);
});

test('the silent names feature never publishes an empty text', () => {
  const { monitor } = createMonitor();
  const ids = summaryExternalIds(gladys);
  const states = buildAllStates(gladys, monitor.snapshot());
  assert.equal(textOf(states, ids.feature(SUMMARY_FEATURE.SILENT_NAMES)), NO_SILENT_DEVICES_TEXT);
  assert.ok(NO_SILENT_DEVICES_TEXT.length > 0);
});

test('formatSilentNames stays readable when half the network is down', () => {
  assert.equal(formatSilentNames([]), NO_SILENT_DEVICES_TEXT);
  assert.equal(formatSilentNames([{ friendlyName: 'a' }, { friendlyName: 'b' }]), 'a, b');
  const many = Array.from({ length: 14 }, (_, index) => ({ friendlyName: `sensor-${index}` }));
  const text = formatSilentNames(many);
  assert.match(text, /\(\+4\)$/);
  assert.ok(text.length <= 255);
});
