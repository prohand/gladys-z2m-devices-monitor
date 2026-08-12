// -----------------------------------------------------------------------------
// Zigbee2MQTT fixtures: a small but realistic network.
//
// The shapes come from the real `bridge/devices` payload — trimmed to the fields
// the integration reads, plus the ones it must be able to ignore.
// -----------------------------------------------------------------------------

export const BRIDGE_DEVICES_PAYLOAD = [
  {
    ieee_address: '0x00124b0022aabbcc',
    type: 'Coordinator',
    friendly_name: 'Coordinator',
    supported: false,
  },
  {
    ieee_address: '0x00158d0001111111',
    type: 'EndDevice',
    friendly_name: 'kitchen/motion',
    power_source: 'Battery',
    supported: true,
    disabled: false,
    definition: { model: 'RTCGQ11LM', vendor: 'Aqara', description: 'Motion sensor' },
  },
  {
    ieee_address: '0x00158d0002222222',
    type: 'Router',
    friendly_name: 'office plug',
    power_source: 'Mains (single phase)',
    supported: true,
    disabled: false,
    definition: { model: 'SP-EUC01', vendor: 'Innr', description: 'Smart plug' },
  },
  {
    ieee_address: '0x00158d0003333333',
    type: 'EndDevice',
    friendly_name: 'spare sensor',
    power_source: 'Battery',
    supported: true,
    disabled: true,
    definition: { model: 'WSDCGQ11LM', vendor: 'Aqara', description: 'Temperature sensor' },
  },
];

export const MOTION_IEEE = '0x00158d0001111111';
export const PLUG_IEEE = '0x00158d0002222222';
export const DISABLED_IEEE = '0x00158d0003333333';

export const MINUTE_MS = 60 * 1000;

/**
 * A clock the tests drive by hand, so silence can be measured without waiting.
 * @param {number} [start] - Initial timestamp in milliseconds.
 * @returns {{now: () => number, advanceMinutes: (minutes: number) => void}} The clock.
 */
export function createClock(start = Date.parse('2026-01-01T00:00:00.000Z')) {
  let current = start;
  return {
    now: () => current,
    advanceMinutes(minutes) {
      current += minutes * MINUTE_MS;
    },
  };
}
