import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAvailability,
  parseBridgeDevices,
  parseBridgeEvent,
  parseBridgeState,
  parseLastSeen,
  parsePayload,
} from '../src/z2m/payloads.js';
import { BRIDGE_DEVICES_PAYLOAD } from './helpers/z2mFixtures.js';

test('parsePayload reads JSON and falls back to the raw string', () => {
  assert.deepEqual(parsePayload(Buffer.from('{"state":"ON"}')), { state: 'ON' });
  assert.equal(parsePayload(Buffer.from('online')), 'online');
  assert.equal(parsePayload(Buffer.from('')), '');
});

test('parseBridgeDevices keeps the fields the monitor needs', () => {
  const devices = parseBridgeDevices(BRIDGE_DEVICES_PAYLOAD);
  const motion = devices.find((device) => device.friendlyName === 'kitchen/motion');
  assert.equal(motion.ieeeAddress, '0x00158d0001111111');
  assert.equal(motion.powerSource, 'Battery');
  assert.equal(motion.model, 'RTCGQ11LM');
  assert.equal(motion.vendor, 'Aqara');
  assert.equal(motion.disabled, false);
});

test('parseBridgeDevices drops the coordinator', () => {
  const devices = parseBridgeDevices(BRIDGE_DEVICES_PAYLOAD);
  assert.equal(
    devices.some((device) => device.type === 'Coordinator'),
    false,
    'the USB stick is not a device that can go silent on its own',
  );
  assert.equal(devices.length, BRIDGE_DEVICES_PAYLOAD.length - 1);
});

test('parseBridgeDevices survives a malformed payload', () => {
  assert.deepEqual(parseBridgeDevices(undefined), []);
  assert.deepEqual(parseBridgeDevices('not an array'), []);
  assert.deepEqual(parseBridgeDevices([null, {}, { ieee_address: '' }]), []);
});

test('parseBridgeDevices falls back to the IEEE address when there is no friendly name', () => {
  const [device] = parseBridgeDevices([{ ieee_address: '0xabc', type: 'EndDevice' }]);
  assert.equal(device.friendlyName, '0xabc');
});

test('parseBridgeState reads both the object and the legacy string form', () => {
  assert.equal(parseBridgeState({ state: 'online' }), true);
  assert.equal(parseBridgeState({ state: 'offline' }), false);
  assert.equal(parseBridgeState('online'), true);
  assert.equal(parseBridgeState('something else'), undefined);
});

test('parseAvailability reads Zigbee2MQTT own verdict', () => {
  assert.equal(parseAvailability({ state: 'online' }), 'online');
  assert.equal(parseAvailability('offline'), 'offline');
  assert.equal(parseAvailability({}), undefined);
});

test('parseBridgeEvent extracts the device an event is about', () => {
  const event = parseBridgeEvent({
    type: 'device_announce',
    data: { friendly_name: 'kitchen/motion', ieee_address: '0x00158d0001111111' },
  });
  assert.equal(event.type, 'device_announce');
  assert.equal(event.ieeeAddress, '0x00158d0001111111');
  assert.equal(parseBridgeEvent('nope'), undefined);
  assert.equal(parseBridgeEvent({ data: {} }), undefined);
});

test('parseLastSeen reads the three Zigbee2MQTT formats', () => {
  const now = Date.parse('2026-01-01T12:00:00.000Z');
  const iso = Date.parse('2026-01-01T11:30:00.000Z');
  assert.equal(parseLastSeen({ last_seen: '2026-01-01T11:30:00.000Z' }, now), iso);
  assert.equal(parseLastSeen({ last_seen: iso }, now), iso);
  assert.equal(
    parseLastSeen({ last_seen: '2026-01-01T11:30:00' }, now),
    Date.parse('2026-01-01T11:30:00'),
  );
});

// Clock skew between the Zigbee2MQTT host and this container would otherwise
// produce a negative silence, i.e. a device "seen in the future".
test('parseLastSeen clamps a timestamp in the future to now', () => {
  const now = Date.parse('2026-01-01T12:00:00.000Z');
  assert.equal(parseLastSeen({ last_seen: now + 3_600_000 }, now), now);
});

test('parseLastSeen returns undefined when the field is absent or unusable', () => {
  const now = Date.now();
  assert.equal(parseLastSeen({}, now), undefined);
  assert.equal(parseLastSeen({ last_seen: 'not a date' }, now), undefined);
  assert.equal(parseLastSeen({ last_seen: 0 }, now), undefined);
  assert.equal(parseLastSeen('a string', now), undefined);
});
