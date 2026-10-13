// -----------------------------------------------------------------------------
// Wording shared by every surface that speaks to the user.
//
// The Configuration screen buttons and the dashboard widget describe the same
// facts — how long a device has been quiet, whether the bridge is up — and they
// must describe them in the same words. These helpers used to live in
// `actions.js`, which made the widget depend on the button handlers for two
// pure functions; they live here so neither surface imports the other.
//
// Every message is written in the four languages of the Gladys interface; the
// core shows the reader's one and falls back on `en` for any other.
// -----------------------------------------------------------------------------

/** The languages every user-facing text is written in. */
export const LANGUAGES = ['en', 'fr', 'de', 'es'];

/** @typedef {{en: string, fr: string, de: string, es: string}} LocalizedText */

/**
 * Build a multi-language text from a function of the language — for the
 * texts computed per language (a duration, a list of devices).
 * @param {(language: string) => string} render - Renders the text in one language.
 * @returns {LocalizedText} The text in every language of `LANGUAGES`.
 */
export function inEveryLanguage(render) {
  return Object.fromEntries(LANGUAGES.map((language) => [language, render(language)]));
}

/** What a device the monitor never heard from reads instead of a duration. */
export const NEVER_SEEN = {
  en: 'never seen',
  fr: 'jamais vu',
  de: 'nie gesehen',
  es: 'nunca visto',
};

// "d" for day, in each language; any other language reads the English one.
const DAY_UNIT = { en: 'd', fr: 'j', de: 'T', es: 'd' };

/**
 * Format a duration in minutes as a compact human string.
 * @param {number} minutes - Duration in minutes.
 * @param {string} [language] - Output language (`en` for an unknown one).
 * @returns {string} e.g. "3 d 4 h", "5 h 12 min", "42 min".
 */
export function formatDuration(minutes, language = 'en') {
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const remainder = Math.floor(minutes % 60);
  const dayUnit = DAY_UNIT[language] ?? DAY_UNIT.en;
  if (days > 0) {
    return `${days} ${dayUnit} ${hours} h`;
  }
  if (hours > 0) {
    return `${hours} h ${remainder} min`;
  }
  return `${remainder} min`;
}

/**
 * Describe the bridge state, including the "we have not heard from it" case.
 * @param {boolean|null} bridgeOnline - Bridge state held by the monitor.
 * @returns {LocalizedText} A short multi-language label.
 */
export function describeBridge(bridgeOnline) {
  if (bridgeOnline === null) {
    return { en: 'unknown', fr: 'inconnu', de: 'unbekannt', es: 'desconocido' };
  }
  return bridgeOnline
    ? { en: 'online', fr: 'en ligne', de: 'online', es: 'en línea' }
    : { en: 'offline', fr: 'hors ligne', de: 'offline', es: 'desconectado' };
}
