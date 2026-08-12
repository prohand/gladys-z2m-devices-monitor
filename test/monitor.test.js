import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../src/config.js';
import { DevicesMonitor, isBatteryPowered } from '../src/monitor.js';
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

test('recordLinkQuality reports the signal without claiming a sign of life', () => {
  const { monitor } = createMonitor();
  monitor.recordLinkQuality('office plug', 42);
  const plug = device(monitor.snapshot(), PLUG_IEEE);
  assert.equal(plug.linkQuality, 42);
  assert.equal(plug.neverSeen, true, 'a retained report proves nothing about WHEN');
});

test('activity received before the inventory is replayed, not lost', () => {
  const clock = createClock();
  const monitor = new DevicesMonitor({ config: normalizeConfig(), now: clock.now });
  // The device reports before `bridge/devices` has been received.
  monitor.recordActivity('office plug', { linkQuality: 77 });
  clock.advanceMinutes(10);
  monitor.setZ2mDevices(parseBridgeDevices(BRIDGE_DEVICES_PAYLOAD));

  const plug = device(monitor.snapshot(), PLUG_IEEE);
  assert.equal(plug.silenceMinutes, 10);
  assert.equal(plug.linkQuality, 77);
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
