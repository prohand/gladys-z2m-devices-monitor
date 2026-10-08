import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listSilentDevices, refreshDevices, testConnection } from '../src/actions.js';
import { normalizeConfig } from '../src/config.js';
import { DevicesMonitor } from '../src/monitor.js';
import { parseBridgeDevices } from '../src/z2m/payloads.js';
import { BRIDGE_DEVICES_PAYLOAD, createClock } from './helpers/z2mFixtures.js';

/**
 * Build a monitor fed with the fixture network.
 * @param {Record<string, unknown>} [overrides] - Configuration overrides.
 * @param {boolean} [withInventory] - Whether `bridge/devices` was received.
 * @returns {{monitor: DevicesMonitor, clock: object, config: object}} The context pieces.
 */
function createContext(overrides = {}, withInventory = true) {
  const clock = createClock();
  const config = normalizeConfig(overrides);
  const monitor = new DevicesMonitor({ config, now: clock.now });
  if (withInventory) {
    monitor.setZ2mDevices(parseBridgeDevices(BRIDGE_DEVICES_PAYLOAD));
  }
  return { monitor, clock, config };
}

const connectedMqtt = { connected: true, lastError: null, messagesReceived: 42 };

test('test_connection explains WHY the broker is unreachable', () => {
  const { monitor, config } = createContext();
  let reconnected = false;
  const mqtt = {
    connected: false,
    lastError: new Error('ECONNREFUSED'),
    messagesReceived: 0,
    reconnectNow: () => {
      reconnected = true;
    },
  };
  const message = testConnection({ mqtt, monitor, config });
  assert.match(message.en, /Not connected/);
  assert.match(message.en, /ECONNREFUSED/);
  assert.match(message.fr, /Non connecté/);
  assert.equal(reconnected, true, 'the click also retries');
});

// The single most common setup mistake: connected to the right broker, wrong
// base topic — and nothing at all happens.
test('test_connection points at the base topic when the inventory never came', () => {
  const { monitor, config } = createContext({ base_topic: 'zigbee' }, false);
  const message = testConnection({ mqtt: connectedMqtt, monitor, config });
  assert.match(message.en, /zigbee\/bridge\/devices/);
  assert.match(message.fr, /topic de base/);
});

test('test_connection reports the live picture once everything is up', () => {
  const { monitor, config } = createContext();
  monitor.setBridgeOnline(true);
  const message = testConnection({ mqtt: connectedMqtt, monitor, config });
  assert.match(message.en, /2 device\(s\) watched/);
  assert.match(message.en, /42 message\(s\)/);
  assert.match(message.en, /online/);
});

test('test_connection stays polite before the monitor started', () => {
  const { monitor, config } = createContext();
  const message = testConnection({ mqtt: null, monitor, config });
  assert.match(message.en, /not started yet/);
});

test('list_silent_devices names the devices to go and check', () => {
  const { monitor, clock } = createContext({ default_timeout_minutes: 60 });
  monitor.recordActivity('office plug');
  monitor.recordActivity('kitchen/motion');
  clock.advanceMinutes(185);

  const message = listSilentDevices({ monitor });
  assert.match(message.en, /1 silent device/);
  assert.match(message.en, /office plug/);
  assert.match(message.en, /3 h 5 min/);
  assert.match(message.fr, /appareil\(s\) silencieux/);
});

test('list_silent_devices flags a device that never said anything', () => {
  const { monitor, clock } = createContext({ default_timeout_minutes: 60 });
  clock.advanceMinutes(120);
  const message = listSilentDevices({ monitor });
  assert.match(message.en, /never seen/);
  assert.match(message.fr, /jamais vu/);
});

test('list_silent_devices confirms when everything is fine', () => {
  const { monitor } = createContext();
  monitor.recordActivity('office plug');
  monitor.recordActivity('kitchen/motion');
  const message = listSilentDevices({ monitor });
  assert.match(message.en, /giving signs of life/);
});

test('refresh_devices republishes and reports the count', async () => {
  const { monitor } = createContext();
  const message = await refreshDevices({ monitor, publishDevices: async () => 3 });
  assert.match(message.en, /3 device\(s\) published/);
});

test('refresh_devices refuses to publish before the inventory arrived', async () => {
  const { monitor } = createContext({}, false);
  let called = false;
  const message = await refreshDevices({
    monitor,
    publishDevices: async () => {
      called = true;
      return 0;
    },
  });
  assert.equal(called, false);
  assert.match(message.en, /not been received yet/);
});

// `mqtt://user:pass@host` is a URL users do type: the answer under the button
// must not print the password back.
test('test_connection never quotes the credentials of the broker URL', () => {
  const { monitor, config } = createContext({ mqtt_url: 'mqtt://gladys:s3cret@broker:1883' });
  const answers = [
    testConnection({ mqtt: connectedMqtt, monitor, config }),
    testConnection({
      mqtt: { connected: false, lastError: null, messagesReceived: 0, reconnectNow() {} },
      monitor,
      config,
    }),
  ];
  for (const answer of answers) {
    for (const text of [answer.en, answer.fr]) {
      assert.doesNotMatch(text, /s3cret|gladys:/);
      assert.match(text, /mqtt:\/\/\*\*\*@broker:1883/);
    }
  }
});
