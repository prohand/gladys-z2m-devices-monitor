import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CONFIG,
  normalizeBrokerUrl,
  normalizeConfig,
  normalizePemCertificates,
  parseCustomTimeouts,
  parseDeviceList,
  redactBrokerUrl,
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

test('normalizeConfig adds the missing scheme to a host:port broker URL', () => {
  // Without it, `url.parse` reads `192.168.1.10:` as the protocol and `1884` as
  // the host: mqtt.js falls back to plain mqtt on 1883 and the socket dials
  // 0.0.7.92 (1884 read as a 32-bit IPv4 address).
  assert.equal(normalizeBrokerUrl('192.168.1.10:1884'), 'mqtt://192.168.1.10:1884');
  assert.equal(
    normalizeConfig({ mqtt_url: ' 192.168.1.10:1884 ' }).mqtt_url,
    'mqtt://192.168.1.10:1884',
  );
});

test('normalizeBrokerUrl repairs a scheme typed without its slashes', () => {
  assert.equal(normalizeBrokerUrl('mqtt:192.168.1.10:1884'), 'mqtt://192.168.1.10:1884');
  assert.equal(normalizeBrokerUrl('MQTTS:/broker.lan:8883'), 'mqtts://broker.lan:8883');
  assert.equal(normalizeBrokerUrl('//192.168.1.10:1884'), 'mqtt://192.168.1.10:1884');
});

test('normalizeBrokerUrl leaves a well-formed URL alone', () => {
  for (const url of [
    'mqtt://192.168.1.10:1884',
    'mqtts://broker.lan:8883',
    'ws://192.168.1.10:9001/mqtt',
    'mqtt://user:pass@192.168.1.10:1884',
    'mqtt://[::1]:1883',
  ]) {
    assert.equal(normalizeBrokerUrl(url), url);
  }
});

test('normalizeBrokerUrl falls back to the default for an empty field', () => {
  for (const value of ['', '   ', null, undefined]) {
    assert.equal(normalizeBrokerUrl(value), DEFAULT_CONFIG.mqtt_url);
  }
  assert.equal(normalizeConfig({ mqtt_url: '' }).mqtt_url, DEFAULT_CONFIG.mqtt_url);
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

// --- Credentials in the URL -------------------------------------------------------

test('redactBrokerUrl hides the credentials a URL carries, and only them', () => {
  assert.equal(
    redactBrokerUrl('mqtt://user:secret@192.168.1.10:1883'),
    'mqtt://***@192.168.1.10:1883',
  );
  assert.equal(redactBrokerUrl('mqtts://gladys@broker/path'), 'mqtts://***@broker/path');
  assert.equal(redactBrokerUrl('mqtt://user:p@ss@host:1883'), 'mqtt://***@host:1883');
  assert.equal(redactBrokerUrl('mqtt://192.168.1.10:1883'), 'mqtt://192.168.1.10:1883');
  assert.equal(redactBrokerUrl('ws://host:9001/mqtt?x=a@b'), 'ws://host:9001/mqtt?x=a@b');
  assert.equal(redactBrokerUrl(undefined), '');
});

// --- TLS ---------------------------------------------------------------------------

const BODY = 'A'.repeat(64) + 'B'.repeat(64) + 'C'.repeat(10);
const PEM = `-----BEGIN CERTIFICATE-----\n${'A'.repeat(64)}\n${'B'.repeat(64)}\n${'C'.repeat(10)}\n-----END CERTIFICATE-----\n`;

test('TLS verification is on, with no CA, unless configured otherwise', () => {
  const config = normalizeConfig();
  assert.equal(config.mqtt_ca_certificate, '');
  assert.equal(config.mqtt_reject_unauthorized, true);
  assert.equal(
    normalizeConfig({ mqtt_reject_unauthorized: false }).mqtt_reject_unauthorized,
    false,
  );
  assert.equal(
    normalizeConfig({ mqtt_reject_unauthorized: 'false' }).mqtt_reject_unauthorized,
    false,
  );
  assert.equal(normalizeConfig({ mqtt_reject_unauthorized: null }).mqtt_reject_unauthorized, true);
});

test('a well-formed PEM certificate goes through untouched', () => {
  assert.equal(normalizePemCertificates(PEM), PEM);
});

// A single-line text input strips the line breaks of what is pasted into it.
test('a certificate pasted on one line is rebuilt into valid PEM', () => {
  assert.equal(
    normalizePemCertificates(`-----BEGIN CERTIFICATE-----${BODY}-----END CERTIFICATE-----`),
    PEM,
  );
  assert.equal(
    normalizePemCertificates(
      `  -----BEGIN CERTIFICATE----- ${BODY.slice(0, 70)} ${BODY.slice(70)} -----END CERTIFICATE-----  `,
    ),
    PEM,
    'spaces where the line breaks were',
  );
  assert.equal(
    normalizePemCertificates(PEM.replaceAll('\n', '\\n')),
    PEM,
    'escaped line breaks copied out of a JSON file',
  );
});

test('a chain of certificates keeps every block', () => {
  const chain = normalizePemCertificates(
    `-----BEGIN CERTIFICATE-----${BODY}-----END CERTIFICATE----------BEGIN CERTIFICATE-----${BODY}-----END CERTIFICATE-----`,
  );
  assert.equal(chain, `${PEM.trimEnd()}\n${PEM}`);
});

test('an empty or non-PEM certificate field is kept as typed', () => {
  assert.equal(normalizePemCertificates(''), '');
  assert.equal(normalizePemCertificates(undefined), '');
  assert.equal(normalizePemCertificates('  not a certificate '), 'not a certificate');
});
