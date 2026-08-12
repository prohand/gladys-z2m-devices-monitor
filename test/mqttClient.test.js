// -----------------------------------------------------------------------------
// End-to-end test of the MQTT layer, against a REAL broker.
//
// `aedes` runs an MQTT broker in-process, so the plumbing this integration
// depends on is exercised for real: the wildcard subscription, the retained
// flag the broker sets when it replays a stored message (which the unit tests
// can only simulate), and the credentials handling.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { Aedes } from 'aedes';
import mqtt from 'mqtt';
import { normalizeConfig } from '../src/config.js';

// One test deliberately fails an authentication, which the connection reports —
// rightly — as an error. Pin the level BEFORE the module builds its logger so
// the expected failure does not look like a broken test run.
process.env.LOG_LEVEL = 'silent';
const { MqttConnection, sameBrokerConfig } = await import('../src/mqttClient.js');

/**
 * Start an in-process MQTT broker on a free port.
 * @returns {Promise<{url: string, aedes: object, close: () => Promise<void>}>} The running broker.
 */
async function startBroker() {
  const aedes = await Aedes.createBroker();
  const server = createServer(aedes.handle);
  server.listen(0);
  await once(server, 'listening');
  const { port } = server.address();
  return {
    url: `mqtt://127.0.0.1:${port}`,
    aedes,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await new Promise((resolve) => aedes.close(resolve));
    },
  };
}

/**
 * Wait for a condition to become true, or fail the test.
 * @param {() => boolean} predicate - Condition to wait for.
 * @param {string} description - What we are waiting for, for the failure message.
 * @returns {Promise<void>} Resolves once the condition holds.
 */
async function waitFor(predicate, description) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`timed out waiting for ${description}`);
}

test('the connection subscribes to the whole base topic and reads live messages', async () => {
  const broker = await startBroker();
  const received = [];
  const connection = new MqttConnection({
    config: normalizeConfig({ mqtt_url: broker.url, base_topic: 'zigbee2mqtt' }),
    onMessage: (topic, payload, meta) => {
      received.push({ topic, payload: payload.toString('utf8'), retained: meta.retained });
    },
  });

  try {
    connection.start();
    await waitFor(() => connection.connected, 'the connection to be established');

    const publisher = mqtt.connect(broker.url);
    await once(publisher, 'connect');
    publisher.publish('zigbee2mqtt/office plug', '{"state":"ON"}');
    publisher.publish('zigbee2mqtt/bridge/state', '{"state":"online"}');
    publisher.publish('other-app/whatever', 'ignored');

    await waitFor(() => received.length >= 2, 'the published messages');
    publisher.end(true);

    assert.deepEqual(
      received.map((message) => message.topic).sort(),
      ['zigbee2mqtt/bridge/state', 'zigbee2mqtt/office plug'],
      'the wildcard covers the base topic, and only it',
    );
    assert.equal(
      received.every((message) => message.retained === false),
      true,
    );
  } finally {
    await connection.stop();
    await broker.close();
  }
});

// A retained message reaching us with `retained: false` would silently break the
// core rule of the monitor, so the flag is verified against a real broker.
test('a message replayed by the broker arrives flagged as retained', async () => {
  const broker = await startBroker();
  const received = [];
  const connection = new MqttConnection({
    config: normalizeConfig({ mqtt_url: broker.url }),
    onMessage: (topic, payload, meta) => received.push({ topic, retained: meta.retained }),
  });

  try {
    // Store the report BEFORE the monitor ever connects, exactly as Zigbee2MQTT
    // does with `retain: true`.
    const publisher = mqtt.connect(broker.url);
    await once(publisher, 'connect');
    publisher.publish('zigbee2mqtt/office plug', '{"state":"ON"}', { retain: true });
    await new Promise((resolve) => setTimeout(resolve, 100));
    publisher.end(true);

    connection.start();
    await waitFor(() => received.length >= 1, 'the retained message to be replayed');

    assert.equal(received[0].topic, 'zigbee2mqtt/office plug');
    assert.equal(received[0].retained, true, 'the broker replayed a stored message');
  } finally {
    await connection.stop();
    await broker.close();
  }
});

test('a wrong password is reported instead of silently retried forever', async () => {
  const broker = await startBroker();
  broker.aedes.authenticate = (_client, username, password, done) => {
    const ok = username === 'gladys' && password?.toString() === 'good';
    const error = ok ? null : Object.assign(new Error('Auth error'), { returnCode: 4 });
    done(error, ok);
  };

  const connection = new MqttConnection({
    config: normalizeConfig({
      mqtt_url: broker.url,
      mqtt_username: 'gladys',
      mqtt_password: 'wrong',
    }),
    onMessage: () => {},
  });

  try {
    connection.start();
    await waitFor(() => connection.lastError !== null, 'the authentication failure');
    assert.equal(connection.connected, false);
    assert.ok(connection.lastError.message.length > 0, 'the reason is kept for the user');
  } finally {
    await connection.stop();
    await broker.close();
  }
});

test('correct credentials connect', async () => {
  const broker = await startBroker();
  broker.aedes.authenticate = (_client, username, password, done) => {
    done(null, username === 'gladys' && password?.toString() === 'good');
  };

  const connection = new MqttConnection({
    config: normalizeConfig({
      mqtt_url: broker.url,
      mqtt_username: 'gladys',
      mqtt_password: 'good',
    }),
    onMessage: () => {},
  });

  try {
    connection.start();
    await waitFor(() => connection.connected, 'the authenticated connection');
    assert.equal(connection.lastError, null);
  } finally {
    await connection.stop();
    await broker.close();
  }
});

test('sameBrokerConfig only reacts to what actually changes the session', () => {
  const base = normalizeConfig({ mqtt_url: 'mqtt://a:1883', base_topic: 'zigbee2mqtt' });
  assert.equal(
    sameBrokerConfig(base, normalizeConfig({ ...base, default_timeout_minutes: 999 })),
    true,
    'a new threshold must not drop the MQTT session',
  );
  assert.equal(sameBrokerConfig(base, normalizeConfig({ ...base, base_topic: 'zigbee' })), false);
  assert.equal(
    sameBrokerConfig(base, normalizeConfig({ ...base, mqtt_url: 'mqtt://b:1883' })),
    false,
  );
  assert.equal(sameBrokerConfig(base, normalizeConfig({ ...base, mqtt_password: 'x' })), false);
});
