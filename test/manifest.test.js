// -----------------------------------------------------------------------------
// Consistency checks between `gladys-assistant-integration.json` and the code.
// The manifest is validated by the store indexer, but nothing there can know
// which handlers the code actually registers — these tests keep both in sync.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DEFAULT_CONFIG, normalizeConfig } from '../src/config.js';
import * as actions from '../src/actions.js';
import { zigbeeExternalIds } from '../src/devices/index.js';
import { DevicesMonitor } from '../src/monitor.js';
import {
  SCENE_ACTION,
  SCENE_TRIGGER,
  buildSceneEvents,
  getDeviceStatus,
  getSilentDevices,
} from '../src/scenes.js';
import { WIDGET } from '../src/widget.js';
import { parseBridgeDevices } from '../src/z2m/payloads.js';
import { createFakeGladys } from './helpers/fakeGladys.js';
import { BRIDGE_DEVICES_PAYLOAD, PLUG_IEEE, createClock } from './helpers/z2mFixtures.js';

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);

// Action key -> the exported handler index.js registers for it.
const ACTION_HANDLERS = {
  test_connection: actions.testConnection,
  list_silent_devices: actions.listSilentDevices,
  refresh_devices: actions.refreshDevices,
};

test('every manifest action has a registered handler', () => {
  for (const action of manifest.actions ?? []) {
    assert.equal(
      typeof ACTION_HANDLERS[action.key],
      'function',
      `manifest action "${action.key}" has no handler`,
    );
  }
  assert.equal(
    Object.keys(ACTION_HANDLERS).length,
    manifest.actions.length,
    'every handler must be declared in the manifest, otherwise its button never appears',
  );
});

/**
 * The minimum Gladys version the manifest declares.
 * @returns {[number, number]} Major and minor.
 */
function minimumGladysVersion() {
  const minimum = manifest.gladys_version.match(/>=\s*(\d+)\.(\d+)\.\d+/);
  assert.ok(minimum, 'gladys_version must declare a minimum version');
  return [Number(minimum[1]), Number(minimum[2])];
}

test('declaring catalog categories requires Gladys >= 4.86.0', () => {
  // `categories` places the integration on the catalog shelves of Gladys 4.86.
  // The vocabulary itself is filtered by the store indexer (an unknown key is
  // dropped with a warning, never a rejection); what has to be pinned here is
  // the coupling: cores older than 4.86.0 validate manifests against a strict
  // field allowlist and reject any unknown top-level field, so a manifest
  // carrying `categories` while claiming compatibility below it turns the
  // catalog's "requires Gladys >= X" filter into a cryptic install failure.
  assert.ok(
    manifest.categories.length >= 1 && manifest.categories.length <= 3,
    'the store accepts 1 to 3 categories',
  );
  const [major, minor] = minimumGladysVersion();
  assert.ok(
    major > 4 || (major === 4 && minor >= 86),
    `categories requires gladys_version >= 4.86.0, got "${manifest.gladys_version}"`,
  );
});

// Same coupling, one release later: `widgets`, `scene_triggers` and
// `scene_actions` are unknown to any core before 5.1.0, which would refuse to
// install the integration instead of leaving it out of the catalog.
test('declaring widgets and scene blocks requires Gladys >= 5.1.0', () => {
  const [major, minor] = minimumGladysVersion();
  assert.ok(
    major > 5 || (major === 5 && minor >= 1),
    `widgets and scene declarations require gladys_version >= 5.1.0, got "${manifest.gladys_version}"`,
  );
});

// --- Widgets and scene blocks ------------------------------------------------
// The keys are stored by the dashboards and by the user's scenes: the code and
// the manifest drifting apart is a widget that never loads, an event the core
// answers with 404, or an action that times out.

/**
 * A monitor on the fixture network, the plug silent.
 * @returns {{gladys: object, monitor: DevicesMonitor, config: object}} The runtime context.
 */
function createRuntime() {
  const clock = createClock();
  const config = normalizeConfig();
  const monitor = new DevicesMonitor({ config, now: clock.now });
  monitor.setZ2mDevices(parseBridgeDevices(BRIDGE_DEVICES_PAYLOAD));
  clock.advanceMinutes(121);
  return { gladys: createFakeGladys(), monitor, config };
}

/**
 * The keys of a manifest list.
 * @param {Array<{key: string}>} list - A manifest list.
 * @returns {string[]} Its keys, sorted.
 */
function keysOf(list = []) {
  return list.map((entry) => entry.key).sort();
}

test('the manifest declares exactly the widgets the code serves', () => {
  assert.deepEqual(keysOf(manifest.widgets), Object.values(WIDGET).sort());
});

test('the manifest declares exactly the scene triggers the code fires', () => {
  assert.deepEqual(keysOf(manifest.scene_triggers), Object.values(SCENE_TRIGGER).sort());
});

test('every trigger filter and variable is present in the event data', () => {
  const { gladys, monitor } = createRuntime();
  const device = monitor.snapshot().devices.find((entry) => entry.ieeeAddress === PLUG_IEEE);
  const events = buildSceneEvents(gladys, [
    { type: 'silent', device },
    { type: 'back', device },
  ]);
  for (const trigger of manifest.scene_triggers) {
    const event = events.find((candidate) => candidate.key === trigger.key);
    // A filter missing from the data never matches; a variable missing from it
    // reads null in every message quoting it.
    for (const entry of [...(trigger.fields ?? []), ...(trigger.variables ?? [])]) {
      assert.ok(entry.key in event.data, `${trigger.key}: "${entry.key}" is never sent`);
    }
    for (const variable of trigger.variables ?? []) {
      assert.equal(
        typeof event.data[variable.key],
        variable.type,
        `${trigger.key}.${variable.key}`,
      );
    }
  }
});

test('every scene action has a handler returning exactly its declared outputs', () => {
  const runtime = createRuntime();
  const handlers = {
    [SCENE_ACTION.GET_SILENT_DEVICES]: () => getSilentDevices(runtime, { power_source: 'all' }),
    [SCENE_ACTION.GET_DEVICE_STATUS]: () =>
      getDeviceStatus(runtime, { device: zigbeeExternalIds(runtime.gladys, PLUG_IEEE).device }),
  };
  assert.deepEqual(keysOf(manifest.scene_actions), Object.values(SCENE_ACTION).sort());
  for (const action of manifest.scene_actions) {
    const outputs = handlers[action.key]();
    // The core drops any undeclared key: an output the manifest forgets is an
    // output no scene can read.
    assert.deepEqual(Object.keys(outputs).sort(), keysOf(action.outputs), action.key);
    for (const output of action.outputs) {
      assert.equal(typeof outputs[output.key], output.type, `${action.key}.${output.key}`);
    }
  }
});

test('the power source choices are the values the code compares with', () => {
  const selects = [
    ...manifest.widgets.flatMap((widget) => widget.settings ?? []),
    ...manifest.scene_triggers.flatMap((trigger) => trigger.fields ?? []),
    ...manifest.scene_actions.flatMap((action) => action.fields ?? []),
  ].filter((field) => field.key === 'power_source');
  assert.ok(selects.length > 0);
  for (const field of selects) {
    for (const option of field.options) {
      assert.ok(['all', 'battery', 'mains'].includes(option.value), option.value);
    }
  }
});

test('config_schema defaults stay consistent with DEFAULT_CONFIG', () => {
  for (const field of manifest.config_schema) {
    if (field.default !== undefined) {
      assert.equal(
        DEFAULT_CONFIG[field.key],
        field.default,
        `DEFAULT_CONFIG.${field.key} must match the manifest default`,
      );
    }
  }
});

test('every value-carrying field is known to the code', () => {
  for (const field of manifest.config_schema) {
    if (field.type === 'section') {
      continue;
    }
    assert.ok(
      field.key in DEFAULT_CONFIG,
      `config field "${field.key}" is never read: add it to DEFAULT_CONFIG`,
    );
  }
});

test('section fields are purely presentational', () => {
  const sections = manifest.config_schema.filter((field) => field.type === 'section');
  assert.ok(sections.length > 0);
  for (const section of sections) {
    // A section stores NO value: declaring `required`, `default` or
    // `placeholder` on it rejects the manifest, and its key must never leak
    // into the config the code manipulates.
    assert.equal(section.required, undefined, `section "${section.key}" must not be required`);
    assert.equal(section.default, undefined, `section "${section.key}" must not have a default`);
    assert.equal(section.placeholder, undefined, `section "${section.key}" has no placeholder`);
    assert.ok(section.label?.en, `section "${section.key}" needs an English label`);
    assert.ok(
      !(section.key in DEFAULT_CONFIG),
      `section "${section.key}" stores no value and must not appear in DEFAULT_CONFIG`,
    );
    for (const link of section.links ?? []) {
      assert.match(link.url, /^https:\/\//, 'section links must be https');
    }
  }
});

test('the manifest carries what the store indexer requires', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.ok(manifest.name.length >= 3 && manifest.name.length <= 30);
  for (const [language, text] of Object.entries(manifest.description)) {
    assert.ok(
      text.length >= 10 && text.length <= 100,
      `description.${language} must be 10-100 characters`,
    );
  }
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/, 'the version must be strict semver');
  assert.match(manifest.docker_image, /:[\w.-]+$/, 'the image needs an explicit tag');
  assert.match(manifest.cover_image, /^https:\/\//);
});

test('every user-facing string is translated', () => {
  const texts = [manifest.description];
  for (const field of manifest.config_schema) {
    texts.push(field.label, field.description, field.placeholder);
    for (const link of field.links ?? []) {
      texts.push(link.label);
    }
  }
  for (const action of manifest.actions) {
    texts.push(action.label);
  }
  const capabilities = [
    ...(manifest.widgets ?? []),
    ...(manifest.scene_triggers ?? []),
    ...(manifest.scene_actions ?? []),
  ];
  for (const entry of capabilities) {
    texts.push(entry.label, entry.description);
    const fields = [...(entry.settings ?? []), ...(entry.fields ?? [])];
    for (const field of [...fields, ...(entry.variables ?? []), ...(entry.outputs ?? [])]) {
      texts.push(field.label, field.description);
      for (const option of field.options ?? []) {
        texts.push(option.label);
      }
    }
  }
  for (const text of texts.filter(Boolean)) {
    assert.ok(text.en, `missing English text in ${JSON.stringify(text)}`);
    assert.ok(text.fr, `missing French text in ${JSON.stringify(text)}`);
  }
});

test('section descriptions stay under the 1000 character limit', () => {
  for (const field of manifest.config_schema.filter((f) => f.type === 'section')) {
    for (const [language, text] of Object.entries(field.description ?? {})) {
      assert.ok(
        text.length <= 1000,
        `section "${field.key}" description.${language} is ${text.length} characters`,
      );
    }
  }
});

test('the integration declares itself local only: it never talks to a cloud', () => {
  assert.deepEqual(manifest.transports, ['local']);
});
