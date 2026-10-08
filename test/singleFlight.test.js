import { test } from 'node:test';
import assert from 'node:assert/strict';
import { singleFlight } from '../src/singleFlight.js';

/**
 * A task whose runs are released by hand, recording how many overlap.
 * @returns {{task: Function, release: Function, runs: number, maxConcurrent: number}} The probe.
 */
function createProbe() {
  const probe = {
    runs: 0,
    active: 0,
    maxConcurrent: 0,
    releases: [],
    task: async () => {
      probe.runs += 1;
      probe.active += 1;
      probe.maxConcurrent = Math.max(probe.maxConcurrent, probe.active);
      await new Promise((resolve) => probe.releases.push(resolve));
      probe.active -= 1;
      return probe.runs;
    },
    async release() {
      // Let the queued microtasks start the next run before releasing it.
      for (let index = 0; index < 5 && probe.releases.length === 0; index += 1) {
        await Promise.resolve();
      }
      probe.releases.shift()?.();
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
  return probe;
}

test('runs never overlap, and the requests made meanwhile share one trailing run', async () => {
  const probe = createProbe();
  const run = singleFlight(probe.task);

  const first = run();
  const second = run();
  const third = run();
  assert.equal(second, third, 'the waiting requests share the same promise');

  await probe.release();
  assert.equal(await first, 1);
  await probe.release();
  assert.equal(await second, 2);
  assert.equal(await third, 2);
  assert.equal(probe.runs, 2, 'three requests, two runs');
  assert.equal(probe.maxConcurrent, 1);
});

test('a request after the end of a run starts a fresh one', async () => {
  const probe = createProbe();
  const run = singleFlight(probe.task);
  const first = run();
  await probe.release();
  await first;
  const next = run();
  await probe.release();
  assert.equal(await next, 2);
});

test('a failed run does not fail the requests queued behind it', async () => {
  let calls = 0;
  let releaseFirst;
  const run = singleFlight(async () => {
    calls += 1;
    if (calls === 1) {
      await new Promise((resolve) => {
        releaseFirst = resolve;
      });
      throw new Error('first run failed');
    }
    return 'ok';
  });
  const first = run();
  const queued = run();
  await Promise.resolve();
  releaseFirst();
  await assert.rejects(first, /first run failed/);
  assert.equal(await queued, 'ok');
});
