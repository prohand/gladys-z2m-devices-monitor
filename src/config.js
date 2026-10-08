// -----------------------------------------------------------------------------
// Integration configuration.
//
// The configuration is filled in by the user in Gladys, from the `config_schema`
// declared in `gladys-assistant-integration.json`. The SDK fetches it for you
// (`gladys.getConfig()`) and notifies you of every change through
// `gladys.onConfigUpdated()`.
//
// This module provides the defaults, normalizes the received object so the rest
// of the code never deals with `undefined`, and parses the two free-text fields
// (per-device timeouts, ignore list) into the structures the monitor uses.
//
// It also owns `redactBrokerUrl`: the broker URL is the one setting a user may
// write credentials into (`mqtt://user:pass@host`), and it is quoted in the
// logs, the connection status and the button answers.
// -----------------------------------------------------------------------------

// Defaults: they MUST stay consistent with the `default` values declared in the
// `config_schema` of the manifest (checked by test/manifest.test.js).
export const DEFAULT_CONFIG = {
  // --- Connection to the MQTT broker Zigbee2MQTT publishes on ---------------
  mqtt_url: 'mqtt://localhost:1883',
  mqtt_username: '',
  mqtt_password: '',
  base_topic: 'zigbee2mqtt',

  // --- TLS (mqtts:// and wss:// only) ----------------------------------------
  // A home broker with TLS almost always runs on a self-signed certificate or a
  // private CA, which Node rejects by default: without these two fields such a
  // broker was simply unreachable. The certificate is the safe answer; turning
  // the verification off is the blunt one, offered because it is what users do
  // with every other client.
  mqtt_ca_certificate: '', // PEM, one or more certificates
  mqtt_reject_unauthorized: true,

  // --- Silence thresholds ---------------------------------------------------
  // A device is considered dead once it has been silent for longer than its
  // threshold. Battery devices report far less often than mains-powered ones,
  // hence two defaults instead of one.
  default_timeout_minutes: 120, // mains-powered devices (routers, plugs, bulbs)
  battery_timeout_minutes: 1440, // battery devices (24 h)
  custom_timeouts: '', // "kitchen sensor=360, 0x00158d0001abcdef=60"

  // --- Naming ---------------------------------------------------------------
  // Gladys already knows most of these devices under their Zigbee2MQTT friendly
  // name (through its own Zigbee2MQTT integration), and a scene picker showing
  // "office plug" twice is unusable. The suffix is what tells the watchdog copy
  // apart; empty keeps the raw friendly name.
  device_name_suffix: '(monitor)',

  // What the `Silent device names` text feature reads when nothing is silent.
  // It spends most of its life in that state, so it has to say so in plain
  // words rather than with a placeholder — and it can never be empty (see
  // `normalizeConfig`). English by default, because a Gladys manifest has no
  // way to declare a per-language default; the field is there to translate it.
  no_silent_devices_text: 'No silent device',

  // --- Advanced -------------------------------------------------------------
  ignored_devices: '', // friendly names and/or IEEE addresses, comma separated
  monitor_disabled_devices: false, // devices flagged `disabled` in Zigbee2MQTT
  check_interval_seconds: 60, // how often the alive state is re-evaluated
};

// URL schemes `mqtt.js` can actually open a stream for. An unknown scheme is not
// an error there: `connect()` silently falls back to the first protocol it has a
// builder for (`mqtt`), which is what makes a malformed URL fail so far from its
// cause — see `normalizeBrokerUrl`.
const BROKER_SCHEMES = ['mqtt', 'mqtts', 'ws', 'wss', 'tcp', 'ssl', 'tls'];

/**
 * Make sure the broker URL carries a scheme, because the failure mode of a
 * scheme-less one is unreadable: Node's legacy URL parser reads `192.168.1.10:1884`
 * as the protocol `192.168.1.10:` with the host `1884`, `mqtt.js` then falls back
 * to plain `mqtt` on its default port, and the socket ends up dialing
 * `0.0.7.92:1883` — `1884` interpreted as a 32-bit IPv4 address. The user sees a
 * port they never typed and an address that exists nowhere on their network.
 *
 * Typing the host alone is the expected mistake here, not an exotic one: the
 * broker Gladys installs listens on 1884, so the value being copied around is
 * exactly the kind that turns into a bogus IP when the scheme is dropped.
 * @param {unknown} raw - Raw value of the `mqtt_url` field.
 * @returns {string} A URL `mqtt.js` parses the way the user meant it.
 */
export function normalizeBrokerUrl(raw) {
  const value = String(raw ?? '').trim();
  if (!value) {
    return DEFAULT_CONFIG.mqtt_url;
  }
  // Already `<scheme>://…`: left untouched, including a scheme we do not know
  // about — the user may be reaching a broker through something we don't list.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    return value;
  }
  // `mqtt:host:1884` or `mqtt:/host:1884`: right intent, missing slashes.
  const missingSlashes = value.match(/^([a-z][a-z0-9+.-]*):\/?(?!\/)(.*)$/i);
  if (missingSlashes && BROKER_SCHEMES.includes(missingSlashes[1].toLowerCase())) {
    return `${missingSlashes[1].toLowerCase()}://${missingSlashes[2]}`;
  }
  // Anything else is a bare `host`, `host:port` or `//host:port`: assume TCP
  // MQTT, which is what the field is for.
  return `mqtt://${value.replace(/^\/+/, '')}`;
}

/**
 * Hide the credentials a broker URL may carry (`mqtt://user:pass@host`) before
 * it is logged or displayed. The username goes too: it is half of the pair.
 * @param {unknown} url - A broker URL.
 * @returns {string} The URL with its userinfo replaced by `***`.
 */
export function redactBrokerUrl(url) {
  return String(url ?? '').replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#]*@/i, '$1***@');
}

/**
 * Normalize the PEM text of the CA certificate field.
 *
 * The field is a single-line text input, and browsers strip the line breaks of
 * what is pasted into one: the certificate arrives as
 * `-----BEGIN CERTIFICATE-----MIID…-----END CERTIFICATE-----`, which Node's TLS
 * parser refuses. Each block is rebuilt with its base64 body re-wrapped at 64
 * columns — line breaks, spaces or literal `\n` in between, whatever survived.
 * @param {unknown} raw - Raw value of the `mqtt_ca_certificate` field.
 * @returns {string} The PEM text Node expects, or `''` when the field is empty.
 */
export function normalizePemCertificates(raw) {
  const text = String(raw ?? '')
    .replace(/\\n/g, '\n')
    .trim();
  if (!text) {
    return '';
  }
  const blocks = [...text.matchAll(/-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/g)];
  if (blocks.length === 0) {
    return text; // not PEM: left as typed, the TLS error will say why
  }
  return blocks
    .map(([, label, body]) => {
      const lines = body.replace(/\s+/g, '').match(/.{1,64}/g) ?? [];
      return [`-----BEGIN ${label}-----`, ...lines, `-----END ${label}-----`].join('\n');
    })
    .join('\n')
    .concat('\n');
}

/**
 * Merge the user configuration with the defaults.
 * @param {Record<string, unknown>} raw - Configuration returned by the SDK.
 * @returns {Record<string, unknown>} A complete, correctly typed configuration.
 */
export function normalizeConfig(raw = {}) {
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    // Force the types: a config filled in a form can arrive as strings.
    mqtt_url: normalizeBrokerUrl(raw.mqtt_url ?? DEFAULT_CONFIG.mqtt_url),
    mqtt_username: String(raw.mqtt_username ?? DEFAULT_CONFIG.mqtt_username).trim(),
    mqtt_password: String(raw.mqtt_password ?? DEFAULT_CONFIG.mqtt_password),
    // A trailing slash in the base topic would build `zigbee2mqtt//device`.
    base_topic: String(raw.base_topic ?? DEFAULT_CONFIG.base_topic)
      .trim()
      .replace(/\/+$/, ''),
    mqtt_ca_certificate: normalizePemCertificates(raw.mqtt_ca_certificate),
    // Verification stays on unless explicitly turned off.
    mqtt_reject_unauthorized:
      raw.mqtt_reject_unauthorized !== false && raw.mqtt_reject_unauthorized !== 'false',
    default_timeout_minutes: toPositiveNumber(
      raw.default_timeout_minutes,
      DEFAULT_CONFIG.default_timeout_minutes,
    ),
    battery_timeout_minutes: toPositiveNumber(
      raw.battery_timeout_minutes,
      DEFAULT_CONFIG.battery_timeout_minutes,
    ),
    custom_timeouts: String(raw.custom_timeouts ?? DEFAULT_CONFIG.custom_timeouts),
    device_name_suffix: String(raw.device_name_suffix ?? DEFAULT_CONFIG.device_name_suffix).trim(),
    // An emptied field falls back to the default on purpose: Gladys dispatches a
    // text state on `if (event.text)`, so an empty text is accepted and then
    // dropped, and the feature would read "no value recorded" forever.
    no_silent_devices_text:
      String(raw.no_silent_devices_text ?? '').trim() || DEFAULT_CONFIG.no_silent_devices_text,
    ignored_devices: String(raw.ignored_devices ?? DEFAULT_CONFIG.ignored_devices),
    monitor_disabled_devices: raw.monitor_disabled_devices === true,
    check_interval_seconds: toPositiveNumber(
      raw.check_interval_seconds,
      DEFAULT_CONFIG.check_interval_seconds,
    ),
  };
}

/**
 * Parse the free-text per-device timeouts: one `device=minutes` pair per line or
 * per comma. The device is designated by its Zigbee2MQTT friendly name or by its
 * IEEE address; matching is case-insensitive.
 *
 * Friendly names may contain almost anything (including `=` in theory), so the
 * value is taken after the LAST `=` of the entry.
 * @param {string} raw - Raw value of the `custom_timeouts` field.
 * @returns {Map<string, number>} Lowercased device key -> timeout in minutes.
 */
export function parseCustomTimeouts(raw) {
  const timeouts = new Map();
  for (const entry of splitEntries(raw)) {
    const separator = entry.lastIndexOf('=');
    if (separator <= 0) {
      continue; // no key, or no value: ignore the malformed entry
    }
    const key = entry.slice(0, separator).trim().toLowerCase();
    const minutes = Number(entry.slice(separator + 1).trim());
    if (key && Number.isFinite(minutes) && minutes > 0) {
      timeouts.set(key, minutes);
    }
  }
  return timeouts;
}

/**
 * Parse a free-text device list (the ignore list): friendly names and/or IEEE
 * addresses separated by commas, semicolons or newlines.
 * @param {string} raw - Raw value of the field.
 * @returns {Set<string>} Lowercased device keys.
 */
export function parseDeviceList(raw) {
  return new Set(splitEntries(raw).map((entry) => entry.toLowerCase()));
}

/**
 * Split a free-text list on commas, semicolons and newlines, dropping the empty
 * entries a trailing separator leaves behind.
 * @param {unknown} raw - Raw field value.
 * @returns {string[]} Trimmed, non-empty entries.
 */
function splitEntries(raw) {
  return String(raw ?? '')
    .split(/[\n,;]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Coerce a numeric field, falling back to the default when it is missing or not
 * a usable positive number.
 * @param {unknown} value - Raw value.
 * @param {number} fallback - Default declared in the manifest.
 * @returns {number} A finite, strictly positive number.
 */
function toPositiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
