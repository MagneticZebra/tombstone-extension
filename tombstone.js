// @ts-check

/**
 * The tombstone record and everything derived from it. Pure. No `chrome`.
 *
 * Stored:  id, url, title, provenance, lastTouchedAt, diedAt. Written once at
 *          burial and never changed afterwards.
 * Derived: stage, decay, and the epitaph text, all from the record plus `now`.
 *          Nothing writes a stage to storage, so a stage cannot be out of date.
 */

/** @typedef {import('./config.js').Durations} Durations */
/** @typedef {import('./types.js').LifeId} LifeId */
/** @typedef {import('./types.js').EpochMs} EpochMs */

/**
 * What a tombstone records about its tab's history. Resolved once, at burial.
 * "never read" is `kind === 'witnessed' && !read`. A found tab has no `read`
 * field, so the claim cannot be made about it.
 *
 * @typedef {{ kind: 'witnessed', openedAt: EpochMs, read: boolean }
 *         | { kind: 'found', knownSince: EpochMs }} Provenance
 */

/**
 * @typedef {Object} Tombstone
 * @property {LifeId} id The life id of the tab it buried. Also its storage key suffix.
 * @property {string} url Always http(s). The sweep buries nothing else.
 * @property {string} title
 * @property {Provenance} provenance
 * @property {EpochMs} lastTouchedAt `lastTouched(life, tab)` at burial.
 * @property {EpochMs} diedAt
 */

export const STAGES = /** @type {const} */ (['fresh', 'weathered', 'mossy', 'vanished']);

/** @typedef {typeof STAGES[number]} Stage */
/** @typedef {Exclude<Stage, 'vanished'>} LivingStage */

/**
 * Which `Durations` field starts each stage. The Record type makes the type
 * check fail when a stage is added to STAGES without a row here.
 * @type {Readonly<Record<Exclude<Stage, 'fresh'>, keyof Durations>>}
 */
const STARTS_AFTER = {
  weathered: 'weatheredAfterMs',
  mossy: 'mossyAfterMs',
  vanished: 'vanishAfterMs',
};

const LATER_STAGES = /** @type {Array<Exclude<Stage, 'fresh'>>} */ (STAGES.slice(1));

/**
 * @typedef {Object} Weathering
 * @property {Stage} stage
 * @property {number} decay 0 at burial, 1 at `vanishAfterMs`. Drives the fade between stages.
 */

/**
 * The text on a stone, already formatted. A witnessed, unread tab:
 *   { title: '14 Best Pasta Recipes', opened: 'opened 9/12', reading: 'never read', died: 'Died 9/19' }
 * A found tab reads 'open since 9/12 or earlier' and 'last visited 9/14'.
 *
 * @typedef {Object} Epitaph
 * @property {string} title
 * @property {string} opened
 * @property {string} reading
 * @property {string} died
 */

/**
 * @param {{ url: string, title: string }} tab The tab that is about to be closed.
 * @param {LifeId} id
 * @param {Provenance} provenance
 * @param {EpochMs} lastTouchedAt
 * @param {EpochMs} now
 * @returns {Tombstone}
 */
export function entomb(tab, id, provenance, lastTouchedAt, now) {
  return { id, url: tab.url, title: tab.title, provenance, lastTouchedAt, diedAt: now };
}

/**
 * @param {Tombstone} tombstone
 * @param {EpochMs} now
 * @param {Durations} durations
 * @returns {Weathering}
 */
export function weathering(tombstone, now, durations) {
  const age = now - tombstone.diedAt;
  const stage = LATER_STAGES.findLast((later) => durations[STARTS_AFTER[later]] <= age) ?? 'fresh';
  return { stage, decay: Math.min(Math.max(age / durations.vanishAfterMs, 0), 1) };
}

/**
 * The earliest future instant at which any of `tombstones` changes stage, or
 * null when none will. The graveyard page sleeps until then instead of polling.
 *
 * @param {ReadonlyArray<Tombstone>} tombstones
 * @param {EpochMs} now
 * @param {Durations} durations
 * @returns {EpochMs | null}
 */
export function nextStageChangeAt(tombstones, now, durations) {
  const upcoming = tombstones
    .flatMap((tombstone) => LATER_STAGES.map((later) => tombstone.diedAt + durations[STARTS_AFTER[later]]))
    .filter((at) => at > now);
  return upcoming.length ? Math.min(...upcoming) : null;
}

/**
 * @param {Tombstone} tombstone
 * @param {(at: EpochMs) => string} formatDate e.g. 9/12. Injected so tests fix the locale.
 * @returns {Epitaph}
 */
export function epitaphOf(tombstone, formatDate) {
  const { provenance } = tombstone;
  const visited = `last visited ${formatDate(tombstone.lastTouchedAt)}`;
  const title = tombstone.title || new URL(tombstone.url).host;
  const died = `Died ${formatDate(tombstone.diedAt)}`;
  switch (provenance.kind) {
    case 'witnessed':
      return {
        title,
        opened: `opened ${formatDate(provenance.openedAt)}`,
        reading: provenance.read ? visited : 'never read',
        died,
      };
    case 'found':
      return {
        title,
        opened: `open since ${formatDate(provenance.knownSince)} or earlier`,
        reading: visited,
        died,
      };
  }
}

/**
 * The epitaph as it is read out and shown on hover, one string per line.
 *
 * @param {Epitaph} epitaph
 * @returns {[string, string]}
 */
export function inscription(epitaph) {
  return [`Here lies ${epitaph.title}, ${epitaph.opened}, ${epitaph.reading}.`, `${epitaph.died}.`];
}

/**
 * @param {unknown} raw
 * @returns {Provenance | null}
 */
function parseProvenance(raw) {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = /** @type {Record<string, unknown>} */ (raw);
  if (record.kind === 'witnessed' && typeof record.openedAt === 'number' && typeof record.read === 'boolean') {
    return { kind: 'witnessed', openedAt: record.openedAt, read: record.read };
  }
  if (record.kind === 'found' && typeof record.knownSince === 'number') {
    return { kind: 'found', knownSince: record.knownSince };
  }
  return null;
}

/**
 * The boundary between stored JSON and the domain. Returns null for anything
 * that is not a current-shape tombstone, so a record from an older version is
 * skipped instead of crashing the page.
 *
 * @param {unknown} raw
 * @returns {Tombstone | null}
 */
export function parseTombstone(raw) {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = /** @type {Record<string, unknown>} */ (raw);
  const provenance = parseProvenance(record.provenance);
  if (
    typeof record.id !== 'string' ||
    typeof record.url !== 'string' ||
    typeof record.title !== 'string' ||
    typeof record.lastTouchedAt !== 'number' ||
    typeof record.diedAt !== 'number' ||
    provenance === null
  ) {
    return null;
  }
  return {
    id: /** @type {LifeId} */ (record.id),
    url: record.url,
    title: record.title,
    provenance,
    lastTouchedAt: record.lastTouchedAt,
    diedAt: record.diedAt,
  };
}
