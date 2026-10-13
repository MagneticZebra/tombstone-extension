// @ts-check

/**
 * The only module that knows how tombstones are stored.
 *
 * Layout: one `chrome.storage.local` key per tombstone, "tomb:<LifeId>",
 * holding one immutable Tombstone. There is no index key and no array.
 *
 * Two actors write, and neither can lose the other's update, because no write
 * depends on a value read earlier:
 *   keeper  (background sweep)  set one whole key, or remove keys
 *   visitor (graveyard page)    remove one key
 * Writes to different keys do not touch each other. Two removes of one key
 * leave it removed. The only set-versus-remove collision on one key is a
 * burial retry racing a resurrection, and `planSweep` documents that outcome.
 *
 * Each actor gets a handle with only its own verbs. The page cannot inter a
 * tombstone because its handle has no such method. The key prefix and the
 * `storage.onChanged` payload shape are not exported.
 *
 * No `chrome` reference. Storage arrives as a `KeyValueArea`.
 */

import { parseTombstone, weathering, nextStageChangeAt, epitaphOf } from './tombstone.js';

/** @typedef {import('./config.js').Durations} Durations */
/** @typedef {import('./types.js').LifeId} LifeId */
/** @typedef {import('./types.js').EpochMs} EpochMs */
/** @typedef {import('./types.js').KeyValueArea} KeyValueArea */
/** @typedef {import('./tombstone.js').Tombstone} Tombstone */
/** @typedef {import('./tombstone.js').LivingStage} LivingStage */
/** @typedef {import('./tombstone.js').Epitaph} Epitaph */

const KEY_PREFIX = 'tomb:';

// setTimeout takes a signed 32-bit delay and fires at once for anything longer.
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * The background's handle.
 * @typedef {Object} Keeper
 * @property {() => Promise<Tombstone[]>} all
 *   Every stored tombstone, including ones old enough to vanish.
 * @property {(tombstone: Tombstone) => Promise<void>} inter
 *   Write the tombstone under its id. Writing the same tombstone again changes nothing.
 * @property {(ids: LifeId[]) => Promise<void>} remove
 *   Delete tombstones. Ids that are already gone are ignored.
 */

/**
 * What the page draws. The stored Tombstone does not reach the page, so the
 * storage schema can change without touching rendering code.
 *
 * @typedef {Object} Headstone
 * @property {LifeId} id
 * @property {Epitaph} epitaph
 * @property {LivingStage} stage Never 'vanished'. Vanished stones are filtered out before the page sees them.
 * @property {number} decay 0 at burial, approaching 1 at the vanish age.
 */

/**
 * @typedef {{ kind: 'resurrected' } | { kind: 'gone' }} ResurrectResult
 *   'gone' means the tombstone was already resurrected elsewhere or has vanished.
 */

/**
 * Where a resurrected tab opens: in front of the graveyard, or behind it so
 * the visitor can dig up several.
 * @typedef {'front' | 'behind'} Placement
 */

/**
 * The slice of `chrome.storage.onChanged` the visitor subscribes to.
 * @typedef {(changes: Record<string, unknown>, areaName: string) => void} ChangeListener
 * @typedef {Object} ChangeFeed
 * @property {(listener: ChangeListener) => void} addListener
 * @property {(listener: ChangeListener) => void} removeListener
 */

/**
 * @typedef {Object} VisitorDeps
 * @property {KeyValueArea} area `chrome.storage.local`
 * @property {ChangeFeed} changes `chrome.storage.onChanged`
 * @property {(url: string, placement: Placement) => Promise<unknown>} openTab
 * @property {Durations} durations
 * @property {() => EpochMs} now
 * @property {(at: EpochMs) => string} formatDate
 */

/**
 * The graveyard page's handle.
 * @typedef {Object} Visitor
 * @property {(listener: (headstones: Headstone[]) => void) => () => void} watch
 *   Calls `listener` with the full current graveyard, newest death first, once
 *   now and again whenever it changes for any reason: a burial, a resurrection
 *   in this or another graveyard tab, a vanish, or a stone crossing a stage
 *   boundary with no storage write at all. Returns an unsubscribe function.
 * @property {(id: LifeId, placement: Placement) => Promise<ResurrectResult>} resurrect
 *   Reopen the tombstone's url in a new tab, then delete the tombstone.
 */

/**
 * @param {KeyValueArea} area
 * @returns {Promise<Tombstone[]>}
 */
async function readAll(area) {
  return Object.entries(await area.get(null))
    .filter(([key]) => key.startsWith(KEY_PREFIX))
    .map(([, raw]) => parseTombstone(raw))
    .filter((tombstone) => tombstone !== null);
}

/**
 * @param {KeyValueArea} area `chrome.storage.local`
 * @returns {Keeper}
 */
export function createKeeper(area) {
  return {
    all: () => readAll(area),
    inter: (tombstone) => area.set({ [KEY_PREFIX + tombstone.id]: tombstone }),
    remove: (ids) => area.remove(ids.map((id) => KEY_PREFIX + id)),
  };
}

/**
 * @param {VisitorDeps} deps
 * @returns {Visitor}
 */
export function createVisitor({ area, changes, openTab, durations, now, formatDate }) {
  return {
    watch(listener) {
      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let stageTimer;
      let reading = false;
      let stale = false;
      let stopped = false;

      // One read at a time. A change that lands during a read asks for one
      // more read, so the listener always ends on the newest storage state.
      async function emit() {
        stale = true;
        if (reading) return;
        reading = true;
        while (stale && !stopped) {
          stale = false;
          const at = now();
          const living = (await readAll(area))
            .map((tombstone) => ({ tombstone, ...weathering(tombstone, at, durations) }))
            .filter((stone) => stone.stage !== 'vanished')
            .sort((a, b) => b.tombstone.diedAt - a.tombstone.diedAt);
          if (stopped) break;
          // Armed before the listener runs, so a listener that unsubscribes
          // also cancels it.
          clearTimeout(stageTimer);
          const next = nextStageChangeAt(
            living.map((stone) => stone.tombstone),
            at,
            durations,
          );
          if (next !== null) stageTimer = setTimeout(emit, Math.min(next - now(), MAX_TIMER_MS));
          listener(
            living.map(({ tombstone, stage, decay }) => ({
              id: tombstone.id,
              epitaph: epitaphOf(tombstone, formatDate),
              stage: /** @type {LivingStage} */ (stage),
              decay,
            })),
          );
        }
        reading = false;
      }

      /** @type {ChangeListener} */
      const onChange = (changed, areaName) => {
        if (areaName === 'local' && Object.keys(changed).some((key) => key.startsWith(KEY_PREFIX))) void emit();
      };

      // Subscribed before the first read, so a burial that lands during that
      // read triggers a second read instead of being missed.
      changes.addListener(onChange);
      void emit();

      return () => {
        stopped = true;
        clearTimeout(stageTimer);
        changes.removeListener(onChange);
      };
    },

    // The tab opens before the stone goes. A page closed between the two
    // leaves the stone standing, so the url is never lost.
    async resurrect(id, placement) {
      const key = KEY_PREFIX + id;
      const tombstone = parseTombstone((await area.get(key))[key]);
      if (!tombstone) return { kind: 'gone' };
      await openTab(tombstone.url, placement);
      await area.remove(key);
      return { kind: 'resurrected' };
    },
  };
}
