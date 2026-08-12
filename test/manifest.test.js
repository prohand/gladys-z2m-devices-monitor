// -----------------------------------------------------------------------------
// Consistency checks between `gladys-assistant-integration.json` and the code.
// The manifest is validated by the store indexer, but nothing there can know
// which handlers the code actually registers — these tests keep both in sync.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DEFAULT_CONFIG } from '../src/config.js';
import * as actions from '../src/actions.js';

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
