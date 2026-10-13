// -----------------------------------------------------------------------------
// Handlers of the manifest `actions`: the buttons of the Configuration screen.
//
// They exist because the two questions a user asks while setting this up cannot
// be answered by the form itself: "is my broker configuration right?" and "what
// does the monitor think of my network right now?". Each handler resolves a
// multi-language message, displayed under its button.
// -----------------------------------------------------------------------------

import { redactBrokerUrl } from './config.js';
import { NEVER_SEEN, describeBridge, formatDuration } from './format.js';
import { isBatteryPowered } from './monitor.js';

// Enough to be useful in the small box under the button, short enough to stay
// readable; the full picture lives on the device screens.
const MAX_LISTED_DEVICES = 15;

// How a battery device is tagged in the list, in every language of `LANGUAGES`.
const BATTERY = { en: 'battery', fr: 'pile', de: 'Batterie', es: 'pilas' };

/**
 * `test_connection`: report what the running integration actually sees — the
 * broker session, the Zigbee2MQTT inventory and the traffic — instead of opening
 * a second connection that would prove nothing about the live one.
 * @param {object} context - Runtime context.
 * @param {import('./mqttClient.js').MqttConnection | null} context.mqtt - The live MQTT connection.
 * @param {import('./monitor.js').DevicesMonitor} context.monitor - The monitor.
 * @param {Record<string, unknown>} context.config - Normalized configuration.
 * @returns {import('./format.js').LocalizedText} The message shown under the button.
 */
export function testConnection({ mqtt, monitor, config }) {
  // Never quote credentials typed into the URL (`mqtt://user:pass@host`).
  const url = redactBrokerUrl(config.mqtt_url);
  if (!mqtt) {
    return {
      en: 'The monitor is not started yet, try again in a few seconds.',
      fr: "Le moniteur n'est pas encore démarré, réessayez dans quelques secondes.",
      de: 'Der Monitor ist noch nicht gestartet, versuche es in ein paar Sekunden erneut.',
      es: 'El monitor aún no se ha iniciado, vuelva a intentarlo en unos segundos.',
    };
  }

  if (!mqtt.connected) {
    // `reconnect()` is instant, so the next click reflects the retry.
    mqtt.reconnectNow();
    const reason = mqtt.lastError ? ` (${mqtt.lastError.message})` : '';
    return {
      en: `Not connected to ${url}${reason}. Check the URL, the credentials and that the broker is reachable from Gladys.`,
      fr: `Non connecté à ${url}${reason}. Vérifiez l'URL, les identifiants et que le broker est joignable depuis Gladys.`,
      de: `Nicht verbunden mit ${url}${reason}. Prüfe die URL, die Zugangsdaten und ob der Broker von Gladys aus erreichbar ist.`,
      es: `No conectado a ${url}${reason}. Compruebe la URL, las credenciales y que el broker sea accesible desde Gladys.`,
    };
  }

  const snapshot = monitor.snapshot();
  if (!snapshot.summary.inventoryReceived) {
    return {
      en: `Connected to ${url}, but nothing was received on ${config.base_topic}/bridge/devices. Check the base topic configured in Zigbee2MQTT.`,
      fr: `Connecté à ${url}, mais rien reçu sur ${config.base_topic}/bridge/devices. Vérifiez le topic de base configuré dans Zigbee2MQTT.`,
      de: `Verbunden mit ${url}, aber nichts auf ${config.base_topic}/bridge/devices empfangen. Prüfe das in Zigbee2MQTT konfigurierte Basis-Topic.`,
      es: `Conectado a ${url}, pero no se ha recibido nada en ${config.base_topic}/bridge/devices. Compruebe el topic base configurado en Zigbee2MQTT.`,
    };
  }

  const { monitored, silent } = snapshot.summary;
  const bridge = describeBridge(snapshot.summary.bridgeOnline);
  return {
    en: `Connected to ${url}. ${monitored} device(s) watched, ${silent} silent, ${mqtt.messagesReceived} message(s) received. Zigbee2MQTT bridge: ${bridge.en}.`,
    fr: `Connecté à ${url}. ${monitored} appareil(s) surveillé(s), ${silent} silencieux, ${mqtt.messagesReceived} message(s) reçu(s). Bridge Zigbee2MQTT : ${bridge.fr}.`,
    de: `Verbunden mit ${url}. ${monitored} Gerät(e) überwacht, ${silent} stumm, ${mqtt.messagesReceived} Nachricht(en) empfangen. Zigbee2MQTT-Bridge: ${bridge.de}.`,
    es: `Conectado a ${url}. ${monitored} dispositivo(s) vigilado(s), ${silent} en silencio, ${mqtt.messagesReceived} mensaje(s) recibido(s). Bridge Zigbee2MQTT: ${bridge.es}.`,
  };
}

/**
 * `list_silent_devices`: name the devices currently past their threshold, with
 * how long they have been quiet — the answer to "who do I go and check?".
 * @param {object} context - Runtime context.
 * @param {import('./monitor.js').DevicesMonitor} context.monitor - The monitor.
 * @returns {import('./format.js').LocalizedText} The message shown under the button.
 */
export function listSilentDevices({ monitor }) {
  const snapshot = monitor.snapshot();
  if (!snapshot.summary.inventoryReceived) {
    return {
      en: 'The Zigbee2MQTT device inventory has not been received yet.',
      fr: "L'inventaire des appareils Zigbee2MQTT n'a pas encore été reçu.",
      de: 'Das Geräteinventar von Zigbee2MQTT wurde noch nicht empfangen.',
      es: 'Todavía no se ha recibido el inventario de dispositivos de Zigbee2MQTT.',
    };
  }

  const silent = snapshot.summary.silentDevices;
  if (silent.length === 0) {
    return {
      en: `All ${snapshot.summary.monitored} watched device(s) are giving signs of life.`,
      fr: `Les ${snapshot.summary.monitored} appareil(s) surveillé(s) donnent tous signe de vie.`,
      de: `Alle überwachten Geräte (${snapshot.summary.monitored}) geben Lebenszeichen.`,
      es: `Todos los dispositivos vigilados (${snapshot.summary.monitored}) dan señales de vida.`,
    };
  }

  const listed = silent.slice(0, MAX_LISTED_DEVICES);
  const remaining = silent.length - listed.length;
  const suffix = remaining > 0 ? `, +${remaining}` : '';

  const names = (language) =>
    `${listed.map((device) => describeSilentDevice(device, language)).join(', ')}${suffix}`;
  return {
    en: `${silent.length} silent device(s): ${names('en')}.`,
    fr: `${silent.length} appareil(s) silencieux : ${names('fr')}.`,
    de: `${silent.length} stumme(s) Gerät(e): ${names('de')}.`,
    es: `${silent.length} dispositivo(s) en silencio: ${names('es')}.`,
  };
}

/**
 * `refresh_devices`: re-publish the discovery list, for when a device was paired
 * or renamed in Zigbee2MQTT and the user does not want to wait.
 * @param {object} context - Runtime context.
 * @param {import('./monitor.js').DevicesMonitor} context.monitor - The monitor.
 * @param {() => Promise<number>} context.publishDevices - Publishes the discovery list, resolving the device count.
 * @returns {Promise<import('./format.js').LocalizedText>} The message shown under the button.
 */
export async function refreshDevices({ monitor, publishDevices }) {
  const snapshot = monitor.snapshot();
  if (!snapshot.summary.inventoryReceived) {
    return {
      en: 'The Zigbee2MQTT device inventory has not been received yet: nothing to publish.',
      fr: "L'inventaire des appareils Zigbee2MQTT n'a pas encore été reçu : rien à publier.",
      de: 'Das Geräteinventar von Zigbee2MQTT wurde noch nicht empfangen: nichts zu veröffentlichen.',
      es: 'Todavía no se ha recibido el inventario de dispositivos de Zigbee2MQTT: nada que publicar.',
    };
  }
  const count = await publishDevices();
  return {
    en: `${count} device(s) published to Gladys.`,
    fr: `${count} appareil(s) publié(s) vers Gladys.`,
    de: `${count} Gerät(e) an Gladys veröffentlicht.`,
    es: `${count} dispositivo(s) publicado(s) en Gladys.`,
  };
}

/**
 * Describe one silent device: how long it has been quiet, against how long it
 * was allowed to be.
 * @param {object} device - Device entry of a monitor snapshot.
 * @param {'en'|'fr'|'de'|'es'} language - Output language.
 * @returns {string} A short description.
 */
function describeSilentDevice(device, language) {
  const since = device.neverSeen
    ? NEVER_SEEN[language]
    : formatDuration(device.silenceMinutes, language);
  const power = isBatteryPowered(device) ? BATTERY[language] : null;
  const details = [since, power].filter(Boolean).join(', ');
  return `${device.friendlyName} (${details})`;
}
