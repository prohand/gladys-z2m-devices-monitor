import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../src/config.js';
import { DevicesMonitor } from '../src/monitor.js';
import { TOPIC_KINDS } from '../src/z2m/topics.js';
import { BRIDGE_DEVICES_PAYLOAD, createClock, PLUG_IEEE } from './helpers/z2mFixtures.js';

// These tests replay dozens of MQTT messages; the router narrates each one at
// info level. Pin the level BEFORE the module builds its logger.
process.env.LOG_LEVEL = 'silent';
const { routeMessage } = await import('../src/messageRouter.js');

const BASE = 'zigbee2mqtt';

/**
 * Build a monitor and a `send()` shortcut that pushes an MQTT message into it.
 * @param {Record<string, unknown>} [overrides] - Configuration overrides.
 * @returns {{monitor: DevicesMonitor, clock: object, send: Function}} The test rig.
 */
function createRig(overrides = {}) {
  const clock = createClock();
  const monitor = new DevicesMonitor({ config: normalizeConfig(overrides), now: clock.now });
  const send = (topic, payload, retained = false) =>
    routeMessage({
      monitor,
      baseTopic: BASE,
      topic,
      payload: Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload)),
      retained,
    });
  return { monitor, clock, send };
}

/**
 * Read one device out of the monitor snapshot.
 * @param {DevicesMonitor} monitor - The monitor.
 * @param {string} ieee - IEEE address.
 * @returns {object} The device entry.
 */
function device(monitor, ieee) {
  return monitor.snapshot().devices.find((entry) => entry.ieeeAddress === ieee);
}

test('the inventory populates the watched devices', () => {
  const { monitor, send } = createRig();
  const result = send(`${BASE}/bridge/devices`, BRIDGE_DEVICES_PAYLOAD);
  assert.equal(result.kind, TOPIC_KINDS.BRIDGE_DEVICES);
  assert.equal(result.inventoryUpdated, true);
  assert.equal(monitor.snapshot().summary.monitored, 2);
});

test('a device report counts as a sign of life', () => {
  const { monitor, clock, send } = createRig();
  send(`${BASE}/bridge/devices`, BRIDGE_DEVICES_PAYLOAD);
  clock.advanceMinutes(30);
  send(`${BASE}/office plug`, { state: 'ON', linkquality: 84 });

  assert.equal(device(monitor, PLUG_IEEE).silenceMinutes, 0);
});

// The heart of the matter. On every reconnection the broker replays the last
// retained report of every device; treating that as fresh would reset the whole
// network to "seen just now" — including the sensor that died last week.
test('a retained report does NOT reset the silence', () => {
  const { monitor, clock, send } = createRig({ default_timeout_minutes: 60 });
  send(`${BASE}/bridge/devices`, BRIDGE_DEVICES_PAYLOAD);
  send(`${BASE}/office plug`, { state: 'ON' });
  clock.advanceMinutes(120);

  send(`${BASE}/office plug`, { state: 'ON', linkquality: 60 }, true);

  const plug = device(monitor, PLUG_IEEE);
  assert.equal(plug.silenceMinutes, 120, 'the replayed message proves nothing about WHEN');
  assert.equal(plug.alive, false);
});

test('a retained report carrying last_seen IS usable, and dated', () => {
  const { monitor, clock, send } = createRig({ default_timeout_minutes: 60 });
  send(`${BASE}/bridge/devices`, BRIDGE_DEVICES_PAYLOAD);
  clock.advanceMinutes(200);

  // `Date.now()` is the clock the router stamps against, so build the timestamp
  // from it rather than from the monitor's injected clock.
  const twentyMinutesAgo = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  send(`${BASE}/office plug`, { state: 'ON', last_seen: twentyMinutesAgo }, true);

  const plug = device(monitor, PLUG_IEEE);
  assert.ok(plug.lastSeen !== null, 'the report dated itself');
  assert.equal(plug.neverSeen, false);
});

// Without this, a dead device stays "alive" for as long as a scene keeps
// sending it commands — the exact failure this integration exists to catch.
test('commands sent to a device never revive it', () => {
  const { monitor, clock, send } = createRig({ default_timeout_minutes: 60 });
  send(`${BASE}/bridge/devices`, BRIDGE_DEVICES_PAYLOAD);
  send(`${BASE}/office plug`, { state: 'ON' });
  clock.advanceMinutes(120);

  assert.equal(send(`${BASE}/office plug/set`, { state: 'OFF' }).kind, TOPIC_KINDS.COMMAND);
  send(`${BASE}/office plug/get`, { state: '' });

  assert.equal(device(monitor, PLUG_IEEE).alive, false);
});

test('a device_announce event revives a device that has not reported yet', () => {
  const { monitor, clock, send } = createRig({ default_timeout_minutes: 60 });
  send(`${BASE}/bridge/devices`, BRIDGE_DEVICES_PAYLOAD);
  clock.advanceMinutes(120);
  assert.equal(device(monitor, PLUG_IEEE).alive, false);

  send(`${BASE}/bridge/event`, {
    type: 'device_announce',
    data: { friendly_name: 'office plug', ieee_address: PLUG_IEEE },
  });
  assert.equal(device(monitor, PLUG_IEEE).alive, true);
});

test('the bridge state is picked up', () => {
  const { monitor, send } = createRig();
  send(`${BASE}/bridge/state`, { state: 'offline' });
  assert.equal(monitor.snapshot().summary.bridgeOnline, false);
  send(`${BASE}/bridge/state`, 'online');
  assert.equal(monitor.snapshot().summary.bridgeOnline, true);
});

test('Zigbee2MQTT own availability is recorded but never drives the verdict', () => {
  const { monitor, send } = createRig({ default_timeout_minutes: 60 });
  send(`${BASE}/bridge/devices`, BRIDGE_DEVICES_PAYLOAD);
  send(`${BASE}/office plug/availability`, { state: 'offline' });

  const plug = device(monitor, PLUG_IEEE);
  assert.equal(plug.availability, 'offline');
  assert.equal(plug.alive, true, 'still inside its own threshold, whatever Zigbee2MQTT thinks');
});

test('clearing a retained topic is not a sign of life', () => {
  const { monitor, clock, send } = createRig({ default_timeout_minutes: 60 });
  send(`${BASE}/bridge/devices`, BRIDGE_DEVICES_PAYLOAD);
  clock.advanceMinutes(120);
  send(`${BASE}/office plug`, '');
  assert.equal(device(monitor, PLUG_IEEE).neverSeen, true);
});

test('reports arriving before the inventory are replayed once it lands', () => {
  const { monitor, clock, send } = createRig();
  send(`${BASE}/office plug`, { state: 'ON', linkquality: 91 });
  clock.advanceMinutes(5);
  send(`${BASE}/bridge/devices`, BRIDGE_DEVICES_PAYLOAD);

  assert.equal(device(monitor, PLUG_IEEE).silenceMinutes, 5);
});

test('foreign and unrelated topics are ignored', () => {
  const { send } = createRig();
  assert.equal(send('homeassistant/sensor/x/config', {}).kind, TOPIC_KINDS.UNKNOWN);
  assert.equal(send(`${BASE}/bridge/logging`, { level: 'info' }).kind, TOPIC_KINDS.BRIDGE_OTHER);
});

test('a malformed payload never takes the router down', () => {
  const { send } = createRig();
  assert.doesNotThrow(() => send(`${BASE}/bridge/devices`, 'not json'));
  assert.doesNotThrow(() => send(`${BASE}/bridge/event`, '{'));
  assert.doesNotThrow(() => send(`${BASE}/office plug`, 'plain text'));
});

// A truncated payload reads as "zero devices"; accepting it would drop the whole
// inventory AND the last-seen history built with it.
test('an unreadable inventory is ignored, not treated as an empty network', () => {
  const { monitor, send } = createRig();
  send(`${BASE}/bridge/devices`, BRIDGE_DEVICES_PAYLOAD);
  send(`${BASE}/office plug`, { state: 'ON' });

  const result = send(`${BASE}/bridge/devices`, '[{"ieee_address":');
  assert.equal(result.inventoryUpdated, false);
  assert.equal(monitor.snapshot().summary.monitored, 2, 'the inventory survived');
  assert.ok(monitor.serialize()[PLUG_IEEE], 'and so did the history');
});

test('a genuinely empty inventory IS honored', () => {
  const { monitor, send } = createRig();
  send(`${BASE}/bridge/devices`, BRIDGE_DEVICES_PAYLOAD);
  const result = send(`${BASE}/bridge/devices`, []);
  assert.equal(result.inventoryUpdated, true);
  assert.equal(monitor.snapshot().summary.monitored, 0);
});
