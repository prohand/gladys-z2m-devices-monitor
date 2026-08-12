// -----------------------------------------------------------------------------
// Entry point of the Z2M Devices Monitor integration.
//
// What it does: subscribe to everything Zigbee2MQTT publishes, remember when
// each device last spoke, and raise a flag when one has been silent for longer
// than it should. No battery level involved — a Zigbee battery percentage is a
// coarse estimate that commonly reads 100% right up to the day the sensor stops
// answering, so it cannot tell you that a device died. Silence can.
//
// Role of this file: wiring only. The decision logic lives in `src/monitor.js`,
// the MQTT plumbing in `src/mqttClient.js`, the Gladys payloads in
// `src/devices/`. This file connects them and owns the timers.
//
// Environment variables provided by the Gladys supervisor to the container:
//   - GLADYS_HOST_API_URL         (host API URL)
//   - GLADYS_INTEGRATION_TOKEN    (integration-scoped JWT)
//   - GLADYS_INTEGRATION_SELECTOR (integration identifier)
// The SDK reads them automatically: `new GladysIntegration()` is enough.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { listSilentDevices, refreshDevices, testConnection } from './src/actions.js';
import { normalizeConfig } from './src/config.js';
import { buildAllStates, buildDiscoveredDevices } from './src/devices/index.js';
import { LastSeenStore } from './src/lastSeenStore.js';
import { routeMessage } from './src/messageRouter.js';
import { MqttConnection, sameBrokerConfig } from './src/mqttClient.js';
import { DevicesMonitor } from './src/monitor.js';
import { StatePublisher } from './src/statePublisher.js';

// Zigbee2MQTT republishes its whole inventory on any change; coalesce the bursts
// (a re-pairing emits several in a row) into a single discovery publish.
const DISCOVERY_DEBOUNCE_MS = 2000;
// Adding devices from the Discovery screen is a series of clicks: coalesce them
// into one states publish instead of one per device.
const DEVICE_CREATED_DEBOUNCE_MS = 1000;
// The last-seen history only has to survive a restart, not every single report.
const PERSIST_INTERVAL_MS = 5 * 60 * 1000;
// How long we wait for `bridge/devices` before telling the user the base topic
// is probably wrong.
const INVENTORY_GRACE_MS = 30 * 1000;

const gladys = new GladysIntegration();

let config = normalizeConfig();
const monitor = new DevicesMonitor({ config });
const store = new LastSeenStore();
const publisher = new StatePublisher({ gladys });

/** @type {MqttConnection | null} */
let mqtt = null;
let tickTimer = null;
let discoveryTimer = null;
let deviceCreatedTimer = null;
let persistTimer = null;
/** @type {Set<string>} External ids of the devices the user just created. */
const createdDevices = new Set();
let mqttStartedAt = null;
let lastConnectionStatus = null;
let historyRestored = false;

// --- Discovery: Gladys asks for the list of devices --------------------------
gladys.onScanRequest(async () => {
  logger.info('onScanRequest -> publishing discovered devices');
  await publishDevices();
});

// --- The user added one of the discovered devices ----------------------------
// Gladys drops the states of a feature that does not exist yet, and this
// integration publishes its whole network from its very first tick — long
// before anything is added from the Discovery screen. So everything published
// until this moment went nowhere, while the publisher considers it delivered:
// without this handler a device added by the user reads "no recent value" until
// the periodic refresh comes round, up to half an hour later.
gladys.onDeviceCreated((device) => {
  logger.info(`onDeviceCreated -> ${device?.external_id}`);
  scheduleCreatedDevicePublish(device);
});

// Same reasoning: Gladys sends this when the user edits the device, and an
// edited feature can be a brand new one (the SDK republishes the whole device).
gladys.onDeviceUpdated((device) => {
  logger.info(`onDeviceUpdated -> ${device?.external_id}`);
  scheduleCreatedDevicePublish(device);
});

// --- Manifest actions: buttons in the Configuration screen -------------------
gladys.onAction('test_connection', () => testConnection({ mqtt, monitor, config }));
gladys.onAction('list_silent_devices', () => listSilentDevices({ monitor }));
gladys.onAction('refresh_devices', () => refreshDevices({ monitor, publishDevices }));

// --- Configuration updated by the user ---------------------------------------
gladys.onConfigUpdated(async (newConfig) => {
  logger.info('onConfigUpdated -> new configuration received');
  const previousConfig = config;
  config = normalizeConfig(newConfig);
  monitor.setConfig(config);

  // Only a change of broker, credentials or base topic justifies dropping the
  // MQTT session; new thresholds apply on the next tick for free.
  if (mqtt && !sameBrokerConfig(previousConfig, config)) {
    logger.info('Broker configuration changed -> reconnecting');
    await mqtt.stop();
    mqtt = null;
    startMqtt();
  }

  // The ignore list changes who is discovered, and the thresholds change every
  // verdict: republish both lists.
  await publishDevices();
  await publishStates();
});

// --- Connection lifecycle ----------------------------------------------------
// The SDK logs the WebSocket lifecycle itself (under `gladys-sdk`); these
// handlers only run the integration's own (re)initialization.
gladys.on('connected', async () => {
  try {
    // 1) Fetch the configuration filled in by the user.
    config = normalizeConfig(await gladys.getConfig());
    monitor.setConfig(config);

    // 2) Replay the last-seen history persisted by the previous run — once:
    //    a Gladys reconnection must not rewind what we learned since.
    if (!historyRestored) {
      monitor.restore(await store.load());
      historyRestored = true;
    }

    // 3) (Re)connect to the MQTT broker Zigbee2MQTT publishes on.
    startMqtt();

    // 4) Gladys resynchronized on its side: push the full picture again.
    publisher.reset();
    await publishDevices();
    await publishStates();

    // 5) Run the watchdog.
    startTimers();
  } catch (err) {
    logger.error('Post-connection initialization failed', err);
    await gladys
      .setConnectionStatus(false, {
        en: 'Initialization failed, check the integration logs.',
        fr: "L'initialisation a échoué, consultez les logs de l'intégration.",
      })
      .catch(() => {});
  }
});

gladys.on('disconnected', () => {
  // Keep the MQTT session and the last-seen history: Gladys being unreachable
  // says nothing about the Zigbee network, and dropping the history here would
  // hand every device a fresh threshold on reconnection.
  stopTimers();
});

// --- MQTT ---------------------------------------------------------------------

/** Open the MQTT connection, unless one is already running. */
function startMqtt() {
  if (mqtt) {
    return;
  }
  mqttStartedAt = Date.now();
  mqtt = new MqttConnection({
    config,
    onMessage: handleMqttMessage,
    onStatusChange: () => {
      refreshConnectionStatus().catch((err) =>
        logger.error('Failed to report the connection status', err),
      );
    },
  });
  mqtt.start();
}

/**
 * Route one MQTT message to the monitor.
 * @param {string} topic - Full MQTT topic.
 * @param {Buffer} payload - Raw payload.
 * @param {{retained: boolean}} meta - Message metadata.
 */
function handleMqttMessage(topic, payload, { retained }) {
  const { inventoryUpdated } = routeMessage({
    monitor,
    baseTopic: config.base_topic,
    topic,
    payload,
    retained,
  });
  if (inventoryUpdated) {
    scheduleDiscoveryPublish();
  }
}

// --- Publishing ----------------------------------------------------------------

/**
 * Publish the discovery list to Gladys.
 * @returns {Promise<number>} How many devices were published.
 */
async function publishDevices() {
  const devices = buildDiscoveredDevices(gladys, monitor.snapshot(), config);
  // Zigbee2MQTT keeps talking while Gladys is unreachable; publishing then would
  // only fill the logs with failures. The reconnection republishes everything.
  if (!gladys.connected) {
    logger.debug('Gladys is disconnected, skipping the discovery publish');
    return devices.length;
  }
  await gladys.publishDiscoveredDevices(devices);
  logger.info(`Published ${devices.length} discovered device(s)`);
  return devices.length;
}

/** Evaluate every device and publish what changed. */
async function publishStates() {
  if (!gladys.connected) {
    return;
  }
  const snapshot = monitor.snapshot();
  const published = await publisher.publish(buildAllStates(gladys, snapshot));
  if (published > 0) {
    logger.debug(
      `${snapshot.summary.silent}/${snapshot.summary.monitored} device(s) silent, ${published} state(s) published`,
    );
  }
}

/**
 * Republish the states of the devices the user just created, coalescing the
 * clicks of a Discovery screen session into a single publish.
 * @param {{external_id?: string} | undefined} device - The device Gladys just created or updated.
 */
function scheduleCreatedDevicePublish(device) {
  if (!device?.external_id) {
    return;
  }
  createdDevices.add(device.external_id);
  clearTimeout(deviceCreatedTimer);
  deviceCreatedTimer = setTimeout(() => {
    for (const externalId of createdDevices) {
      publisher.forgetDevice(externalId);
    }
    createdDevices.clear();
    publishStates().catch((err) =>
      logger.error('Failed to publish the states of the new device(s)', err),
    );
  }, DEVICE_CREATED_DEBOUNCE_MS);
}

/** Coalesce the inventory bursts into a single discovery publish. */
function scheduleDiscoveryPublish() {
  clearTimeout(discoveryTimer);
  discoveryTimer = setTimeout(() => {
    publishDevices()
      .then(() => publishStates())
      .catch((err) => logger.error('Failed to publish the discovered devices', err));
  }, DISCOVERY_DEBOUNCE_MS);
}

/**
 * Report the application-level status shown in the Configuration screen —
 * distinct from the container state machine: this integration can be RUNNING and
 * still unable to reach the MQTT broker.
 */
async function refreshConnectionStatus() {
  const status = buildConnectionStatus();
  // Republishing the same status on every tick would be pure noise — but a
  // different REASON for the same failure is worth showing.
  const signature = `${status.connected}:${status.message?.en ?? ''}`;
  if (signature === lastConnectionStatus) {
    return;
  }
  lastConnectionStatus = signature;
  await gladys.setConnectionStatus(status.connected, status.message);
}

/**
 * Decide what to report as the application-level status.
 * @returns {{connected: boolean, message?: {en: string, fr: string}}} The status to publish.
 */
function buildConnectionStatus() {
  if (!mqtt?.connected) {
    const reason = mqtt?.lastError ? ` (${mqtt.lastError.message})` : '';
    return {
      connected: false,
      message: {
        en: `Cannot reach the MQTT broker at ${config.mqtt_url}${reason}.`,
        fr: `Broker MQTT injoignable sur ${config.mqtt_url}${reason}.`,
      },
    };
  }
  const waitedLongEnough = Date.now() - (mqttStartedAt ?? Date.now()) > INVENTORY_GRACE_MS;
  if (!monitor.inventoryReceivedAt && waitedLongEnough) {
    return {
      connected: false,
      message: {
        en: `Connected, but nothing on ${config.base_topic}/bridge/devices. Check the Zigbee2MQTT base topic.`,
        fr: `Connecté, mais rien sur ${config.base_topic}/bridge/devices. Vérifiez le topic de base de Zigbee2MQTT.`,
      },
    };
  }
  return { connected: true };
}

// --- Timers --------------------------------------------------------------------

/** Start the watchdog tick and the periodic persistence. */
function startTimers() {
  stopTimers();
  tickTimer = setInterval(() => {
    Promise.all([publishStates(), refreshConnectionStatus()]).catch((err) =>
      logger.error('Watchdog tick failed', err),
    );
  }, config.check_interval_seconds * 1000);

  persistTimer = setInterval(() => {
    store.save(monitor.serialize()).catch(() => {});
  }, PERSIST_INTERVAL_MS);
}

/** Stop the timers (Gladys disconnected, or the container is shutting down). */
function stopTimers() {
  clearInterval(tickTimer);
  clearInterval(persistTimer);
  clearTimeout(discoveryTimer);
  clearTimeout(deviceCreatedTimer);
  tickTimer = null;
  persistTimer = null;
  discoveryTimer = null;
  deviceCreatedTimer = null;
  // Whatever was pending is covered by the full republish of the reconnection.
  createdDevices.clear();
}

// --- Graceful shutdown ---------------------------------------------------------
// The SDK disconnects cleanly and exits with code 0 when the supervisor stops the
// container (SIGTERM/SIGINT). Persisting here is what lets the next run pick the
// silence counters back up where they were.
gladys.handleShutdown(async (signal) => {
  logger.info(`Received ${signal} -> graceful shutdown`);
  stopTimers();
  await store.save(monitor.serialize()).catch(() => {});
  await mqtt?.stop().catch(() => {});
});

// --- Startup -------------------------------------------------------------------
logger.info('Starting the Z2M Devices Monitor integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
