// -----------------------------------------------------------------------------
// Handlers of the manifest `actions`: the buttons of the Configuration screen.
//
// They exist because the two questions a user asks while setting this up cannot
// be answered by the form itself: "is my broker configuration right?" and "what
// does the monitor think of my network right now?". Each handler resolves a
// multi-language message, displayed under its button.
// -----------------------------------------------------------------------------

import { isBatteryPowered } from './monitor.js';

// Enough to be useful in the small box under the button, short enough to stay
// readable; the full picture lives on the device screens.
const MAX_LISTED_DEVICES = 15;

/**
 * `test_connection`: report what the running integration actually sees — the
 * broker session, the Zigbee2MQTT inventory and the traffic — instead of opening
 * a second connection that would prove nothing about the live one.
 * @param {object} context - Runtime context.
 * @param {import('./mqttClient.js').MqttConnection | null} context.mqtt - The live MQTT connection.
 * @param {import('./monitor.js').DevicesMonitor} context.monitor - The monitor.
 * @param {Record<string, unknown>} context.config - Normalized configuration.
 * @returns {{en: string, fr: string}} The message shown under the button.
 */
export function testConnection({ mqtt, monitor, config }) {
  if (!mqtt) {
    return {
      en: 'The monitor is not started yet, try again in a few seconds.',
      fr: "Le moniteur n'est pas encore démarré, réessayez dans quelques secondes.",
    };
  }

  if (!mqtt.connected) {
    // `reconnect()` is instant, so the next click reflects the retry.
    mqtt.reconnectNow();
    const reason = mqtt.lastError ? ` (${mqtt.lastError.message})` : '';
    return {
      en: `Not connected to ${config.mqtt_url}${reason}. Check the URL, the credentials and that the broker is reachable from Gladys.`,
      fr: `Non connecté à ${config.mqtt_url}${reason}. Vérifiez l'URL, les identifiants et que le broker est joignable depuis Gladys.`,
    };
  }

  const snapshot = monitor.snapshot();
  if (!snapshot.summary.inventoryReceived) {
    return {
      en: `Connected to ${config.mqtt_url}, but nothing was received on ${config.base_topic}/bridge/devices. Check the base topic configured in Zigbee2MQTT.`,
      fr: `Connecté à ${config.mqtt_url}, mais rien reçu sur ${config.base_topic}/bridge/devices. Vérifiez le topic de base configuré dans Zigbee2MQTT.`,
    };
  }

  const { monitored, silent } = snapshot.summary;
  const bridge = describeBridge(snapshot.summary.bridgeOnline);
  return {
    en: `Connected to ${config.mqtt_url}. ${monitored} device(s) watched, ${silent} silent, ${mqtt.messagesReceived} message(s) received. Zigbee2MQTT bridge: ${bridge.en}.`,
    fr: `Connecté à ${config.mqtt_url}. ${monitored} appareil(s) surveillé(s), ${silent} silencieux, ${mqtt.messagesReceived} message(s) reçu(s). Bridge Zigbee2MQTT : ${bridge.fr}.`,
  };
}

/**
 * `list_silent_devices`: name the devices currently past their threshold, with
 * how long they have been quiet — the answer to "who do I go and check?".
 * @param {object} context - Runtime context.
 * @param {import('./monitor.js').DevicesMonitor} context.monitor - The monitor.
 * @returns {{en: string, fr: string}} The message shown under the button.
 */
export function listSilentDevices({ monitor }) {
  const snapshot = monitor.snapshot();
  if (!snapshot.summary.inventoryReceived) {
    return {
      en: 'The Zigbee2MQTT device inventory has not been received yet.',
      fr: "L'inventaire des appareils Zigbee2MQTT n'a pas encore été reçu.",
    };
  }

  const silent = snapshot.summary.silentDevices;
  if (silent.length === 0) {
    return {
      en: `All ${snapshot.summary.monitored} watched device(s) are giving signs of life.`,
      fr: `Les ${snapshot.summary.monitored} appareil(s) surveillé(s) donnent tous signe de vie.`,
    };
  }

  const listed = silent.slice(0, MAX_LISTED_DEVICES);
  const remaining = silent.length - listed.length;
  const suffix = remaining > 0 ? `, +${remaining}` : '';

  return {
    en: `${silent.length} silent device(s): ${listed.map((device) => describeSilentDevice(device, 'en')).join(', ')}${suffix}.`,
    fr: `${silent.length} appareil(s) silencieux : ${listed.map((device) => describeSilentDevice(device, 'fr')).join(', ')}${suffix}.`,
  };
}

/**
 * `refresh_devices`: re-publish the discovery list, for when a device was paired
 * or renamed in Zigbee2MQTT and the user does not want to wait.
 * @param {object} context - Runtime context.
 * @param {import('./monitor.js').DevicesMonitor} context.monitor - The monitor.
 * @param {() => Promise<number>} context.publishDevices - Publishes the discovery list, resolving the device count.
 * @returns {Promise<{en: string, fr: string}>} The message shown under the button.
 */
export async function refreshDevices({ monitor, publishDevices }) {
  const snapshot = monitor.snapshot();
  if (!snapshot.summary.inventoryReceived) {
    return {
      en: 'The Zigbee2MQTT device inventory has not been received yet: nothing to publish.',
      fr: "L'inventaire des appareils Zigbee2MQTT n'a pas encore été reçu : rien à publier.",
    };
  }
  const count = await publishDevices();
  return {
    en: `${count} device(s) published to Gladys.`,
    fr: `${count} appareil(s) publié(s) vers Gladys.`,
  };
}

/**
 * Describe one silent device: how long it has been quiet, against how long it
 * was allowed to be.
 * @param {object} device - Device entry of a monitor snapshot.
 * @param {'en'|'fr'} language - Output language.
 * @returns {string} A short description.
 */
function describeSilentDevice(device, language) {
  const never = language === 'en' ? 'never seen' : 'jamais vu';
  const since = device.neverSeen ? never : formatDuration(device.silenceMinutes, language);
  const power = isBatteryPowered(device) ? (language === 'en' ? 'battery' : 'pile') : null;
  const details = [since, power].filter(Boolean).join(', ');
  return `${device.friendlyName} (${details})`;
}

/**
 * Format a duration in minutes as a compact human string.
 * @param {number} minutes - Duration in minutes.
 * @param {'en'|'fr'} language - Output language.
 * @returns {string} e.g. "3 d 4 h", "5 h 12 min", "42 min".
 */
export function formatDuration(minutes, language = 'en') {
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const remainder = Math.floor(minutes % 60);
  const dayUnit = language === 'en' ? 'd' : 'j';
  if (days > 0) {
    return `${days} ${dayUnit} ${hours} h`;
  }
  if (hours > 0) {
    return `${hours} h ${remainder} min`;
  }
  return `${remainder} min`;
}

/**
 * Describe the bridge state, including the "we have not heard from it" case.
 * @param {boolean|null} bridgeOnline - Bridge state held by the monitor.
 * @returns {{en: string, fr: string}} A short multi-language label.
 */
function describeBridge(bridgeOnline) {
  if (bridgeOnline === null) {
    return { en: 'unknown', fr: 'inconnu' };
  }
  return bridgeOnline ? { en: 'online', fr: 'en ligne' } : { en: 'offline', fr: 'hors ligne' };
}
