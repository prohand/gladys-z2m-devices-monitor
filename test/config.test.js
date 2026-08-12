import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CONFIG,
  normalizeConfig,
  parseCustomTimeouts,
  parseDeviceList,
} from '../src/config.js';

test('normalizeConfig returns the defaults when called with no argument', () => {
  assert.deepEqual(normalizeConfig(), DEFAULT_CONFIG);
});

test('normalizeConfig keeps the user values over the defaults', () => {
  const config = normalizeConfig({
    mqtt_url: 'mqtt://192.168.1.10:1883',
    base_topic: 'zigbee',
    default_timeout_minutes: 30,
  });
  assert.equal(config.mqtt_url, 'mqtt://192.168.1.10:1883');
  assert.equal(config.base_topic, 'zigbee');
  assert.equal(config.default_timeout_minutes, 30);
});

test('normalizeConfig coerces the numeric strings a form sends', () => {
  const config = normalizeConfig({
    default_timeout_minutes: '240',
    battery_timeout_minutes: '2880',
    check_interval_seconds: '30',
  });
  assert.equal(config.default_timeout_minutes, 240);
  assert.equal(config.battery_timeout_minutes, 2880);
  assert.equal(config.check_interval_seconds, 30);
  assert.equal(typeof config.check_interval_seconds, 'number');
});

test('normalizeConfig falls back to the default for an unusable number', () => {
  for (const value of ['', 'abc', 0, -5, null]) {
    assert.equal(
      normalizeConfig({ default_timeout_minutes: value }).default_timeout_minutes,
      DEFAULT_CONFIG.default_timeout_minutes,
      `"${value}" must fall back to the default`,
    );
  }
});

test('normalizeConfig trims the base topic so the topic filter stays valid', () => {
  assert.equal(normalizeConfig({ base_topic: ' zigbee2mqtt/ ' }).base_topic, 'zigbee2mqtt');
  assert.equal(normalizeConfig({ base_topic: 'zigbee2mqtt//' }).base_topic, 'zigbee2mqtt');
});

test('monitor_disabled_devices is off unless explicitly turned on', () => {
  assert.equal(normalizeConfig().monitor_disabled_devices, false);
  assert.equal(
    normalizeConfig({ monitor_disabled_devices: 'yes' }).monitor_disabled_devices,
    false,
  );
  assert.equal(normalizeConfig({ monitor_disabled_devices: true }).monitor_disabled_devices, true);
});

test('parseCustomTimeouts reads comma and newline separated pairs', () => {
  const timeouts = parseCustomTimeouts('mailbox=4320, garage motion=180\n0x00158d0001abcdef = 60');
  assert.equal(timeouts.get('mailbox'), 4320);
  assert.equal(timeouts.get('garage motion'), 180);
  assert.equal(timeouts.get('0x00158d0001abcdef'), 60);
});

test('parseCustomTimeouts is case-insensitive on the device key', () => {
  assert.equal(parseCustomTimeouts('Kitchen Motion=90').get('kitchen motion'), 90);
});

test('parseCustomTimeouts splits on the last = so a name may contain one', () => {
  assert.equal(parseCustomTimeouts('sensor=a=120').get('sensor=a'), 120);
});

test('parseCustomTimeouts drops the malformed and non-positive entries', () => {
  const timeouts = parseCustomTimeouts('no-separator, =120, empty=, bad=abc, zero=0, ok=15');
  assert.deepEqual([...timeouts.entries()], [['ok', 15]]);
});

test('parseDeviceList reads a lowercased set and ignores the empty entries', () => {
  const list = parseDeviceList(' Kitchen Motion , ,0x00158D0001ABCDEF;\nspare\n');
  assert.deepEqual([...list], ['kitchen motion', '0x00158d0001abcdef', 'spare']);
});

test('parseDeviceList and parseCustomTimeouts tolerate an empty field', () => {
  assert.equal(parseDeviceList('').size, 0);
  assert.equal(parseDeviceList(undefined).size, 0);
  assert.equal(parseCustomTimeouts('').size, 0);
  assert.equal(parseCustomTimeouts(undefined).size, 0);
});
