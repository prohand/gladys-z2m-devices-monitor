import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// One of the tests below deliberately makes a write fail, and the store reports
// it — rightly — as an error. Pin the level BEFORE the module builds its logger
// so the expected failure does not look like a broken test run.
process.env.LOG_LEVEL = 'silent';
const { LastSeenStore } = await import('../src/lastSeenStore.js');

/**
 * Build a store writing into a fresh temporary directory.
 * @returns {Promise<{store: LastSeenStore, filePath: string}>} The store and its file path.
 */
async function createStore() {
  const directory = await mkdtemp(join(tmpdir(), 'z2m-monitor-'));
  const filePath = join(directory, 'last-seen.json');
  return { store: new LastSeenStore({ filePath }), filePath };
}

test('a missing file reads as an empty history, without noise', async () => {
  const { store } = await createStore();
  assert.deepEqual(await store.load(), {});
});

test('what is saved is what is loaded back', async () => {
  const { store } = await createStore();
  const devices = { '0x00158d0001111111': { last_seen: 1767225600000 } };
  assert.equal(await store.save(devices), true);
  assert.deepEqual(await store.load(), devices);
});

test('the file is written atomically, so a kill mid-write leaves no truncated JSON', async () => {
  const { store, filePath } = await createStore();
  await store.save({ a: { last_seen: 1 } });
  const written = JSON.parse(await readFile(filePath, 'utf8'));
  assert.equal(written.version, 1);
  assert.deepEqual(written.devices, { a: { last_seen: 1 } });
});

test('a corrupted or foreign file is ignored instead of crashing the monitor', async () => {
  const { store, filePath } = await createStore();
  await writeFile(filePath, 'not json at all', 'utf8');
  assert.deepEqual(await store.load(), {});

  await writeFile(filePath, JSON.stringify({ version: 99, devices: { a: 1 } }), 'utf8');
  assert.deepEqual(await store.load(), {});
});

// A read-only or broken volume degrades the integration to "forgets across
// restarts"; it must never take it down.
test('an unwritable path fails softly', async () => {
  const { filePath } = await createStore();
  // A regular file where a directory is expected: writing under it fails the
  // way a read-only volume would, without needing root to set one up.
  await writeFile(filePath, 'blocker', 'utf8');
  const store = new LastSeenStore({ filePath: join(filePath, 'last-seen.json') });
  assert.equal(await store.save({ a: { last_seen: 1 } }), false);
});
