import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../src/config.js';
import { DevicesMonitor } from '../src/monitor.js';
import { AliveTransitions } from '../src/transitions.js';
import { parseBridgeDevices } from '../src/z2m/payloads.js';
import {
  BRIDGE_DEVICES_PAYLOAD,
  MOTION_IEEE,
  PLUG_IEEE,
  createClock,
} from './helpers/z2mFixtures.js';

/**
 * A monitor fed with the fixture network, both devices just heard from.
 * @param {Record<string, unknown>} [overrides] - Configuration overrides.
 * @returns {{monitor: DevicesMonitor, clock: object}} The monitor and its clock.
 */
function createMonitor(overrides = {}) {
  const clock = createClock();
  const monitor = new DevicesMonitor({ config: normalizeConfig(overrides), now: clock.now });
  monitor.setZ2mDevices(parseBridgeDevices(BRIDGE_DEVICES_PAYLOAD));
  monitor.setBridgeOnline(true);
  monitor.recordActivity('kitchen/motion');
  monitor.recordActivity('office plug');
  return { monitor, clock };
}

/**
 * Summarize flips as "type:name" strings, for readable assertions.
 * @param {Array<{type: string, device: object}>} flips - Result of `diff`.
 * @returns {string[]} One string per flip.
 */
function describe(flips) {
  return flips.map(({ type, device }) => `${type}:${device.friendlyName}`);
}

// Installing the integration, or upgrading to the first version carrying the
// triggers, must not announce every device already known to be dead.
test('the first evaluation is a baseline, never a flip', () => {
  const { monitor, clock } = createMonitor();
  clock.advanceMinutes(121);
  const transitions = new AliveTransitions();
  assert.deepEqual(transitions.diff(monitor.snapshot()), []);
  assert.deepEqual(transitions.serialize(), { [MOTION_IEEE]: true, [PLUG_IEEE]: false });
});

test('a device crossing its threshold fires once, then once again when it speaks', () => {
  const { monitor, clock } = createMonitor();
  const transitions = new AliveTransitions();
  transitions.diff(monitor.snapshot());

  clock.advanceMinutes(121);
  assert.deepEqual(describe(transitions.diff(monitor.snapshot())), ['silent:office plug']);
  // Still silent on the next tick: that is not news.
  clock.advanceMinutes(1);
  assert.deepEqual(transitions.diff(monitor.snapshot()), []);

  monitor.recordActivity('office plug');
  assert.deepEqual(describe(transitions.diff(monitor.snapshot())), ['back:office plug']);
});

// The whole point over the summary counter: a second death while the first is
// still unresolved gets its own event.
test('each device fires on its own, even while another one is already silent', () => {
  const { monitor, clock } = createMonitor();
  const transitions = new AliveTransitions();
  transitions.diff(monitor.snapshot());
  clock.advanceMinutes(121);
  transitions.diff(monitor.snapshot());
  clock.advanceMinutes(1440);
  assert.deepEqual(describe(transitions.diff(monitor.snapshot())), ['silent:kitchen/motion']);
});

// Otherwise a device dead last week is "newly silent" on every container
// update — and one that died while the container was down is never announced.
test('restored verdicts carry the flips across a restart', () => {
  const { monitor, clock } = createMonitor();
  const before = new AliveTransitions();
  before.diff(monitor.snapshot());
  const saved = before.serialize();

  clock.advanceMinutes(121);
  const after = new AliveTransitions();
  after.restore(saved);
  assert.deepEqual(describe(after.diff(monitor.snapshot())), ['silent:office plug']);

  const again = new AliveTransitions();
  again.restore(after.serialize());
  assert.deepEqual(again.diff(monitor.snapshot()), [], 'already announced before the restart');
});

test('a corrupted verdict file is ignored entry by entry', () => {
  const transitions = new AliveTransitions();
  transitions.restore({ [PLUG_IEEE]: 'yes', [MOTION_IEEE]: false });
  transitions.restore(null);
  assert.deepEqual(transitions.serialize(), { [MOTION_IEEE]: false });
});

// Broker down or Zigbee2MQTT stopped: every device goes quiet together, and one
// event per device would be a notification storm about a single failure.
test('nothing fires while the network cannot be heard, and the verdicts wait', () => {
  const { monitor, clock } = createMonitor();
  const transitions = new AliveTransitions();
  transitions.diff(monitor.snapshot());

  clock.advanceMinutes(121);
  assert.deepEqual(transitions.diff(monitor.snapshot(), { listening: false }), []);
  monitor.setBridgeOnline(false);
  assert.deepEqual(transitions.diff(monitor.snapshot()), []);

  // Back up: the plug is still dead, and that is now worth saying.
  monitor.setBridgeOnline(true);
  assert.deepEqual(describe(transitions.diff(monitor.snapshot())), ['silent:office plug']);
});

test('an outage that ends before anything is announced leaves nothing to say', () => {
  const { monitor, clock } = createMonitor();
  const transitions = new AliveTransitions();
  transitions.diff(monitor.snapshot());
  monitor.setBridgeOnline(false);
  clock.advanceMinutes(121);
  transitions.diff(monitor.snapshot());
  monitor.setBridgeOnline(true);
  monitor.recordActivity('office plug');
  assert.deepEqual(transitions.diff(monitor.snapshot()), []);
});

// Right after a restart the inventory has not arrived yet: an empty snapshot
// must not wipe the verdicts restored from disk.
test('the verdicts survive until the inventory arrives', () => {
  const clock = createClock();
  const monitor = new DevicesMonitor({ config: normalizeConfig(), now: clock.now });
  const transitions = new AliveTransitions();
  transitions.restore({ [PLUG_IEEE]: true });
  assert.deepEqual(transitions.diff(monitor.snapshot()), []);
  assert.deepEqual(transitions.serialize(), { [PLUG_IEEE]: true });
});

test('an excluded device leaves the tracking, and comes back as a baseline', () => {
  const { monitor, clock } = createMonitor();
  const transitions = new AliveTransitions();
  transitions.diff(monitor.snapshot());

  monitor.setConfig(normalizeConfig({ ignored_devices: 'office plug' }));
  transitions.diff(monitor.snapshot());
  assert.deepEqual(Object.keys(transitions.serialize()), [MOTION_IEEE]);

  clock.advanceMinutes(121);
  monitor.setConfig(normalizeConfig());
  assert.deepEqual(transitions.diff(monitor.snapshot()), []);
});
