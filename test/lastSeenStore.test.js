import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

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

const EMPTY = { devices: {}, verdicts: {}, heardAt: null };

test('a missing file reads as an empty history, without noise', async () => {
  const { store } = await createStore();
  assert.deepEqual(await store.load(), EMPTY);
});

test('what is saved is what is loaded back', async () => {
  const { store } = await createStore();
  const history = {
    devices: { '0x00158d0001111111': { last_seen: 1767225600000 } },
    verdicts: { '0x00158d0001111111': false },
    heardAt: 1767225700000,
  };
  assert.equal(await store.save(history), true);
  assert.deepEqual(await store.load(), history);
});

// Written by 1.0.x, before the scene triggers: no verdict means a baseline on
// the first evaluation, so an upgrade never announces the devices already dead.
test('a file written before the verdicts existed still restores its timestamps', async () => {
  const { store, filePath } = await createStore();
  const devices = { a: { last_seen: 1 } };
  await writeFile(filePath, JSON.stringify({ version: 1, devices }), 'utf8');
  assert.deepEqual(await store.load(), { devices, verdicts: {}, heardAt: null });
});

test('the file is written atomically, so a kill mid-write leaves no truncated JSON', async () => {
  const { store, filePath } = await createStore();
  await store.save({ devices: { a: { last_seen: 1 } }, verdicts: { a: true } });
  const written = JSON.parse(await readFile(filePath, 'utf8'));
  assert.equal(written.version, 1);
  assert.deepEqual(written.devices, { a: { last_seen: 1 } });
  assert.deepEqual(written.verdicts, { a: true });
});

test('a corrupted or foreign file is ignored instead of crashing the monitor', async () => {
  const { store, filePath } = await createStore();
  await writeFile(filePath, 'not json at all', 'utf8');
  assert.deepEqual(await store.load(), EMPTY);

  await writeFile(filePath, JSON.stringify({ version: 99, devices: { a: 1 } }), 'utf8');
  assert.deepEqual(await store.load(), EMPTY);
});

// A read-only or broken volume degrades the integration to "forgets across
// restarts"; it must never take it down.
test('an unwritable path fails softly', async () => {
  const { filePath } = await createStore();
  // A regular file where a directory is expected: writing under it fails the
  // way a read-only volume would, without needing root to set one up.
  await writeFile(filePath, 'blocker', 'utf8');
  const store = new LastSeenStore({ filePath: join(filePath, 'last-seen.json') });
  assert.equal(await store.save({ devices: { a: { last_seen: 1 } } }), false);
});

// The periodic save and the shutdown one can overlap. Sharing one `.tmp` path,
// the second write truncated the file the first was about to rename.
test('overlapping saves never collide, and the last one asked wins', async () => {
  const { store, filePath } = await createStore();
  const saves = Array.from({ length: 20 }, (_, index) =>
    store.save({ devices: { a: { last_seen: index } }, verdicts: {} }),
  );
  assert.deepEqual(await Promise.all(saves), Array(20).fill(true));
  const written = JSON.parse(await readFile(filePath, 'utf8'));
  assert.deepEqual(written.devices, { a: { last_seen: 19 } });
  const leftovers = (await readdir(dirname(filePath))).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, [], 'no temporary file is left behind');
});

test('two stores on the same file write through distinct temporary files', async () => {
  const { filePath } = await createStore();
  const first = new LastSeenStore({ filePath });
  const second = new LastSeenStore({ filePath });
  const results = await Promise.all([
    first.save({ devices: { a: { last_seen: 1 } } }),
    second.save({ devices: { b: { last_seen: 2 } } }),
  ]);
  assert.deepEqual(results, [true, true]);
  const written = JSON.parse(await readFile(filePath, 'utf8'));
  assert.ok(written.devices.a || written.devices.b, 'one complete history is on disk');
});

test('a failed save does not block the ones queued after it', async () => {
  const { filePath } = await createStore();
  await writeFile(filePath, 'blocker', 'utf8');
  const store = new LastSeenStore({ filePath: join(filePath, 'last-seen.json') });
  const failed = store.save({ devices: {} });
  const next = store.save({ devices: {} });
  assert.equal(await failed, false);
  assert.equal(await next, false, 'resolved, not stuck behind the failure');
});
