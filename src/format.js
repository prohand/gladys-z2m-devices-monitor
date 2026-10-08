// -----------------------------------------------------------------------------
// Wording shared by every surface that speaks to the user.
//
// The Configuration screen buttons and the dashboard widget describe the same
// facts — how long a device has been quiet, whether the bridge is up — and they
// must describe them in the same words. These helpers used to live in
// `actions.js`, which made the widget depend on the button handlers for two
// pure functions; they live here so neither surface imports the other.
// -----------------------------------------------------------------------------

/**
 * Format a duration in minutes as a compact human string.
 * @param {number} minutes - Duration in minutes.
 * @param {'en'|'fr'} [language] - Output language.
 * @returns {string} e.g. "3 d 4 h", "5 h 12 min", "42 min".
 */
export function formatDuration(minutes, language = 'en') {
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const remainder = Math.floor(minutes % 60);
  const dayUnit = language === 'en' ? 'd' : 'j';
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
 * @returns {{en: string, fr: string}} A short multi-language label.
 */
export function describeBridge(bridgeOnline) {
  if (bridgeOnline === null) {
    return { en: 'unknown', fr: 'inconnu' };
  }
  return bridgeOnline ? { en: 'online', fr: 'en ligne' } : { en: 'offline', fr: 'hors ligne' };
}
