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
// -----------------------------------------------------------------------------

// Defaults: they MUST stay consistent with the `default` values declared in the
// `config_schema` of the manifest (checked by test/manifest.test.js).
export const DEFAULT_CONFIG = {
  // --- Connection to the MQTT broker Zigbee2MQTT publishes on ---------------
  mqtt_url: 'mqtt://localhost:1883',
  mqtt_username: '',
  mqtt_password: '',
  base_topic: 'zigbee2mqtt',

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

  // --- Advanced -------------------------------------------------------------
  ignored_devices: '', // friendly names and/or IEEE addresses, comma separated
  monitor_disabled_devices: false, // devices flagged `disabled` in Zigbee2MQTT
  check_interval_seconds: 60, // how often the alive state is re-evaluated
};

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
    mqtt_url: String(raw.mqtt_url ?? DEFAULT_CONFIG.mqtt_url).trim(),
    mqtt_username: String(raw.mqtt_username ?? DEFAULT_CONFIG.mqtt_username).trim(),
    mqtt_password: String(raw.mqtt_password ?? DEFAULT_CONFIG.mqtt_password),
    // A trailing slash in the base topic would build `zigbee2mqtt//device`.
    base_topic: String(raw.base_topic ?? DEFAULT_CONFIG.base_topic)
      .trim()
      .replace(/\/+$/, ''),
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
