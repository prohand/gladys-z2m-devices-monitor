import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTopic, TOPIC_KINDS } from '../src/z2m/topics.js';

const BASE = 'zigbee2mqtt';
const KNOWN = new Set(['kitchen/motion', 'office plug']);

test('the bridge topics are recognized', () => {
  assert.equal(parseTopic(`${BASE}/bridge/devices`, BASE, KNOWN).kind, TOPIC_KINDS.BRIDGE_DEVICES);
  assert.equal(parseTopic(`${BASE}/bridge/state`, BASE, KNOWN).kind, TOPIC_KINDS.BRIDGE_STATE);
  assert.equal(parseTopic(`${BASE}/bridge/event`, BASE, KNOWN).kind, TOPIC_KINDS.BRIDGE_EVENT);
  assert.equal(parseTopic(`${BASE}/bridge/info`, BASE, KNOWN).kind, TOPIC_KINDS.BRIDGE_OTHER);
  assert.equal(parseTopic(`${BASE}/bridge/logging`, BASE, KNOWN).kind, TOPIC_KINDS.BRIDGE_OTHER);
});

test('a device report is a sign of life', () => {
  assert.deepEqual(parseTopic(`${BASE}/office plug`, BASE, KNOWN), {
    kind: TOPIC_KINDS.DEVICE_STATE,
    friendlyName: 'office plug',
  });
});

test('a friendly name containing a slash is resolved as a whole', () => {
  assert.deepEqual(parseTopic(`${BASE}/kitchen/motion`, BASE, KNOWN), {
    kind: TOPIC_KINDS.DEVICE_STATE,
    friendlyName: 'kitchen/motion',
  });
});

test('a per-attribute topic is attributed to its device', () => {
  assert.deepEqual(parseTopic(`${BASE}/kitchen/motion/occupancy`, BASE, KNOWN), {
    kind: TOPIC_KINDS.DEVICE_STATE,
    friendlyName: 'kitchen/motion',
  });
});

// This is the whole point of the integration: a dead sensor must not look alive
// because Gladys, Home Assistant or a scene keeps sending it commands.
test('commands sent TO a device are never a sign of life', () => {
  for (const topic of [
    `${BASE}/office plug/set`,
    `${BASE}/office plug/get`,
    `${BASE}/kitchen/motion/set`,
    `${BASE}/office plug/set/state`,
    `${BASE}/office plug/get/state`,
  ]) {
    assert.equal(parseTopic(topic, BASE, KNOWN).kind, TOPIC_KINDS.COMMAND, topic);
  }
});

test('an availability topic is reported separately from a device report', () => {
  assert.deepEqual(parseTopic(`${BASE}/kitchen/motion/availability`, BASE, KNOWN), {
    kind: TOPIC_KINDS.DEVICE_AVAILABILITY,
    friendlyName: 'kitchen/motion',
  });
});

test('an unknown device is still treated as a device report', () => {
  // The inventory and the reports race on connection: a report that arrives
  // first is buffered by the monitor, not thrown away.
  assert.deepEqual(parseTopic(`${BASE}/brand new sensor`, BASE, KNOWN), {
    kind: TOPIC_KINDS.DEVICE_STATE,
    friendlyName: 'brand new sensor',
  });
});

test('topics outside the base topic are ignored', () => {
  assert.equal(parseTopic('homeassistant/sensor/config', BASE, KNOWN).kind, TOPIC_KINDS.UNKNOWN);
  assert.equal(parseTopic('zigbee2mqtt2/device', BASE, KNOWN).kind, TOPIC_KINDS.UNKNOWN);
  assert.equal(parseTopic(BASE, BASE, KNOWN).kind, TOPIC_KINDS.UNKNOWN);
  assert.equal(parseTopic(`${BASE}/`, BASE, KNOWN).kind, TOPIC_KINDS.UNKNOWN);
});

test('a custom base topic is honored', () => {
  assert.equal(
    parseTopic('zigbee/bridge/devices', 'zigbee', KNOWN).kind,
    TOPIC_KINDS.BRIDGE_DEVICES,
  );
});
