// -----------------------------------------------------------------------------
// The application-level status shown in the Configuration screen.
//
// Distinct from the container state machine: this integration can be RUNNING
// and still unable to reach the MQTT broker, or connected to it and listening
// to the wrong base topic — the two mistakes a user actually makes while setting
// it up, and the two this status names.
//
// It lived in `index.js`, which CLAUDE.md wants to be wiring only. Two decisions
// moved here with it, so they can be tested:
//   - WHAT to report (`buildConnectionStatus`);
//   - WHEN to report it (`ConnectionStatusReporter`): republishing the same
//     status on every tick is noise, but a status that failed to reach Gladys
//     must not be considered delivered, and a status set outside the usual
//     path (the "initialization failed" one) must not leave the dedupe believing
//     the previous one is still displayed — that is how a stale failure message
//     used to stay on screen forever once everything had recovered.
// -----------------------------------------------------------------------------

// How long we wait for `bridge/devices` before telling the user the base topic
// is probably wrong.
export const INVENTORY_GRACE_MS = 30 * 1000;

/** @typedef {{connected: boolean, message?: {en: string, fr: string}}} ConnectionStatus */

/**
 * Decide what to report as the application-level status.
 * @param {object} context - Runtime context.
 * @param {{connected: boolean, lastError: Error|null} | null} context.mqtt - The live MQTT connection, if any.
 * @param {{inventoryReceivedAt: number|null}} context.monitor - The monitor.
 * @param {Record<string, unknown>} context.config - Normalized configuration.
 * @param {number|null} context.mqttStartedAt - When the MQTT connection was opened.
 * @param {number} [context.now] - Current time, in milliseconds.
 * @returns {ConnectionStatus} The status to publish.
 */
export function buildConnectionStatus({ mqtt, monitor, config, mqttStartedAt, now = Date.now() }) {
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
  const waitedLongEnough = now - (mqttStartedAt ?? now) > INVENTORY_GRACE_MS;
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

/** The status reported when the post-connection initialization failed. */
export const INITIALIZATION_FAILED_STATUS = {
  connected: false,
  message: {
    en: 'Initialization failed, check the integration logs.',
    fr: "L'initialisation a échoué, consultez les logs de l'intégration.",
  },
};

/**
 * Sends a status to Gladys only when it differs from the one last delivered.
 */
export class ConnectionStatusReporter {
  /**
   * @param {object} options - Options.
   * @param {{setConnectionStatus: (connected: boolean, message?: object) => Promise<unknown>}} options.gladys - The SDK instance.
   */
  constructor({ gladys }) {
    this.gladys = gladys;
    this.lastSignature = null;
  }

  /**
   * Report a status, unless the very same one is already displayed.
   *
   * A different REASON for the same failure is worth showing, so the message
   * is part of the comparison, not only the boolean.
   * @param {ConnectionStatus} status - The status to report.
   * @returns {Promise<boolean>} True when the status was sent.
   */
  async report(status) {
    const signature = `${status.connected}:${status.message?.en ?? ''}`;
    if (signature === this.lastSignature) {
      return false;
    }
    this.lastSignature = signature;
    try {
      await this.gladys.setConnectionStatus(status.connected, status.message);
    } catch (err) {
      // Not delivered: the next report must try again rather than be deduped.
      this.lastSignature = null;
      throw err;
    }
    return true;
  }

  /**
   * Forget what was delivered, so the next report always goes out — after a
   * Gladys reconnection the core may no longer hold what we sent before.
   */
  reset() {
    this.lastSignature = null;
  }
}
