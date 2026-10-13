import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LANGUAGES, describeBridge, formatDuration, inEveryLanguage } from '../src/format.js';

test('formatDuration switches unit as the silence grows', () => {
  assert.equal(formatDuration(0), '0 min');
  assert.equal(formatDuration(42), '42 min');
  assert.equal(formatDuration(185), '3 h 5 min');
  assert.equal(formatDuration(4500), '3 d 3 h');
  assert.equal(formatDuration(4500, 'fr'), '3 j 3 h');
  assert.equal(formatDuration(4500, 'de'), '3 T 3 h');
  assert.equal(formatDuration(4500, 'es'), '3 d 3 h');
});

test('formatDuration falls back on English for a language it does not speak', () => {
  assert.equal(formatDuration(4500, 'it'), '3 d 3 h');
});

test('inEveryLanguage renders a text in each language of the Gladys interface', () => {
  assert.deepEqual(LANGUAGES, ['en', 'fr', 'de', 'es']);
  assert.deepEqual(
    inEveryLanguage((language) => formatDuration(4500, language)),
    { en: '3 d 3 h', fr: '3 j 3 h', de: '3 T 3 h', es: '3 d 3 h' },
  );
});

test('describeBridge names the unknown state instead of guessing', () => {
  assert.deepEqual(describeBridge(null), {
    en: 'unknown',
    fr: 'inconnu',
    de: 'unbekannt',
    es: 'desconocido',
  });
  assert.deepEqual(describeBridge(true), {
    en: 'online',
    fr: 'en ligne',
    de: 'online',
    es: 'en línea',
  });
  assert.deepEqual(describeBridge(false), {
    en: 'offline',
    fr: 'hors ligne',
    de: 'offline',
    es: 'desconectado',
  });
});
