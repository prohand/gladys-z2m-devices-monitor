// -----------------------------------------------------------------------------
// Zigbee2MQTT payload parsing.
//
// Everything the bridge publishes is JSON, but the shapes changed over the
// versions (`bridge/state` used to be the bare string `online`, availability
// still is on old setups), so each reader tolerates both forms and returns
// `undefined` rather than throwing on something unexpected.
// -----------------------------------------------------------------------------

/**
 * Parse a raw MQTT payload as JSON, falling back to the trimmed string.
 * @param {Buffer|string} payload - Raw MQTT payload.
 * @returns {unknown} The parsed JSON value, or the raw string when it is not JSON.
 */
export function parsePayload(payload) {
  const text = payload?.toString('utf8') ?? '';
  try {
    return JSON.parse(text);
  } catch {
    return text.trim();
  }
}

/**
 * Read the device inventory published (retained) on `<base_topic>/bridge/devices`.
 *
 * Only the fields this integration needs are kept, so an unexpected addition to
 * the Zigbee2MQTT payload never breaks the monitor. The coordinator is dropped:
 * it is the USB stick, not a device that can go silent on its own.
 * @param {unknown} payload - Parsed `bridge/devices` payload.
 * @returns {Array<object>} Normalized device descriptors.
 */
export function parseBridgeDevices(payload) {
  if (!Array.isArray(payload)) {
    return [];
  }
  return payload
    .filter((device) => device && typeof device === 'object')
    .filter((device) => device.type !== 'Coordinator')
    .filter((device) => typeof device.ieee_address === 'string' && device.ieee_address.length > 0)
    .map((device) => ({
      ieeeAddress: device.ieee_address,
      friendlyName:
        typeof device.friendly_name === 'string' && device.friendly_name.length > 0
          ? device.friendly_name
          : device.ieee_address,
      type: typeof device.type === 'string' ? device.type : 'Unknown',
      powerSource: typeof device.power_source === 'string' ? device.power_source : '',
      disabled: device.disabled === true,
      // `supported: false` devices are paired but not understood by Zigbee2MQTT;
      // they still publish, so they are still worth watching.
      supported: device.supported !== false,
      model: readDefinition(device, 'model'),
      vendor: readDefinition(device, 'vendor'),
      description: readDefinition(device, 'description'),
    }));
}

/**
 * Read the bridge online state (`<base_topic>/bridge/state`).
 * @param {unknown} payload - Parsed `bridge/state` payload.
 * @returns {boolean | undefined} True when online, undefined when unreadable.
 */
export function parseBridgeState(payload) {
  return readOnlineState(payload);
}

/**
 * Read a device availability payload (`<base_topic>/<name>/availability`).
 *
 * This is Zigbee2MQTT's OWN verdict, which only exists when the user enabled the
 * availability feature. The monitor never derives its alive state from it — it
 * keeps it as a second opinion, shown by the `list_silent_devices` action.
 * @param {unknown} payload - Parsed availability payload.
 * @returns {'online' | 'offline' | undefined} The reported availability.
 */
export function parseAvailability(payload) {
  const online = readOnlineState(payload);
  if (online === undefined) {
    return undefined;
  }
  return online ? 'online' : 'offline';
}

/**
 * Read a `<base_topic>/bridge/event` payload.
 *
 * `device_announce` is the interesting one: a device that just (re)joined the
 * network announced itself, which is a hard proof of life even when it has not
 * published a state yet.
 * @param {unknown} payload - Parsed `bridge/event` payload.
 * @returns {{ type: string, friendlyName?: string, ieeeAddress?: string } | undefined} The event, or undefined.
 */
export function parseBridgeEvent(payload) {
  if (!payload || typeof payload !== 'object' || typeof payload.type !== 'string') {
    return undefined;
  }
  const data = payload.data && typeof payload.data === 'object' ? payload.data : {};
  return {
    type: payload.type,
    friendlyName: typeof data.friendly_name === 'string' ? data.friendly_name : undefined,
    ieeeAddress: typeof data.ieee_address === 'string' ? data.ieee_address : undefined,
  };
}

/**
 * Read the `last_seen` field Zigbee2MQTT adds to device reports when the
 * `advanced.last_seen` option is enabled (`ISO_8601`, `ISO_8601_local` or
 * `epoch`).
 *
 * This is what makes RETAINED messages usable: a retained report arrives the
 * moment we subscribe, but it may be days old — only its `last_seen` says when
 * the device actually spoke. Timestamps in the future (clock skew between the
 * Zigbee2MQTT host and this container) are clamped to `now`.
 * @param {unknown} payload - Parsed device report.
 * @param {number} now - Current timestamp in milliseconds.
 * @returns {number | undefined} The timestamp in milliseconds, or undefined.
 */
export function parseLastSeen(payload, now = Date.now()) {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }
  const raw = payload.last_seen;
  let timestamp;
  if (typeof raw === 'number') {
    timestamp = raw; // `epoch` mode: milliseconds since the Unix epoch
  } else if (typeof raw === 'string' && raw.length > 0) {
    timestamp = Date.parse(raw); // `ISO_8601` and `ISO_8601_local` modes
  }
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return undefined;
  }
  return Math.min(timestamp, now);
}

/**
 * Read the `linkquality` (LQI) field of a device report.
 * @param {unknown} payload - Parsed device report.
 * @returns {number | undefined} The link quality between 0 and 255, or undefined.
 */
export function parseLinkQuality(payload) {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }
  const value = Number(payload.linkquality);
  if (!Number.isFinite(value) || value < 0 || value > 255) {
    return undefined;
  }
  return Math.round(value);
}

/**
 * Read an online/offline state published either as `{ "state": "online" }` or as
 * the bare string `online` (older Zigbee2MQTT versions).
 * @param {unknown} payload - Parsed payload.
 * @returns {boolean | undefined} True when online, undefined when unreadable.
 */
function readOnlineState(payload) {
  const state =
    typeof payload === 'string'
      ? payload
      : payload && typeof payload === 'object'
        ? payload.state
        : undefined;
  if (state === 'online') {
    return true;
  }
  if (state === 'offline') {
    return false;
  }
  return undefined;
}

/**
 * Read one field of the `definition` block of a `bridge/devices` entry.
 * @param {object} device - Raw device entry.
 * @param {string} field - Field name inside `definition`.
 * @returns {string} The value, or an empty string when absent.
 */
function readDefinition(device, field) {
  const definition = device.definition;
  if (!definition || typeof definition !== 'object') {
    return '';
  }
  return typeof definition[field] === 'string' ? definition[field] : '';
}
