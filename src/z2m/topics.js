// -----------------------------------------------------------------------------
// Zigbee2MQTT topic parsing.
//
// The integration subscribes to `<base_topic>/#` and has to sort what it
// receives, because not every message under that tree proves a device is alive:
//
//   zigbee2mqtt/bridge/devices          -> the device inventory (retained)
//   zigbee2mqtt/bridge/state            -> the bridge itself is online/offline
//   zigbee2mqtt/bridge/event            -> device_announce, device_leave...
//   zigbee2mqtt/<friendly name>         -> a report FROM the device  ✔ life
//   zigbee2mqtt/<friendly name>/<attr>  -> a single attribute        ✔ life
//   zigbee2mqtt/<friendly name>/availability -> Zigbee2MQTT's own verdict
//   zigbee2mqtt/<friendly name>/set     -> a command sent TO the device  ✘
//   zigbee2mqtt/<friendly name>/get     -> a read request sent TO the device ✘
//
// The `set` / `get` distinction matters: those are published by Gladys, by Home
// Assistant or by the user, never by the device. Counting them as signs of life
// would make a dead device look alive for as long as something keeps talking to
// it — exactly the failure this integration exists to catch.
//
// Friendly names may contain slashes (`kitchen/motion`), so a topic cannot be
// split naively: the known names are used to find the longest matching prefix.
// -----------------------------------------------------------------------------

export const TOPIC_KINDS = {
  BRIDGE_DEVICES: 'bridge-devices',
  BRIDGE_STATE: 'bridge-state',
  BRIDGE_EVENT: 'bridge-event',
  BRIDGE_OTHER: 'bridge-other',
  DEVICE_STATE: 'device-state',
  DEVICE_AVAILABILITY: 'device-availability',
  COMMAND: 'command',
  UNKNOWN: 'unknown',
};

/**
 * Classify one MQTT topic.
 * @param {string} topic - Full MQTT topic of the received message.
 * @param {string} baseTopic - Zigbee2MQTT base topic (e.g. `zigbee2mqtt`).
 * @param {Set<string>} knownFriendlyNames - Friendly names read from `bridge/devices`.
 * @returns {{ kind: string, friendlyName?: string }} The topic kind, plus the device it targets when there is one.
 */
export function parseTopic(topic, baseTopic, knownFriendlyNames = new Set()) {
  const prefix = `${baseTopic}/`;
  if (typeof topic !== 'string' || !topic.startsWith(prefix)) {
    return { kind: TOPIC_KINDS.UNKNOWN };
  }

  const rest = topic.slice(prefix.length);
  if (rest.length === 0) {
    return { kind: TOPIC_KINDS.UNKNOWN };
  }

  if (rest === 'bridge/devices') {
    return { kind: TOPIC_KINDS.BRIDGE_DEVICES };
  }
  if (rest === 'bridge/state') {
    return { kind: TOPIC_KINDS.BRIDGE_STATE };
  }
  if (rest === 'bridge/event') {
    return { kind: TOPIC_KINDS.BRIDGE_EVENT };
  }
  if (rest === 'bridge' || rest.startsWith('bridge/')) {
    return { kind: TOPIC_KINDS.BRIDGE_OTHER };
  }

  const segments = rest.split('/');

  // `<name>/set`, `<name>/get`, and their `<name>/set/<attribute>` variants:
  // traffic going TO the device, never proof that it answered.
  if (isCommandSegment(segments[segments.length - 1])) {
    return { kind: TOPIC_KINDS.COMMAND };
  }
  if (segments.length >= 3 && isCommandSegment(segments[segments.length - 2])) {
    return { kind: TOPIC_KINDS.COMMAND };
  }

  if (segments.length >= 2 && segments[segments.length - 1] === 'availability') {
    return {
      kind: TOPIC_KINDS.DEVICE_AVAILABILITY,
      friendlyName: segments.slice(0, -1).join('/'),
    };
  }

  // A report published BY the device. The whole remainder is the friendly name
  // in the common case; when Zigbee2MQTT publishes attribute by attribute the
  // name is the longest known prefix of it.
  if (knownFriendlyNames.has(rest)) {
    return { kind: TOPIC_KINDS.DEVICE_STATE, friendlyName: rest };
  }
  const known = longestKnownPrefix(segments, knownFriendlyNames);
  return { kind: TOPIC_KINDS.DEVICE_STATE, friendlyName: known ?? rest };
}

/**
 * Find the longest known friendly name that is a `/`-delimited prefix of a topic.
 * @param {string[]} segments - Topic remainder, split on `/`.
 * @param {Set<string>} knownFriendlyNames - Friendly names read from `bridge/devices`.
 * @returns {string | undefined} The matching friendly name, or undefined.
 */
function longestKnownPrefix(segments, knownFriendlyNames) {
  for (let length = segments.length - 1; length >= 1; length -= 1) {
    const candidate = segments.slice(0, length).join('/');
    if (knownFriendlyNames.has(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Is this topic segment a command segment (traffic sent to the device)?
 * @param {string} segment - One topic segment.
 * @returns {boolean} True for `set` and `get`.
 */
function isCommandSegment(segment) {
  return segment === 'set' || segment === 'get';
}
