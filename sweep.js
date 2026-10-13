// @ts-check

/**
 * The sweep: which tabs die, which tombstones go, and the order of writes that
 * keeps a crash from losing a tab. No `chrome` reference. The browser arrives
 * through `SweepDeps`, so a Node test can kill the sweep at any await and run
 * it again.
 *
 * The invariants this file owns:
 *   1. A tab is closed only after its tombstone is in storage.
 *   2. One life produces at most one tombstone key, however often the sweep runs.
 *   3. A tombstone whose tab is still open is repaired by the next sweep.
 */

import { lastTouched, provenanceOf } from './ledger.js';
import { entomb, weathering } from './tombstone.js';

/** @typedef {import('./config.js').Durations} Durations */
/** @typedef {import('./types.js').LifeId} LifeId */
/** @typedef {import('./types.js').EpochMs} EpochMs */
/** @typedef {import('./ledger.js').TabId} TabId */
/** @typedef {import('./ledger.js').TabSnapshot} TabSnapshot */
/** @typedef {import('./ledger.js').Census} Census */
/** @typedef {import('./ledger.js').LedgerStore} LedgerStore */
/** @typedef {import('./ledger.js').Life} Life */
/** @typedef {import('./tombstone.js').Tombstone} Tombstone */
/** @typedef {import('./graveyard.js').Keeper} Keeper */

/**
 * Every reason a tab is spared, as one table. A new rule is a new row.
 * Incognito is absent on purpose. `parseTab` refuses incognito tabs, so they
 * never reach this file.
 *
 * @satisfies {Record<string, (tab: TabSnapshot) => boolean>}
 */
const EXEMPTIONS = {
  active: (tab) => tab.active,
  pinned: (tab) => tab.pinned,
  audible: (tab) => tab.audible,
  notWeb: (tab) => !/^https?:\/\//i.test(tab.url),
};

/**
 * @typedef {Object} SweepInput
 * @property {Census} census Every open tab with its life.
 * @property {ReadonlyArray<Tombstone>} stones Every stored tombstone.
 * @property {EpochMs} now
 * @property {Durations} durations
 */

/**
 * @typedef {Object} SweepPlan
 * @property {Array<{ tabId: TabId, life: Life, tombstone: Tombstone }>} bury
 *   Write the tombstone, then close the tab.
 * @property {LifeId[]} exhume
 *   Tombstones to delete because their tab is alive and should stay alive.
 * @property {LifeId[]} vanish
 *   Tombstones to delete because they reached the vanish age.
 */

/**
 * @typedef {Object} SweepReport
 * @property {LifeId[]} buried
 * @property {LifeId[]} exhumed
 * @property {LifeId[]} vanished
 */

/**
 * @typedef {Object} SweepDeps
 * @property {LedgerStore} ledger
 * @property {Keeper} keeper
 * @property {(tabId: TabId) => Promise<TabSnapshot | null>} getTab
 *   The tab as it is right now, or null when it no longer exists or is incognito.
 * @property {(tabId: TabId) => Promise<void>} closeTab
 *   Resolves when the tab is closed, including when it was already gone.
 * @property {() => EpochMs} now
 * @property {Durations} durations
 */

/**
 * @param {TabSnapshot} tab
 * @param {Life} life
 * @param {EpochMs} now
 * @param {Durations} durations
 * @returns {boolean}
 */
function shouldBury(tab, life, now, durations) {
  if (Object.values(EXEMPTIONS).some((spares) => spares(tab))) return false;
  return now - lastTouched(life, tab) >= durations.staleAfterMs;
}

/**
 * Pure. The whole decision, as a function of one consistent snapshot.
 *
 * A tombstone and a live tab that share a LifeId mean an earlier sweep wrote
 * the tombstone and died before closing the tab. No "pending" flag is stored.
 * The plan reads that state off the two collections:
 *
 *   tab should be buried | its life has a stone | action
 *   yes                  | no                   | bury with a new stone
 *   yes                  | yes                  | bury with the EXISTING stone, unchanged (finish the burial)
 *   no                   | yes                  | exhume (the user came back to the tab after the crash)
 *   no                   | no                   | nothing
 *
 *   stone with no live life, weathering(...).stage === 'vanished'  ->  vanish
 *
 * Reusing the existing stone in row two keeps its original `diedAt`, so a
 * retried burial writes byte-identical data.
 *
 * Race with the page: a user may resurrect a stone from row two before this
 * sweep runs. The page opens a new tab and removes the key. This sweep then
 * writes the key again and closes the old tab. The end state is one new tab
 * and one tombstone for the old one, which is what happened.
 *
 * @param {SweepInput} input
 * @returns {SweepPlan}
 */
export function planSweep({ census, stones, now, durations }) {
  const stoneOf = new Map(stones.map((stone) => [stone.id, stone]));
  const living = new Set(census.map(({ life }) => life.id));
  /** @type {SweepPlan} */
  const plan = { bury: [], exhume: [], vanish: [] };

  for (const { tab, life } of census) {
    const stone = stoneOf.get(life.id);
    if (shouldBury(tab, life, now, durations)) {
      const tombstone = stone ?? entomb(tab, life.id, provenanceOf(life, tab), lastTouched(life, tab), now);
      plan.bury.push({ tabId: tab.id, life, tombstone });
    } else if (stone) {
      plan.exhume.push(life.id);
    }
  }
  for (const stone of stones) {
    if (!living.has(stone.id) && weathering(stone, now, durations).stage === 'vanished') plan.vanish.push(stone.id);
  }
  return plan;
}

/**
 * Returns the sweep function the alarm calls. A call made while a sweep is
 * running returns that sweep's promise, so two alarms cannot overlap.
 *
 * Every step is safe to repeat: remove of a missing key, inter of an identical
 * stone, closeTab of a closed tab, and forget of a missing life all leave
 * state unchanged.
 *
 * @param {SweepDeps} deps
 * @returns {() => Promise<SweepReport>}
 */
export function createSweeper({ ledger, keeper, getTab, closeTab, now, durations }) {
  /** @returns {Promise<SweepReport>} */
  async function sweepOnce() {
    const census = await ledger.census();
    const plan = planSweep({ census, stones: await keeper.all(), now: now(), durations });
    await keeper.remove([...plan.exhume, ...plan.vanish]);

    /** @type {TabId[]} */
    const closed = [];
    /** @type {LifeId[]} */
    const buried = [];
    for (const { tabId, life, tombstone } of plan.bury) {
      // The user may have touched or closed the tab since the census. If it
      // already had a stone, the next plan exhumes it.
      const current = await getTab(tabId);
      if (!current || !shouldBury(current, life, now(), durations)) continue;
      // Killed between these two awaits, the stone exists and the life is
      // still in the ledger, and the next plan finishes or exhumes it. Killed
      // after closeTab, the next census drops the life and the stone stands.
      await keeper.inter(tombstone);
      await closeTab(tabId);
      closed.push(tabId);
      buried.push(tombstone.id);
    }
    await ledger.forget(closed);
    return { buried, exhumed: plan.exhume, vanished: plan.vanish };
  }

  /** @type {Promise<SweepReport> | null} */
  let running = null;
  return () => {
    running ??= sweepOnce().finally(() => {
      running = null;
    });
    return running;
  };
}
