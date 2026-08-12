// -----------------------------------------------------------------------------
// Routing of the MQTT messages into the monitor.
//
// This is where the subtlest rule of the integration lives: deciding whether a
// message actually proves that a device is alive.
//
//   - a report published BY the device            -> yes, it just spoke;
//   - the same report REPLAYED by the broker
//     (retained flag)                             -> no, it may be days old;
//   - a report carrying its own `last_seen`       -> yes, and we know WHEN,
//                                                    retained or not;
//   - a `set`/`get` command sent TO the device    -> no, that is us talking;
//   - a `device_announce` bridge event            -> yes, it just (re)joined.
//
// Getting the retained case wrong is what turns this integration into a liar:
// every reconnection would replay the last message of every device and reset the
// whole network to "seen just now", including the sensor that died last week.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import {
  parseAvailability,
  parseBridgeDevices,
  parseBridgeEvent,
  parseBridgeState,
  parseLastSeen,
  parseLinkQuality,
  parsePayload,
} from './z2m/payloads.js';
import { parseTopic, TOPIC_KINDS } from './z2m/topics.js';

const logger = createLogger({ name: 'router' });

/**
 * Route one MQTT message into the monitor.
 * @param {object} options - Options.
 * @param {import('./monitor.js').DevicesMonitor} options.monitor - The monitor to feed.
 * @param {string} options.baseTopic - Zigbee2MQTT base topic.
 * @param {string} options.topic - Full MQTT topic of the message.
 * @param {Buffer} options.payload - Raw MQTT payload.
 * @param {boolean} [options.retained] - Whether the broker replayed a stored message.
 * @returns {{kind: string, inventoryUpdated: boolean}} What was done with the message.
 */
export function routeMessage({ monitor, baseTopic, topic, payload, retained = false }) {
  const { kind, friendlyName } = parseTopic(topic, baseTopic, monitor.knownFriendlyNames());
  let inventoryUpdated = false;

  switch (kind) {
    case TOPIC_KINDS.BRIDGE_DEVICES: {
      const parsed = parsePayload(payload);
      // Only a real array is an inventory. A truncated or unparseable payload
      // would otherwise read as "zero devices" and wipe the whole history.
      if (!Array.isArray(parsed)) {
        logger.warn('Ignoring an unreadable bridge/devices payload');
        break;
      }
      const devices = parseBridgeDevices(parsed);
      logger.info(`Zigbee2MQTT inventory received: ${devices.length} device(s)`);
      monitor.setZ2mDevices(devices);
      inventoryUpdated = true;
      break;
    }

    case TOPIC_KINDS.BRIDGE_STATE: {
      const online = parseBridgeState(parsePayload(payload));
      if (online !== undefined) {
        logger.info(`Zigbee2MQTT bridge is ${online ? 'online' : 'offline'}`);
        monitor.setBridgeOnline(online);
      }
      break;
    }

    case TOPIC_KINDS.BRIDGE_EVENT: {
      const event = parseBridgeEvent(parsePayload(payload));
      // A device that just announced itself on the network is alive, even if it
      // has not published a single reading yet.
      if (event && (event.type === 'device_announce' || event.type === 'device_joined')) {
        const target = event.ieeeAddress ?? event.friendlyName;
        if (target) {
          logger.info(`Device announce from ${target}`);
          monitor.recordActivity(target);
        }
      }
      break;
    }

    case TOPIC_KINDS.DEVICE_AVAILABILITY: {
      const availability = parseAvailability(parsePayload(payload));
      if (availability) {
        monitor.recordAvailability(friendlyName, availability);
      }
      break;
    }

    case TOPIC_KINDS.DEVICE_STATE: {
      // An empty payload is Zigbee2MQTT clearing a retained topic (device
      // removed or renamed), not the device speaking.
      if (payload.length === 0) {
        break;
      }
      const body = parsePayload(payload);
      const linkQuality = parseLinkQuality(body);
      const lastSeen = parseLastSeen(body, Date.now());

      if (lastSeen !== undefined) {
        // The device stamped its own report (Zigbee2MQTT `advanced.last_seen`):
        // the most reliable source there is, and the only thing that makes a
        // retained message usable.
        monitor.recordActivity(friendlyName, { at: lastSeen, linkQuality });
      } else if (retained) {
        // The broker replaying the LAST thing the device said. Keep the signal
        // quality it carries, but not a fresh timestamp we cannot justify.
        monitor.recordLinkQuality(friendlyName, linkQuality);
      } else {
        monitor.recordActivity(friendlyName, { linkQuality });
      }
      break;
    }

    default:
      break; // commands, other bridge topics, foreign topics
  }

  return { kind, inventoryUpdated };
}
