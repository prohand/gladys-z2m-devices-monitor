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
import {
  ConnectionStatusReporter,
  INITIALIZATION_FAILED_STATUS,
  buildConnectionStatus,
} from './src/connectionStatus.js';
import { buildAllStates, buildDiscoveredDevices } from './src/devices/index.js';
import { LastSeenStore } from './src/lastSeenStore.js';
import { routeMessage } from './src/messageRouter.js';
import { MqttConnection, sameBrokerConfig } from './src/mqttClient.js';
import { DevicesMonitor } from './src/monitor.js';
import { SCENE_ACTION, buildSceneEvents, getDeviceStatus, getSilentDevices } from './src/scenes.js';
import { singleFlight } from './src/singleFlight.js';
import { StatePublisher } from './src/statePublisher.js';
import { AliveTransitions } from './src/transitions.js';
import { WIDGET, buildNetworkHealthWidget, networkHealthSignature } from './src/widget.js';

// Zigbee2MQTT republishes its whole inventory on any change; coalesce the bursts
// (a re-pairing emits several in a row) into a single discovery publish.
const DISCOVERY_DEBOUNCE_MS = 2000;
// Adding devices from the Discovery screen is a series of clicks: coalesce them
// into one states publish instead of one per device.
const DEVICE_CREATED_DEBOUNCE_MS = 1000;
// The last-seen history only has to survive a restart, not every single report.
const PERSIST_INTERVAL_MS = 5 * 60 * 1000;

const gladys = new GladysIntegration();

let config = normalizeConfig();
const monitor = new DevicesMonitor({ config });
const store = new LastSeenStore();
const publisher = new StatePublisher({ gladys });
const transitions = new AliveTransitions();
const statusReporter = new ConnectionStatusReporter({ gladys });

/** @type {MqttConnection | null} */
let mqtt = null;
let tickTimer = null;
let discoveryTimer = null;
let deviceCreatedTimer = null;
let persistTimer = null;
/** @type {Set<string>} External ids of the devices the user just created. */
const createdDevices = new Set();
let mqttStartedAt = null;
let widgetSignature = null;
// True until the configuration was read from Gladys at least once: before that,
// `config` holds the defaults and the broker must not be dialed with them.
let configLoaded = false;
// The discovery list must be (re)published on the next pass.
let discoveryDirty = true;
let discoveredCount = 0;

// Every publication goes through ONE pass, never two at a time: see
// `src/singleFlight.js` for what interleaved passes used to cost.
const runPublishPass = singleFlight(publishPass);
const loadConfiguration = singleFlight(fetchConfiguration);

// --- Discovery: Gladys asks for the list of devices --------------------------
gladys.onScanRequest(async () => {
  logger.info('onScanRequest -> publishing discovered devices');
  await requestPublish({ discovery: true });
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
gladys.onAction('refresh_devices', () =>
  refreshDevices({
    monitor,
    publishDevices: async () => {
      await requestPublish({ discovery: true });
      return discoveredCount;
    },
  }),
);

// --- Scene actions: blocks of the Gladys scene editor (Gladys >= 5.1.0) ------
// Read-only answers from the monitor. Never fire a scene event from here: a
// scene bound to that event would loop through the integration.
gladys.onSceneAction(SCENE_ACTION.GET_SILENT_DEVICES, (fields) =>
  getSilentDevices({ monitor, config }, fields),
);
gladys.onSceneAction(SCENE_ACTION.GET_DEVICE_STATUS, (fields) =>
  getDeviceStatus({ gladys, monitor }, fields),
);

// --- Dashboard widget (Gladys >= 5.1.0) ---------------------------------------
gladys.onWidgetGet(WIDGET.NETWORK_HEALTH, ({ settings }) =>
  buildNetworkHealthWidget(monitor.snapshot(), settings),
);

// --- Configuration updated by the user ---------------------------------------
gladys.onConfigUpdated(async (newConfig) => {
  logger.info('onConfigUpdated -> new configuration received');
  await applyConfig(newConfig);
  // The ignore list changes who is discovered, and the thresholds change every
  // verdict: republish both lists.
  await requestPublish({ discovery: true });
});

// --- Connection lifecycle ----------------------------------------------------
// The SDK logs the WebSocket lifecycle itself (under `gladys-sdk`); these
// handlers only run the integration's own (re)initialization.
gladys.on('connected', async () => {
  // Gladys resynchronized on its side: push the full picture again, status
  // included.
  statusReporter.reset();
  publisher.reset();
  discoveryDirty = true;

  // The watchdog is armed FIRST: whatever fails below (a 429 or a 5xx from the
  // host API on the full republication, a configuration that cannot be read
  // yet), the next tick retries it. Armed last, one transient failure left a
  // reconnected integration with no watchdog at all until the next reconnection.
  startTimers();

  try {
    await loadConfiguration();
    await requestPublish();
    // A session opened just now reports itself once subscribed; reporting it
    // here would flash "cannot reach the broker" while it is still dialing.
    if (mqtt?.connected) {
      await refreshConnectionStatus();
    }
  } catch (err) {
    logger.error('Post-connection initialization failed, retrying on the next tick', err);
    await statusReporter.report(INITIALIZATION_FAILED_STATUS).catch(() => {});
  }
});

gladys.on('disconnected', () => {
  // Keep the MQTT session, the last-seen history AND its persistence: Gladys
  // being unreachable says nothing about the Zigbee network, which keeps
  // talking — dropping or no longer saving what it says would hand every device
  // a fresh threshold after a restart.
  stopTimers();
});

// --- Configuration ---------------------------------------------------------------

/**
 * Read the configuration from Gladys and apply it (single-flight: the
 * reconnection and a tick retrying a failed one never interleave).
 * @returns {Promise<void>} Resolves once the configuration is applied.
 */
async function fetchConfiguration() {
  await applyConfig(await gladys.getConfig());
}

/**
 * Apply a configuration: thresholds, broker session, watchdog interval.
 * @param {Record<string, unknown>} rawConfig - Configuration as the SDK hands it.
 * @returns {Promise<void>} Resolves once the MQTT session follows the new configuration.
 */
async function applyConfig(rawConfig) {
  const previousConfig = config;
  config = normalizeConfig(rawConfig);
  configLoaded = true;
  monitor.setConfig(config);

  // Only a change of broker, credentials or base topic justifies dropping the
  // MQTT session; new thresholds apply on the next tick for free.
  if (mqtt && !sameBrokerConfig(previousConfig, config)) {
    logger.info('Broker configuration changed -> reconnecting');
    const previous = mqtt;
    mqtt = null;
    monitor.setListening(false);
    await previous.stop();
  }
  startMqtt();

  // The watchdog interval is read when the timer is armed: re-arm it, or a new
  // `check_interval_seconds` would only apply after the next reconnection.
  if (tickTimer && previousConfig.check_interval_seconds !== config.check_interval_seconds) {
    startTickTimer();
  }
}

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
    onStatusChange: (connected) => {
      // The monitor forgives the silence of an outage: it has to know when one
      // begins and ends (see `DevicesMonitor.setListening`).
      monitor.setListening(connected);
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
 * Ask for a publish pass; resolves once a pass that started AFTER this request
 * is over (see `src/singleFlight.js`).
 * @param {object} [options] - Options.
 * @param {boolean} [options.discovery] - Republish the discovery list too.
 * @returns {Promise<void>} Resolves once the pass is over, rejects when it failed.
 */
function requestPublish({ discovery = false } = {}) {
  if (discovery) {
    discoveryDirty = true;
  }
  return runPublishPass();
}

/**
 * One publish pass: the discovery list when it is due, then the states, the
 * scene events and the widget nudge.
 *
 * A failed discovery publish stays due (the next pass retries it) and does not
 * hold the states back — `Alive` is the alert; its error is rethrown once the
 * states are out, so a button waiting on it still reports the failure.
 * @returns {Promise<void>} Resolves once everything due was published.
 */
async function publishPass() {
  // Zigbee2MQTT keeps talking while Gladys is unreachable; publishing then would
  // only fill the logs with failures. The reconnection republishes everything.
  if (!gladys.connected || !configLoaded) {
    return;
  }
  let discoveryError = null;
  if (discoveryDirty) {
    discoveryDirty = false;
    try {
      await publishDevices();
    } catch (err) {
      discoveryDirty = true;
      discoveryError = err;
    }
  }
  await publishStates();
  if (discoveryError) {
    throw discoveryError;
  }
}

/**
 * Publish the discovery list to Gladys.
 * @returns {Promise<number>} How many devices were published.
 */
async function publishDevices() {
  const devices = buildDiscoveredDevices(gladys, monitor.snapshot(), config);
  await gladys.publishDiscoveredDevices(devices);
  discoveredCount = devices.length;
  logger.info(`Published ${devices.length} discovered device(s)`);
  return devices.length;
}

/**
 * Evaluate every device and publish what changed: the states, then the scene
 * events, then the widget nudge.
 */
async function publishStates() {
  const snapshot = monitor.snapshot();
  const published = await publisher.publish(buildAllStates(gladys, snapshot, config));
  if (published > 0) {
    logger.debug(
      `${snapshot.summary.silent}/${snapshot.summary.monitored} device(s) silent, ${published} state(s) published`,
    );
  }
  // After the states: a scene started by the event that reads the `Alive`
  // feature must already find the new value.
  await publishSceneEvents(snapshot);
  refreshWidget(snapshot);
}

/**
 * Fire the scene triggers for the devices whose verdict just flipped.
 * @param {object} snapshot - A `DevicesMonitor.snapshot()` result.
 */
async function publishSceneEvents(snapshot) {
  const flips = transitions.diff(snapshot, { listening: Boolean(mqtt?.connected) });
  for (const { key, data } of buildSceneEvents(gladys, flips)) {
    // Not retried: the verdict has moved on, and a replay later would announce
    // a silence that may be over. One failure must not cost the other events.
    await gladys
      .publishSceneEvent(key, data)
      .catch((err) => logger.error(`Failed to fire "${key}" for ${data.device_name}`, err));
  }
}

/**
 * Ask the open dashboards to re-pull the widget, only when what it shows
 * changed (the core rate-limits the nudge anyway, 1 per 10 s).
 * @param {object} snapshot - A `DevicesMonitor.snapshot()` result.
 */
function refreshWidget(snapshot) {
  const signature = networkHealthSignature(snapshot);
  if (signature !== widgetSignature) {
    widgetSignature = signature;
    gladys.requestWidgetRefresh(WIDGET.NETWORK_HEALTH);
  }
}

/**
 * What the `/data` file holds.
 * @returns {import('./src/lastSeenStore.js').PersistedHistory} The history to persist.
 */
function persistedHistory() {
  return {
    devices: monitor.serialize(),
    verdicts: transitions.serialize(),
    heardAt: monitor.lastHeardAt(),
  };
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
    requestPublish().catch((err) =>
      logger.error('Failed to publish the states of the new device(s)', err),
    );
  }, DEVICE_CREATED_DEBOUNCE_MS);
}

/** Coalesce the inventory bursts into a single discovery publish. */
function scheduleDiscoveryPublish() {
  clearTimeout(discoveryTimer);
  discoveryTimer = setTimeout(() => {
    requestPublish({ discovery: true }).catch((err) =>
      logger.error('Failed to publish the discovered devices', err),
    );
  }, DISCOVERY_DEBOUNCE_MS);
}

/**
 * Report the application-level status shown in the Configuration screen (the
 * decision and its dedupe live in `src/connectionStatus.js`).
 * @returns {Promise<boolean>} True when a new status was sent.
 */
function refreshConnectionStatus() {
  return statusReporter.report(
    buildConnectionStatus({ mqtt, monitor, config, mqttStartedAt, now: Date.now() }),
  );
}

// --- Timers --------------------------------------------------------------------

/** Start the watchdog tick (it needs Gladys: it publishes). */
function startTimers() {
  stopTimers();
  startTickTimer();
}

/**
 * Replay the last-seen history and the last verdicts persisted by the previous
 * run, then save them periodically for the life of the container.
 *
 * Both happen once, at boot, independently of the Gladys WebSocket: the MQTT
 * session survives a Gladys outage and keeps recording signs of life, and
 * those have to reach `/data` too — a restart in the middle of a long Gladys
 * outage would otherwise lose everything heard since it began. Restoring
 * BEFORE the first save is what keeps that first save from overwriting the
 * file with an empty history.
 * @returns {Promise<void>} Resolves once the history is restored.
 */
async function startPersistence() {
  const history = await store.load();
  monitor.restore(history.devices, { heardAt: history.heardAt });
  transitions.restore(history.verdicts);
  persistTimer = setInterval(() => {
    store.save(persistedHistory()).catch(() => {});
  }, PERSIST_INTERVAL_MS);
}

/** (Re)arm the watchdog tick alone, at the configured interval. */
function startTickTimer() {
  clearInterval(tickTimer);
  tickTimer = setInterval(() => {
    tick().catch((err) => logger.error('Watchdog tick failed', err));
  }, config.check_interval_seconds * 1000);
}

/**
 * One watchdog tick: finish an initialization that failed, publish, then
 * report the status — after the pass, so a failure status set by a failed
 * initialization is only replaced once publishing works again.
 * @returns {Promise<void>} Resolves once the tick is done.
 */
async function tick() {
  if (!configLoaded) {
    await loadConfiguration();
  }
  await requestPublish();
  await refreshConnectionStatus();
}

/** Stop the Gladys-bound timers (Gladys disconnected, or the container is shutting down). */
function stopTimers() {
  clearInterval(tickTimer);
  clearTimeout(discoveryTimer);
  clearTimeout(deviceCreatedTimer);
  tickTimer = null;
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
  clearInterval(persistTimer);
  await store.save(persistedHistory()).catch(() => {});
  await mqtt?.stop().catch(() => {});
});

// --- Startup -------------------------------------------------------------------
logger.info('Starting the Z2M Devices Monitor integration...');
startPersistence()
  .then(() => gladys.connect())
  .catch((err) => {
    logger.error('Initial connection failed', err);
    process.exit(1);
  });
