// -----------------------------------------------------------------------------
// Connection to the MQTT broker Zigbee2MQTT publishes on.
//
// This is the only place that talks to the outside world. `mqtt.js` handles the
// reconnection loop by itself; this wrapper adds what the integration needs on
// top of it: a single subscription to `<base_topic>/#`, the retained flag passed
// through to the message handler (it changes how a report is interpreted, see
// `parseLastSeen`), and the last error kept around so the Configuration screen
// can show WHY the connection fails.
// -----------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';
import mqtt from 'mqtt';
import { createLogger } from '@gladysassistant/integration-sdk';

const logger = createLogger({ name: 'mqtt' });

const RECONNECT_PERIOD_MS = 5000;
const CONNECT_TIMEOUT_MS = 15_000;

export class MqttConnection {
  /**
   * @param {object} options - Options.
   * @param {Record<string, unknown>} options.config - Normalized configuration.
   * @param {(topic: string, payload: Buffer, meta: {retained: boolean}) => void} options.onMessage - Message handler.
   * @param {(connected: boolean, error?: Error) => void} [options.onStatusChange] - Called on every connection state change.
   */
  constructor({ config, onMessage, onStatusChange = () => {} }) {
    this.config = config;
    this.onMessage = onMessage;
    this.onStatusChange = onStatusChange;
    this.client = null;
    this.connected = false;
    this.lastError = null;
    this.messagesReceived = 0;
  }

  /** The topic filter covering everything Zigbee2MQTT publishes. */
  get topicFilter() {
    return `${this.config.base_topic}/#`;
  }

  /** Open the connection. Reconnection is then handled by `mqtt.js` for life. */
  start() {
    if (this.client) {
      return;
    }
    const { mqtt_url: url, mqtt_username: username, mqtt_password: password } = this.config;
    logger.info(`Connecting to ${url} (topic ${this.topicFilter})`);

    this.client = mqtt.connect(url, {
      // A unique client id per run: two clients sharing an id kick each other
      // out of the broker in a loop, and this one only ever reads.
      clientId: `gladys-z2m-monitor-${randomUUID().slice(0, 8)}`,
      username: username || undefined,
      password: password || undefined,
      clean: true,
      reconnectPeriod: RECONNECT_PERIOD_MS,
      connectTimeout: CONNECT_TIMEOUT_MS,
      resubscribe: true,
    });

    this.client.on('connect', () => {
      this.connected = true;
      this.lastError = null;
      logger.info('Connected to the MQTT broker');
      this.client.subscribe(this.topicFilter, { qos: 0 }, (err) => {
        if (err) {
          this.lastError = err;
          logger.error(`Subscription to ${this.topicFilter} failed`, err);
        } else {
          logger.info(`Subscribed to ${this.topicFilter}`);
        }
        this.onStatusChange(this.connected, this.lastError ?? undefined);
      });
    });

    this.client.on('message', (topic, payload, packet) => {
      this.messagesReceived += 1;
      try {
        // `retain` on an incoming message means the broker replayed a stored
        // value: it tells us the last thing the device said, NOT that it just
        // said it. The monitor needs that distinction to stay honest.
        this.onMessage(topic, payload, { retained: packet?.retain === true });
      } catch (err) {
        logger.error(`Failed to handle a message on ${topic}`, err);
      }
    });

    this.client.on('error', (err) => {
      this.lastError = err;
      logger.error('MQTT error', err);
    });

    this.client.on('close', () => {
      if (this.connected) {
        this.connected = false;
        logger.warn('MQTT connection closed');
        this.onStatusChange(false, this.lastError ?? undefined);
      }
    });

    this.client.on('reconnect', () => {
      logger.info('Reconnecting to the MQTT broker...');
    });
  }

  /** Ask `mqtt.js` to retry now instead of waiting for its next attempt. */
  reconnectNow() {
    if (this.client && !this.connected) {
      this.client.reconnect();
    }
  }

  /**
   * Close the connection.
   * @returns {Promise<void>} Resolves once the socket is closed.
   */
  async stop() {
    const client = this.client;
    this.client = null;
    this.connected = false;
    if (!client) {
      return;
    }
    await new Promise((resolve) => {
      client.end(true, {}, resolve);
    });
    logger.info('MQTT connection closed');
  }
}

/**
 * Do two configurations describe the same broker connection? A change of
 * threshold must not drop the MQTT session; a change of URL, credentials or base
 * topic must.
 * @param {Record<string, unknown>} a - First configuration.
 * @param {Record<string, unknown>} b - Second configuration.
 * @returns {boolean} True when the connection can be kept as is.
 */
export function sameBrokerConfig(a, b) {
  return (
    a.mqtt_url === b.mqtt_url &&
    a.mqtt_username === b.mqtt_username &&
    a.mqtt_password === b.mqtt_password &&
    a.base_topic === b.base_topic
  );
}
