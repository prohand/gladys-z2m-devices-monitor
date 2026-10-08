import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../src/config.js';
import { DevicesMonitor, MAX_PENDING, isBatteryPowered } from '../src/monitor.js';
import { parseBridgeDevices } from '../src/z2m/payloads.js';
import {
  BRIDGE_DEVICES_PAYLOAD,
  createClock,
  DISABLED_IEEE,
  MOTION_IEEE,
  PLUG_IEEE,
} from './helpers/z2mFixtures.js';

/**
 * Build a monitor fed with the fixture network and a hand-driven clock.
 * @param {Record<string, unknown>} [overrides] - Configuration overrides.
 * @returns {{monitor: DevicesMonitor, clock: object}} The monitor and its clock.
 */
function createMonitor(overrides = {}) {
  const clock = createClock();
  const monitor = new DevicesMonitor({ config: normalizeConfig(overrides), now: clock.now });
  monitor.setZ2mDevices(parseBridgeDevices(BRIDGE_DEVICES_PAYLOAD));
  return { monitor, clock };
}

/**
 * Read one device out of a snapshot.
 * @param {object} snapshot - Snapshot to read.
 * @param {string} ieee - IEEE address to look for.
 * @returns {object} The device entry.
 */
function device(snapshot, ieee) {
  return snapshot.devices.find((entry) => entry.ieeeAddress === ieee);
}

test('a device that just reported is alive with no silence', () => {
  const { monitor } = createMonitor();
  monitor.recordActivity('office plug');
  const plug = device(monitor.snapshot(), PLUG_IEEE);
  assert.equal(plug.alive, true);
  assert.equal(plug.silenceMinutes, 0);
  assert.equal(plug.neverSeen, false);
});

test('a device is declared dead once it passes its threshold', () => {
  const { monitor, clock } = createMonitor({ default_timeout_minutes: 120 });
  monitor.recordActivity('office plug');

  clock.advanceMinutes(119);
  assert.equal(device(monitor.snapshot(), PLUG_IEEE).alive, true, 'still within the threshold');

  clock.advanceMinutes(2);
  const plug = device(monitor.snapshot(), PLUG_IEEE);
  assert.equal(plug.alive, false);
  assert.equal(plug.silenceMinutes, 121);
});

// The reason this integration exists: the battery level says nothing, only the
// silence does — and battery devices are allowed to be silent far longer.
test('battery devices get the battery threshold, mains devices the default one', () => {
  const { monitor } = createMonitor({
    default_timeout_minutes: 120,
    battery_timeout_minutes: 1440,
  });
  const snapshot = monitor.snapshot();
  assert.equal(device(snapshot, MOTION_IEEE).timeoutMinutes, 1440);
  assert.equal(device(snapshot, MOTION_IEEE).battery, true);
  assert.equal(device(snapshot, PLUG_IEEE).timeoutMinutes, 120);
  assert.equal(device(snapshot, PLUG_IEEE).battery, false);
});

test('a per-device threshold wins over the power-source default', () => {
  const { monitor } = createMonitor({ custom_timeouts: 'KITCHEN/MOTION=60' });
  assert.equal(device(monitor.snapshot(), MOTION_IEEE).timeoutMinutes, 60);
});

test('a per-device threshold can be set on the IEEE address', () => {
  const { monitor } = createMonitor({ custom_timeouts: `${PLUG_IEEE}=15` });
  assert.equal(device(monitor.snapshot(), PLUG_IEEE).timeoutMinutes, 15);
});

// A freshly installed integration knows nothing: declaring the whole network
// dead on the first tick would make it useless (and very noisy).
test('a device never heard from gets one full threshold before being flagged', () => {
  const { monitor, clock } = createMonitor({ default_timeout_minutes: 120 });
  assert.equal(device(monitor.snapshot(), PLUG_IEEE).alive, true);
  assert.equal(device(monitor.snapshot(), PLUG_IEEE).neverSeen, true);

  clock.advanceMinutes(121);
  assert.equal(device(monitor.snapshot(), PLUG_IEEE).alive, false);
});

test('devices disabled in Zigbee2MQTT are not watched unless asked', () => {
  const { monitor } = createMonitor();
  assert.equal(device(monitor.snapshot(), DISABLED_IEEE).monitored, false);

  const { monitor: watching } = createMonitor({ monitor_disabled_devices: true });
  assert.equal(device(watching.snapshot(), DISABLED_IEEE).monitored, true);
});

test('ignored devices are excluded by friendly name or IEEE address', () => {
  const { monitor } = createMonitor({ ignored_devices: `Kitchen/Motion, ${PLUG_IEEE}` });
  const snapshot = monitor.snapshot();
  assert.equal(device(snapshot, MOTION_IEEE).monitored, false);
  assert.equal(device(snapshot, PLUG_IEEE).monitored, false);
  assert.equal(snapshot.summary.monitored, 0);
});

test('the summary counts the watched devices and names the silent ones', () => {
  const { monitor, clock } = createMonitor({
    default_timeout_minutes: 60,
    battery_timeout_minutes: 1440,
  });
  monitor.recordActivity('office plug');
  monitor.recordActivity('kitchen/motion');
  clock.advanceMinutes(61);

  const { summary } = monitor.snapshot();
  assert.equal(summary.monitored, 2, 'the disabled device is not counted');
  assert.equal(summary.silent, 1);
  assert.equal(summary.alive, 1);
  assert.deepEqual(
    summary.silentDevices.map((entry) => entry.friendlyName),
    ['office plug'],
  );
});

test('an explicit timestamp is used instead of the reception time', () => {
  const { monitor, clock } = createMonitor({ default_timeout_minutes: 120 });
  // A retained report carrying `last_seen` from three hours ago must NOT make
  // the device look like it just spoke.
  monitor.recordActivity('office plug', { at: clock.now() - 180 * 60 * 1000 });
  const plug = device(monitor.snapshot(), PLUG_IEEE);
  assert.equal(plug.silenceMinutes, 180);
  assert.equal(plug.alive, false);
});

test('the last-seen timestamp never moves backwards', () => {
  const { monitor, clock } = createMonitor();
  monitor.recordActivity('office plug');
  monitor.recordActivity('office plug', { at: clock.now() - 3_600_000 });
  assert.equal(device(monitor.snapshot(), PLUG_IEEE).silenceMinutes, 0);
});

test('activity received before the inventory is replayed, not lost', () => {
  const clock = createClock();
  const monitor = new DevicesMonitor({ config: normalizeConfig(), now: clock.now });
  // The device reports before `bridge/devices` has been received.
  monitor.recordActivity('office plug');
  clock.advanceMinutes(10);
  monitor.setZ2mDevices(parseBridgeDevices(BRIDGE_DEVICES_PAYLOAD));

  assert.equal(device(monitor.snapshot(), PLUG_IEEE).silenceMinutes, 10);
});

test('a device removed from the network stops carrying stale activity', () => {
  const { monitor } = createMonitor();
  monitor.recordActivity('office plug');
  monitor.setZ2mDevices(
    parseBridgeDevices(BRIDGE_DEVICES_PAYLOAD.filter((entry) => entry.ieee_address !== PLUG_IEEE)),
  );
  assert.equal(device(monitor.snapshot(), PLUG_IEEE), undefined);
  assert.equal(monitor.serialize()[PLUG_IEEE], undefined);
});

// Without persistence, restarting the container would hand a device that died
// last month a brand new threshold — and the alert would never fire.
test('serialize and restore carry the silence across a restart', () => {
  const { monitor, clock } = createMonitor({ default_timeout_minutes: 120 });
  monitor.recordActivity('office plug');
  const saved = monitor.serialize();
  assert.equal(saved[PLUG_IEEE].last_seen, clock.now());

  clock.advanceMinutes(200);
  const restarted = new DevicesMonitor({
    config: normalizeConfig({ default_timeout_minutes: 120 }),
    now: clock.now,
  });
  restarted.restore(saved);
  restarted.setZ2mDevices(parseBridgeDevices(BRIDGE_DEVICES_PAYLOAD));

  const plug = device(restarted.snapshot(), PLUG_IEEE);
  assert.equal(plug.silenceMinutes, 200);
  assert.equal(plug.alive, false);
});

// While Zigbee2MQTT is down the inventory never arrives, so nothing can be
// resolved to an IEEE address. Persisting only the resolved half would erase the
// whole history on the next scheduled write.
test('serialize keeps the entries that could not be resolved yet', () => {
  const clock = createClock();
  const monitor = new DevicesMonitor({ config: normalizeConfig(), now: clock.now });
  monitor.restore({ [PLUG_IEEE]: { last_seen: clock.now() - 60_000 } });
  monitor.recordActivity('a device we have never inventoried');

  const saved = monitor.serialize();
  assert.ok(saved[PLUG_IEEE], 'the restored history is not lost before the inventory arrives');
  assert.ok(saved['a device we have never inventoried']);

  // And it still resolves once the inventory lands.
  monitor.setZ2mDevices(parseBridgeDevices(BRIDGE_DEVICES_PAYLOAD));
  assert.equal(device(monitor.snapshot(), PLUG_IEEE).neverSeen, false);
});

test('restore ignores a corrupted or future-dated entry', () => {
  const { monitor, clock } = createMonitor();
  monitor.restore({ [PLUG_IEEE]: { last_seen: 'yesterday' }, [MOTION_IEEE]: null });
  monitor.restore({ [MOTION_IEEE]: { last_seen: clock.now() + 100_000 } });
  const snapshot = monitor.snapshot();
  assert.equal(device(snapshot, PLUG_IEEE).neverSeen, true);
  assert.equal(device(snapshot, MOTION_IEEE).neverSeen, true);
  assert.doesNotThrow(() => monitor.restore(undefined));
});

test('setConfig re-reads the thresholds without losing the history', () => {
  const { monitor, clock } = createMonitor({ default_timeout_minutes: 120 });
  monitor.recordActivity('office plug');
  clock.advanceMinutes(30);

  monitor.setConfig(normalizeConfig({ default_timeout_minutes: 15 }));
  const plug = device(monitor.snapshot(), PLUG_IEEE);
  assert.equal(plug.silenceMinutes, 30, 'the history survived the reconfiguration');
  assert.equal(plug.alive, false, 'the new threshold applies immediately');
});

test('knownFriendlyNames exposes the names needed to parse the topics', () => {
  const { monitor } = createMonitor();
  assert.deepEqual([...monitor.knownFriendlyNames()].sort(), [
    'kitchen/motion',
    'office plug',
    'spare sensor',
  ]);
});

test('the bridge state is unknown until the bridge says something', () => {
  const { monitor } = createMonitor();
  assert.equal(monitor.snapshot().summary.bridgeOnline, null);
  monitor.setBridgeOnline(true);
  assert.equal(monitor.snapshot().summary.bridgeOnline, true);
});

test('isBatteryPowered reads the Zigbee2MQTT power source', () => {
  assert.equal(isBatteryPowered({ powerSource: 'Battery' }), true);
  assert.equal(isBatteryPowered({ powerSource: 'battery' }), true);
  assert.equal(isBatteryPowered({ powerSource: 'Mains (single phase)' }), false);
  assert.equal(isBatteryPowered({}), false);
});

// --- Outages: silence only counts while the network can be heard ---------------

/**
 * A monitor hearing the fixture network, the plug having just reported.
 * @returns {{monitor: DevicesMonitor, clock: object}} The monitor and its clock.
 */
function createListeningMonitor() {
  const { monitor, clock } = createMonitor({ default_timeout_minutes: 120 });
  monitor.setListening(true);
  monitor.setBridgeOnline(true);
  monitor.recordActivity('office plug');
  return { monitor, clock };
}

// A mains plug reports every few minutes; after a 5 h broker outage its last
// report is 5 h old. Declaring it dead on the first tick, then "back" a minute
// later, is a false alert per device on the network.
test('a device alive when an outage began gets one threshold after it to speak again', () => {
  const { monitor, clock } = createListeningMonitor();
  clock.advanceMinutes(10);
  monitor.setListening(false);
  clock.advanceMinutes(300);
  monitor.setListening(true);

  let plug = device(monitor.snapshot(), PLUG_IEEE);
  assert.equal(plug.alive, true, 'not declared dead on the first tick after the outage');
  assert.equal(plug.inGrace, true);
  assert.equal(plug.silenceMinutes, 310, 'the displayed silence is the plain truth');

  clock.advanceMinutes(5);
  monitor.recordActivity('office plug');
  plug = device(monitor.snapshot(), PLUG_IEEE);
  assert.equal(plug.alive, true);
  assert.equal(plug.inGrace, false);
});

test('a device that died during the outage is declared silent once its grace runs out', () => {
  const { monitor, clock } = createListeningMonitor();
  monitor.setListening(false);
  clock.advanceMinutes(300);
  monitor.setListening(true);

  clock.advanceMinutes(120);
  assert.equal(device(monitor.snapshot(), PLUG_IEEE).alive, true, 'one full threshold');
  clock.advanceMinutes(1);
  const plug = device(monitor.snapshot(), PLUG_IEEE);
  assert.equal(plug.alive, false);
  assert.equal(plug.inGrace, false);
});

// No "back" for a device that was already dead before the network went away.
test('a device already dead before the outage gets no grace', () => {
  const { monitor, clock } = createListeningMonitor();
  clock.advanceMinutes(200);
  assert.equal(device(monitor.snapshot(), PLUG_IEEE).alive, false);
  monitor.setListening(false);
  clock.advanceMinutes(60);
  monitor.setListening(true);
  assert.equal(device(monitor.snapshot(), PLUG_IEEE).alive, false);
});

test('a bridge offline is an outage too, even with the broker reachable', () => {
  const { monitor, clock } = createListeningMonitor();
  monitor.setBridgeOnline(false);
  clock.advanceMinutes(300);
  monitor.setBridgeOnline(true);
  assert.equal(device(monitor.snapshot(), PLUG_IEEE).alive, true);
});

test('the grace carries over two outages in a row', () => {
  const { monitor, clock } = createListeningMonitor();
  monitor.setListening(false);
  clock.advanceMinutes(300);
  monitor.setListening(true);
  clock.advanceMinutes(60); // in grace, the plug has not spoken yet
  monitor.setListening(false);
  clock.advanceMinutes(300);
  monitor.setListening(true);
  assert.equal(device(monitor.snapshot(), PLUG_IEEE).alive, true);
});

// The container being down is an outage like any other: the previous run says
// when it last heard the network.
test('a restart counts the downtime as an outage from when the previous run last heard', () => {
  const { monitor, clock } = createListeningMonitor();
  const saved = monitor.serialize();
  const heardAt = monitor.lastHeardAt();
  clock.advanceMinutes(300);

  const restarted = new DevicesMonitor({
    config: normalizeConfig({ default_timeout_minutes: 120 }),
    now: clock.now,
  });
  restarted.restore(saved, { heardAt });
  restarted.setZ2mDevices(parseBridgeDevices(BRIDGE_DEVICES_PAYLOAD));
  clock.advanceMinutes(1);
  restarted.setListening(true);

  assert.equal(device(restarted.snapshot(), PLUG_IEEE).alive, true);
  clock.advanceMinutes(121);
  assert.equal(device(restarted.snapshot(), PLUG_IEEE).alive, false);
});

test('without heardAt the downtime is not guessed: the previous verdict stands', () => {
  const { monitor, clock } = createListeningMonitor();
  const saved = monitor.serialize();
  clock.advanceMinutes(300);
  const restarted = new DevicesMonitor({
    config: normalizeConfig({ default_timeout_minutes: 120 }),
    now: clock.now,
  });
  restarted.restore(saved);
  restarted.setZ2mDevices(parseBridgeDevices(BRIDGE_DEVICES_PAYLOAD));
  restarted.setListening(true);
  assert.equal(device(restarted.snapshot(), PLUG_IEEE).alive, false);
});

test('lastHeardAt is now while hearing, and the start of the outage otherwise', () => {
  const { monitor, clock } = createListeningMonitor();
  assert.equal(monitor.lastHeardAt(), clock.now());
  monitor.setListening(false);
  const lostAt = clock.now();
  clock.advanceMinutes(30);
  assert.equal(monitor.lastHeardAt(), lostAt);
});

// --- The pending buffer is bounded --------------------------------------------

test('unresolved activity expires once an inventory has been received', () => {
  const { monitor, clock } = createMonitor();
  monitor.recordActivity('old name of a renamed device');
  clock.advanceMinutes(30);
  assert.ok(monitor.serialize()['old name of a renamed device'], 'young: kept');

  clock.advanceMinutes(31);
  assert.equal(monitor.serialize()['old name of a renamed device'], undefined, 'not persisted');
  monitor.setZ2mDevices(parseBridgeDevices(BRIDGE_DEVICES_PAYLOAD));
  assert.equal(monitor.pendingByFriendlyName.size, 0, 'and dropped from memory');
});

// The Zigbee2MQTT outage case: no inventory, so nothing can be resolved, and
// the whole restored history waits in the buffer. It must not expire.
test('nothing expires before the first inventory', () => {
  const clock = createClock();
  const monitor = new DevicesMonitor({ config: normalizeConfig(), now: clock.now });
  monitor.restore({ [PLUG_IEEE]: { last_seen: clock.now() - 60_000 } });
  clock.advanceMinutes(24 * 60);
  assert.ok(monitor.serialize()[PLUG_IEEE]);
  monitor.setZ2mDevices(parseBridgeDevices(BRIDGE_DEVICES_PAYLOAD));
  assert.equal(device(monitor.snapshot(), PLUG_IEEE).neverSeen, false);
});

test('the pending buffer is capped, the oldest entries going first', () => {
  const { monitor, clock } = createMonitor();
  for (let index = 0; index < MAX_PENDING + 10; index += 1) {
    monitor.recordActivity(`unknown ${index}`);
    clock.advanceMinutes(0.001);
  }
  assert.equal(monitor.pendingByFriendlyName.size, MAX_PENDING);
  assert.equal(monitor.pendingByFriendlyName.has('unknown 0'), false);
  assert.equal(monitor.pendingByFriendlyName.has(`unknown ${MAX_PENDING + 9}`), true);
});

test('a name that keeps publishing still expires: the TTL counts from its first message', () => {
  const { monitor, clock } = createMonitor();
  monitor.recordActivity('some group');
  for (let index = 0; index < 7; index += 1) {
    clock.advanceMinutes(10);
    monitor.recordActivity('some group');
  }
  assert.equal(monitor.serialize()['some group'], undefined);
});
