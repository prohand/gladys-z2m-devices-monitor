import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../src/config.js';
import {
  ConnectionStatusReporter,
  INITIALIZATION_FAILED_STATUS,
  INVENTORY_GRACE_MS,
  buildConnectionStatus,
} from '../src/connectionStatus.js';
import { createFakeGladys } from './helpers/fakeGladys.js';

const config = normalizeConfig({ mqtt_url: 'mqtt://broker:1883' });
const START = Date.parse('2026-01-01T00:00:00.000Z');

test('an unreachable broker is reported with its address and the reason', () => {
  const status = buildConnectionStatus({
    mqtt: { connected: false, lastError: new Error('connect ECONNREFUSED') },
    monitor: { inventoryReceivedAt: null },
    config,
    mqttStartedAt: START,
    now: START,
  });
  assert.equal(status.connected, false);
  assert.match(status.message.en, /mqtt:\/\/broker:1883 \(connect ECONNREFUSED\)/);
  assert.ok(status.message.fr);
});

test('a missing MQTT connection reads as unreachable, not as connected', () => {
  const status = buildConnectionStatus({
    mqtt: null,
    monitor: { inventoryReceivedAt: null },
    config,
    mqttStartedAt: null,
    now: START,
  });
  assert.equal(status.connected, false);
});

// Right broker, wrong base topic: the connection works and nothing ever arrives.
test('no inventory past the grace period points at the base topic', () => {
  const context = {
    mqtt: { connected: true, lastError: null },
    monitor: { inventoryReceivedAt: null },
    config,
    mqttStartedAt: START,
  };
  assert.deepEqual(buildConnectionStatus({ ...context, now: START + 1000 }), { connected: true });
  const late = buildConnectionStatus({ ...context, now: START + INVENTORY_GRACE_MS + 1 });
  assert.equal(late.connected, false);
  assert.match(late.message.en, /zigbee2mqtt\/bridge\/devices/);
});

test('a received inventory means connected', () => {
  const status = buildConnectionStatus({
    mqtt: { connected: true, lastError: null },
    monitor: { inventoryReceivedAt: START },
    config,
    mqttStartedAt: START,
    now: START + INVENTORY_GRACE_MS * 10,
  });
  assert.deepEqual(status, { connected: true });
});

test('the reporter sends a status once, and again only when it changes', async () => {
  const gladys = createFakeGladys();
  const reporter = new ConnectionStatusReporter({ gladys });
  assert.equal(await reporter.report({ connected: true }), true);
  assert.equal(await reporter.report({ connected: true }), false);
  assert.equal(await reporter.report(INITIALIZATION_FAILED_STATUS), true);
  assert.equal(await reporter.report({ connected: true }), true, 'recovery is reported');
  assert.equal(gladys.connectionStatuses.length, 3);
});

test('a different reason for the same failure is reported', async () => {
  const gladys = createFakeGladys();
  const reporter = new ConnectionStatusReporter({ gladys });
  await reporter.report({ connected: false, message: { en: 'a', fr: 'a' } });
  assert.equal(await reporter.report({ connected: false, message: { en: 'b', fr: 'b' } }), true);
});

test('a status that failed to reach Gladys is sent again next time', async () => {
  const gladys = createFakeGladys();
  let fail = true;
  gladys.setConnectionStatus = async () => {
    if (fail) {
      throw new Error('503');
    }
  };
  const reporter = new ConnectionStatusReporter({ gladys });
  await assert.rejects(() => reporter.report({ connected: true }));
  fail = false;
  assert.equal(await reporter.report({ connected: true }), true);
});

test('reset makes the next report go out even when unchanged', async () => {
  const gladys = createFakeGladys();
  const reporter = new ConnectionStatusReporter({ gladys });
  await reporter.report({ connected: true });
  reporter.reset();
  assert.equal(await reporter.report({ connected: true }), true);
});
