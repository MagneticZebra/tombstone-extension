// @ts-check

/**
 * Every duration in the extension lives in this file and nowhere else.
 * The end-to-end harness swaps this one file for a copy with short values.
 *
 * Only the two entry points import it (`background.js`, `graveyard-page.js`).
 * Every module below them takes its durations as arguments, so a Node test
 * passes its own values and never depends on the production ones.
 *
 * @typedef {Object} Durations
 * @property {number} staleAfterMs A tab untouched for this long is buried.
 * @property {number} restoreGraceMs After a browser restart, a ledger life waits at least this long for its tab to come back.
 * @property {number} sweepPeriodMinutes Period of the `chrome.alarms` sweep.
 * @property {number} weatheredAfterMs Age since death at which a tombstone turns weathered.
 * @property {number} mossyAfterMs Age since death at which it turns mossy.
 * @property {number} vanishAfterMs Age since death at which it is deleted for good.
 * @property {number} riseMs Length of the ghost animation on resurrection.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** @type {Readonly<Durations>} */
export const durations = Object.freeze({
  staleAfterMs: 7 * DAY_MS,
  restoreGraceMs: 10 * 60 * 1000,
  sweepPeriodMinutes: 30,
  weatheredAfterMs: 7 * DAY_MS,
  mossyAfterMs: 21 * DAY_MS,
  vanishAfterMs: 30 * DAY_MS,
  riseMs: 500,
});
