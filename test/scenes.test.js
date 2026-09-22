import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../src/config.js';
import { zigbeeExternalIds } from '../src/devices/index.js';
import { DevicesMonitor } from '../src/monitor.js';
import {
  SCENE_TRIGGER,
  buildSceneEvents,
  getDeviceStatus,
  getSilentDevices,
} from '../src/scenes.js';
import { parseBridgeDevices } from '../src/z2m/payloads.js';
import { createFakeGladys } from './helpers/fakeGladys.js';
import { BRIDGE_DEVICES_PAYLOAD, PLUG_IEEE, createClock } from './helpers/z2mFixtures.js';

const gladys = createFakeGladys();

/**
 * A monitor fed with the fixture network where the plug has been silent for 3 hours.
 * @param {Record<string, unknown>} [overrides] - Configuration overrides.
 * @returns {{monitor: DevicesMonitor, config: object}} The context pieces.
 */
function createContext(overrides = {}) {
  const clock = createClock();
  const config = normalizeConfig(overrides);
  const monitor = new DevicesMonitor({ config, now: clock.now });
  monitor.setZ2mDevices(parseBridgeDevices(BRIDGE_DEVICES_PAYLOAD));
  monitor.recordActivity('office plug');
  clock.advanceMinutes(180);
  monitor.recordActivity('kitchen/motion');
  return { monitor, config };
}

/**
 * The snapshot entry of one device.
 * @param {DevicesMonitor} monitor - The monitor.
 * @param {string} name - Friendly name.
 * @returns {object} The device entry.
 */
function deviceNamed(monitor, name) {
  return monitor.snapshot().devices.find((device) => device.friendlyName === name);
}

test('a silent device fires device_silent with what the notification needs', () => {
  const { monitor } = createContext();
  const [event] = buildSceneEvents(gladys, [
    { type: 'silent', device: deviceNamed(monitor, 'office plug') },
  ]);
  assert.deepEqual(event, {
    key: SCENE_TRIGGER.DEVICE_SILENT,
    data: {
      // What a `source: "devices"` filter stores, so the equality matches.
      device: zigbeeExternalIds(gladys, PLUG_IEEE).device,
      power_source: 'mains',
      device_name: 'office plug',
      ieee_address: PLUG_IEEE,
      threshold_minutes: 120,
      silence_minutes: 180,
    },
  });
});

// A device that just spoke has a silence of 0: publishing it as "how long it
// was gone" would be a lie in every notification.
test('device_back does not pretend to know how long the device was gone', () => {
  const { monitor } = createContext();
  const [event] = buildSceneEvents(gladys, [
    { type: 'back', device: deviceNamed(monitor, 'kitchen/motion') },
  ]);
  assert.equal(event.key, SCENE_TRIGGER.DEVICE_BACK);
  assert.equal(event.data.power_source, 'battery');
  assert.equal('silence_minutes' in event.data, false);
});

test('scene event data stays flat and scalar, as the host API requires', () => {
  const { monitor } = createContext();
  const events = buildSceneEvents(
    gladys,
    monitor.snapshot().devices.map((device) => ({ type: 'silent', device })),
  );
  for (const { data } of events) {
    assert.ok(Object.keys(data).length <= 30);
    for (const value of Object.values(data)) {
      assert.ok(['string', 'number', 'boolean'].includes(typeof value), `${value} is not a scalar`);
    }
  }
});

test('get_silent_devices counts and names the silent devices', () => {
  const context = createContext();
  assert.deepEqual(getSilentDevices(context, { power_source: 'all' }), {
    count: 1,
    names: 'office plug',
    monitored: 2,
  });
});

test('get_silent_devices filters by power source', () => {
  const context = createContext();
  assert.deepEqual(getSilentDevices(context, { power_source: 'battery' }), {
    count: 0,
    names: 'No silent device',
    monitored: 1,
  });
  assert.equal(getSilentDevices(context, { power_source: 'mains' }).count, 1);
});

// "0 silent device" before the inventory would be a false all-clear the scene
// acts on: failing the action lets the scene log why instead.
test('get_silent_devices refuses to answer before the inventory', () => {
  const clock = createClock();
  const config = normalizeConfig();
  const monitor = new DevicesMonitor({ config, now: clock.now });
  assert.throws(() => getSilentDevices({ monitor, config }, {}), /inventory/);
});

test('get_device_status answers for the device picked in the scene', () => {
  const { monitor } = createContext();
  const outputs = getDeviceStatus(
    { gladys, monitor },
    { device: zigbeeExternalIds(gladys, PLUG_IEEE).device },
  );
  assert.deepEqual(outputs, {
    alive: false,
    device_name: 'office plug',
    silence_minutes: 180,
    threshold_minutes: 120,
  });
});

// An unknown or excluded device answered as `alive: false` would page someone.
test('get_device_status fails on a device it does not watch', () => {
  const { monitor } = createContext({ ignored_devices: 'office plug' });
  const plug = zigbeeExternalIds(gladys, PLUG_IEEE).device;
  assert.throws(() => getDeviceStatus({ gladys, monitor }, { device: plug }), /not a watched/);
  assert.throws(() => getDeviceStatus({ gladys, monitor }, { device: 'ext:other' }));
});
