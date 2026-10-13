import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { normalizeConfig } from '../src/config.js';
import { LANGUAGES } from '../src/format.js';
import { DevicesMonitor } from '../src/monitor.js';
import { buildNetworkHealthWidget, networkHealthSignature } from '../src/widget.js';
import { parseBridgeDevices } from '../src/z2m/payloads.js';
import { BRIDGE_DEVICES_PAYLOAD, createClock } from './helpers/z2mFixtures.js';

/**
 * A monitor fed with the fixture network.
 * @returns {{monitor: DevicesMonitor, clock: object}} The monitor and its clock.
 */
function createMonitor() {
  const clock = createClock();
  const monitor = new DevicesMonitor({ config: normalizeConfig(), now: clock.now });
  monitor.setZ2mDevices(parseBridgeDevices(BRIDGE_DEVICES_PAYLOAD));
  monitor.recordActivity('kitchen/motion');
  monitor.recordActivity('office plug');
  return { monitor, clock };
}

/**
 * The components of a content, by type.
 * @param {object} content - A widget content.
 * @param {string} type - Component type.
 * @returns {Array<object>} The matching components.
 */
function componentsOf(content, type) {
  return content.components.filter((component) => component.type === type);
}

// The core silently drops or truncates what breaks the vocabulary or the
// budget: an empty report means the dashboard shows exactly what was built.
test('every content fits the widget vocabulary and budget', () => {
  const { monitor, clock } = createMonitor();
  const empty = new DevicesMonitor({ config: normalizeConfig(), now: clock.now });
  assert.deepEqual(validateWidgetContent(buildNetworkHealthWidget(empty.snapshot())), []);
  assert.deepEqual(validateWidgetContent(buildNetworkHealthWidget(monitor.snapshot())), []);
  clock.advanceMinutes(5000);
  assert.deepEqual(validateWidgetContent(buildNetworkHealthWidget(monitor.snapshot())), []);
});

/**
 * Every multi-language text of a content (any object carrying an `en` key).
 * @param {unknown} node - A content, or a part of one.
 * @returns {Array<Record<string, string>>} The texts found.
 */
function textsOf(node) {
  if (Array.isArray(node)) {
    return node.flatMap(textsOf);
  }
  if (node && typeof node === 'object') {
    return typeof node.en === 'string' ? [node] : Object.values(node).flatMap(textsOf);
  }
  return [];
}

// The core renders the reader's language and falls back on English: a text
// missing a language would silently read English to a German or Spanish user.
test('every text of the widget is written in the four languages of Gladys', () => {
  const { monitor, clock } = createMonitor();
  const empty = new DevicesMonitor({ config: normalizeConfig(), now: clock.now });
  monitor.setBridgeOnline(true);
  const contents = [
    buildNetworkHealthWidget(empty.snapshot()),
    buildNetworkHealthWidget(monitor.snapshot()),
  ];
  clock.advanceMinutes(5000);
  contents.push(buildNetworkHealthWidget(monitor.snapshot()));
  const texts = contents.flatMap(textsOf);
  assert.ok(texts.length > 5);
  for (const text of texts) {
    assert.deepEqual(Object.keys(text), LANGUAGES, JSON.stringify(text));
  }
});

test('the tiles count the silent, alive and watched devices', () => {
  const { monitor, clock } = createMonitor();
  clock.advanceMinutes(121);
  const [silent, alive, watched] = componentsOf(
    buildNetworkHealthWidget(monitor.snapshot()),
    'value',
  );
  assert.deepEqual([silent.value, alive.value, watched.value], [1, 1, 2]);
  assert.equal(silent.color, 'danger');
});

test('the status list names the silent devices and how long they have been quiet', () => {
  const { monitor, clock } = createMonitor();
  monitor.setBridgeOnline(true);
  clock.advanceMinutes(185);
  const [status] = componentsOf(buildNetworkHealthWidget(monitor.snapshot()), 'status');
  assert.deepEqual(status.items[0].value, {
    en: 'online',
    fr: 'en ligne',
    de: 'online',
    es: 'en línea',
  });
  assert.equal(status.items[1].label, 'office plug');
  assert.deepEqual(status.items[1].value, {
    en: '3 h 5 min',
    fr: '3 h 5 min',
    de: '3 h 5 min',
    es: '3 h 5 min',
  });
  assert.equal(status.items.length, 2);
});

test('an all-clear network says so instead of showing an empty list', () => {
  const { monitor } = createMonitor();
  const [status] = componentsOf(buildNetworkHealthWidget(monitor.snapshot()), 'status');
  assert.deepEqual(status.items[1].value, { en: 'none', fr: 'aucun', de: 'keine', es: 'ninguno' });
  assert.equal(status.items[1].color, 'success');
});

test('the power source setting narrows every number', () => {
  const { monitor, clock } = createMonitor();
  clock.advanceMinutes(121);
  const content = buildNetworkHealthWidget(monitor.snapshot(), { power_source: 'battery' });
  const [silent, , watched] = componentsOf(content, 'value');
  assert.deepEqual([silent.value, watched.value], [0, 1]);
});

// Past ten rows the core drops the rest without a word: the last row counts
// them instead.
test('a long outage is summarized within the ten rows of a status list', () => {
  const clock = createClock();
  const monitor = new DevicesMonitor({ config: normalizeConfig(), now: clock.now });
  monitor.setZ2mDevices(
    parseBridgeDevices(
      Array.from({ length: 15 }, (_, i) => ({
        ieee_address: `0x00158d00000000${String(i).padStart(2, '0')}`,
        type: 'Router',
        friendly_name: `plug ${String(i).padStart(2, '0')}`,
        power_source: 'Mains (single phase)',
        supported: true,
      })),
    ),
  );
  clock.advanceMinutes(121);
  const content = buildNetworkHealthWidget(monitor.snapshot());
  const [status] = componentsOf(content, 'status');
  assert.equal(status.items.length, 10);
  assert.equal(status.items.at(-1).value, 7);
  assert.deepEqual(validateWidgetContent(content), []);
});

// Zeros before the inventory would read "all good" while nothing is known yet.
test('before the inventory, the widget says it is waiting instead of showing zeros', () => {
  const clock = createClock();
  const monitor = new DevicesMonitor({ config: normalizeConfig(), now: clock.now });
  const content = buildNetworkHealthWidget(monitor.snapshot());
  assert.deepEqual(componentsOf(content, 'value'), []);
  assert.match(componentsOf(content, 'text')[0].text.en, /inventory/);
});

// The nudge exists for verdict flips; the minute-by-minute silence is left to
// the TTL, or every tick would re-pull every open dashboard.
test('the refresh signature moves on a flip, not with the clock', () => {
  const { monitor, clock } = createMonitor();
  const before = networkHealthSignature(monitor.snapshot());
  clock.advanceMinutes(60);
  assert.equal(networkHealthSignature(monitor.snapshot()), before);
  clock.advanceMinutes(61);
  assert.notEqual(networkHealthSignature(monitor.snapshot()), before);
});
