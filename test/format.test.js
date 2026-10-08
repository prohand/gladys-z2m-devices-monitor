import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeBridge, formatDuration } from '../src/format.js';

test('formatDuration switches unit as the silence grows', () => {
  assert.equal(formatDuration(0), '0 min');
  assert.equal(formatDuration(42), '42 min');
  assert.equal(formatDuration(185), '3 h 5 min');
  assert.equal(formatDuration(4500), '3 d 3 h');
  assert.equal(formatDuration(4500, 'fr'), '3 j 3 h');
});

test('describeBridge names the unknown state instead of guessing', () => {
  assert.deepEqual(describeBridge(null), { en: 'unknown', fr: 'inconnu' });
  assert.deepEqual(describeBridge(true), { en: 'online', fr: 'en ligne' });
  assert.deepEqual(describeBridge(false), { en: 'offline', fr: 'hors ligne' });
});
