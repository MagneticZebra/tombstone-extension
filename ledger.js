// @ts-check

/**
 * The ledger is everything we know about tabs that are still open.
 * It answers "when was this tab opened" and "was it ever read", which Chrome
 * does not record, and it gives each tab an id that survives a browser restart.
 *
 * Storage it owns:
 *   chrome.storage.local    "ledger"          the Ledger below
 *   chrome.storage.session  "ledger.adopted"  present once this browser session's tab ids are matched
 *
 * One writer: the background service worker. The graveyard page never reads or
 * writes the ledger. No `chrome` reference in this file. The browser arrives
 * through `LedgerDeps`, so everything here runs in Node.
 */

/** @typedef {import('./types.js').EpochMs} EpochMs */
/** @typedef {import('./types.js').LifeId} LifeId */
/** @typedef {import('./types.js').KeyValueArea} KeyValueArea */
/** @typedef {import('./tombstone.js').Provenance} Provenance */

/**
 * Chrome's tab id. Valid for one browser session. Never stored outside the ledger.
 * @typedef {number & { readonly __brand: 'TabId' }} TabId
 */

/**
 * A tab as the rest of the code sees it. `parseTab` is the only constructor.
 * Incognito tabs never become a TabSnapshot, so no module can store or bury one.
 *
 * @typedef {Object} TabSnapshot
 * @property {TabId} id
 * @property {string} url `tab.url`, else `tab.pendingUrl`, else ''.
 * @property {string} title
 * @property {EpochMs} lastAccessed
 * @property {boolean} active
 * @property {boolean} pinned
 * @property {boolean} audible
 */

/**
 * The fields of `chrome.tabs.Tab` that `parseTab` reads.
 * @typedef {Object} RawTab
 * @property {number} [id]
 * @property {string} [url]
 * @property {string} [pendingUrl]
 * @property {string} [title]
 * @property {number} [lastAccessed]
 * @property {boolean} [active]
 * @property {boolean} [pinned]
 * @property {boolean} [audible]
 * @property {boolean} [incognito]
 */

/**
 * How a tab came to our attention.
 *
 * witnessed: `tabs.onCreated` fired while we were installed. `openedAt` is our
 *   clock at that moment and `bornAccessed` is Chrome's `lastAccessed` in that
 *   same event.
 * found: the tab was already open when we first saw it (at install, or after a
 *   restart we could not match). Its real opening time is unknown, so a found
 *   tab can never be called "never read". `knownSince` is the earlier of the
 *   first sighting and the tab's `lastAccessed` at that sighting.
 *
 * @typedef {{ kind: 'witnessed', openedAt: EpochMs, bornActive: boolean, bornAccessed: EpochMs }
 *         | { kind: 'found', knownSince: EpochMs }} Origin
 */

/**
 * @typedef {Object} Life
 * @property {LifeId} id
 * @property {Origin} origin
 * @property {string} url As of the last census. Read only to re-pair lives with tabs after a restart.
 * @property {EpochMs} lastAccessed Chrome's `lastAccessed` as the ledger last saw it.
 * @property {EpochMs} touchedAt When the tab was last in front, as far as the ledger knows.
 *   Chrome's `lastAccessed` cannot be the staleness clock on its own, for two
 *   measured reasons. It is the activation time and does not advance while a
 *   tab stays active, so a tab left after a week in front would look a week
 *   stale. And session restore gives a tab that was never activated a fresh
 *   `lastAccessed`, so its clock would start again at every browser restart.
 */

/**
 * @typedef {{ life: Life, orphanedAt: EpochMs }} Orphan
 */

/**
 * @typedef {Object} Ledger
 * @property {Readonly<Record<string, Life>>} lives Keyed by the TabId of the current browser session.
 * @property {ReadonlyArray<Orphan>} orphans
 *   Lives from an earlier browser session whose tab has not come back yet.
 *   A tab that appears with the same url adopts one. The rest expire after
 *   `restoreGraceMs`, because session restore can deliver tabs late.
 */

/**
 * Every open tab joined with its life. `census()` guarantees the join is
 * total, so a consumer never looks a life up and never handles a miss.
 * @typedef {ReadonlyArray<{ tab: TabSnapshot, life: Life }>} Census
 */

/**
 * @typedef {Object} LedgerDeps
 * @property {KeyValueArea} local
 * @property {KeyValueArea} session
 * @property {() => Promise<TabSnapshot[]>} openTabs All open, non-incognito tabs, already parsed.
 * @property {() => EpochMs} now
 * @property {() => LifeId} mintId
 * @property {number} restoreGraceMs
 */

/**
 * @typedef {Object} LedgerStore
 * @property {(tab: TabSnapshot) => Promise<void>} born
 *   Record a tab that `tabs.onCreated` just delivered. No-op if the tab already has a life.
 * @property {() => Promise<Census>} census
 *   Read the open tabs, reconcile the ledger against them, persist it, and return the join.
 * @property {(tabIds: TabId[]) => Promise<void>} forget
 *   Drop the lives of tabs the sweep just closed. No-op for ids already gone.
 */

const LEDGER_KEY = 'ledger';
const ADOPTED_KEY = 'ledger.adopted';

/** @type {Ledger} */
const EMPTY = { lives: {}, orphans: [] };

/**
 * The boundary between `chrome.tabs.Tab` and the domain. Returns null for a
 * tab we must never track: incognito, or missing an id or `lastAccessed`.
 *
 * @param {RawTab} raw
 * @returns {TabSnapshot | null}
 */
export function parseTab(raw) {
  if (raw.incognito || raw.id === undefined || raw.lastAccessed === undefined) return null;
  return {
    id: /** @type {TabId} */ (raw.id),
    url: raw.url || raw.pendingUrl || '',
    title: raw.title ?? '',
    lastAccessed: raw.lastAccessed,
    active: raw.active ?? false,
    pinned: raw.pinned ?? false,
    audible: raw.audible ?? false,
  };
}

/**
 * The staleness clock, defined once. A `lastAccessed` that moved since the
 * ledger last saw it is a visit. One that did not move says nothing new, and
 * the ledger's own record stands.
 *
 * @param {Life} life
 * @param {TabSnapshot} tab
 * @returns {EpochMs}
 */
export function lastTouched(life, tab) {
  return tab.lastAccessed === life.lastAccessed ? life.touchedAt : Math.max(life.touchedAt, tab.lastAccessed);
}

/**
 * Hands a life from an earlier browser session to the tab that carries it
 * now. The restart, not a visit, changed the tab's `lastAccessed`, so the life
 * takes the new value and keeps its `touchedAt`.
 *
 * @param {Life} life
 * @param {TabSnapshot} tab
 * @returns {Life}
 */
function carriedOver(life, tab) {
  return { ...life, lastAccessed: tab.lastAccessed };
}

/**
 * A tab with no life takes the oldest orphan that has its url. Otherwise the
 * caller's `fallback` origin starts a new life.
 *
 * @param {Ledger} ledger
 * @param {TabSnapshot} tab
 * @param {() => LifeId} mintId
 * @param {Origin} fallback
 * @returns {Ledger}
 */
function admit(ledger, tab, mintId, fallback) {
  const orphan = ledger.orphans.find((candidate) => candidate.life.url === tab.url);
  /** @type {Life} */
  const life = orphan
    ? carriedOver(orphan.life, tab)
    : { id: mintId(), origin: fallback, url: tab.url, lastAccessed: tab.lastAccessed, touchedAt: tab.lastAccessed };
  return {
    lives: { ...ledger.lives, [tab.id]: life },
    orphans: ledger.orphans.filter((candidate) => candidate !== orphan),
  };
}

/**
 * @param {TabSnapshot} tab
 * @param {EpochMs} now
 * @returns {Origin}
 */
function foundAt(tab, now) {
  return { kind: 'found', knownSince: Math.min(now, tab.lastAccessed) };
}

/**
 * Pure. Gives `tab` a life. A tab whose url matches an orphan adopts that
 * orphan, because session restore fires `onCreated` for tabs that are not new.
 * Returns the same ledger object when the tab already has a life, so a
 * duplicate or late `onCreated` cannot overwrite an older origin.
 *
 * @param {Ledger} ledger
 * @param {TabSnapshot} tab
 * @param {EpochMs} now
 * @param {() => LifeId} mintId
 * @returns {Ledger}
 */
export function witnessBirth(ledger, tab, now, mintId) {
  if (ledger.lives[tab.id]) return ledger;
  return admit(ledger, tab, mintId, {
    kind: 'witnessed',
    openedAt: now,
    bornActive: tab.active,
    bornAccessed: tab.lastAccessed,
  });
}

/**
 * Pure. Same-session reconcile. Tab ids are trusted.
 *   - a life whose tab id is no longer open is dropped
 *   - an open tab with no life adopts an orphan with the same url, else gets a
 *     found life (we missed its birth)
 *   - every surviving life gets its `url` and `lastAccessed` refreshed, and its
 *     `touchedAt` moved to `now` when its tab is active, else to `lastTouched`
 *   - an orphan older than `restoreGraceMs` is dropped
 * Running it twice on the same input returns an equal ledger.
 *
 * @param {Ledger} ledger
 * @param {TabSnapshot[]} tabs
 * @param {EpochMs} now
 * @param {() => LifeId} mintId
 * @param {number} restoreGraceMs
 * @returns {Ledger}
 */
export function reconcile(ledger, tabs, now, mintId, restoreGraceMs) {
  /** @type {Ledger} */
  let next = {
    lives: Object.fromEntries(tabs.flatMap((tab) => (ledger.lives[tab.id] ? [[tab.id, ledger.lives[tab.id]]] : []))),
    orphans: ledger.orphans.filter((orphan) => now - orphan.orphanedAt <= restoreGraceMs),
  };
  for (const tab of tabs) {
    if (!next.lives[tab.id]) next = admit(next, tab, mintId, foundAt(tab, now));
  }
  return {
    lives: Object.fromEntries(
      tabs.map((tab) => {
        const life = next.lives[tab.id];
        const touchedAt = tab.active ? now : lastTouched(life, tab);
        return [tab.id, { ...life, url: tab.url, lastAccessed: tab.lastAccessed, touchedAt }];
      }),
    ),
    orphans: next.orphans,
  };
}

/**
 * Pure. Cross-session reconcile, for the first ledger access after a browser
 * restart or an extension reload. Tab ids in `ledger` are from a dead session
 * and are ignored as keys.
 *
 *   1. Pair each old life with at most one open tab that has the same url.
 *      Among several candidates prefer an equal tab id, then the closest
 *      `lastAccessed`.
 *   2. A paired tab keeps the old life: same LifeId, same origin, new tab id
 *      key. An equal tab id means an extension reload inside one browser
 *      session, where a changed `lastAccessed` is a real visit. Any other
 *      pairing is a browser restart, and the life is `carriedOver`.
 *   3. An unpaired tab adopts an orphan with its url, else gets a found life.
 *   4. An unpaired old life becomes an orphan stamped `orphanedAt = now`.
 *      `reconcile` and `witnessBirth` let a late tab adopt it.
 *
 * Keeping the LifeId across the restart is what lets the next sweep see that a
 * tombstone and a live tab belong to the same life (see `planSweep`).
 *
 * @param {Ledger} ledger
 * @param {TabSnapshot[]} tabs
 * @param {EpochMs} now
 * @param {() => LifeId} mintId
 * @returns {Ledger}
 */
export function readopt(ledger, tabs, now, mintId) {
  const pairs = Object.entries(ledger.lives)
    .flatMap(([oldTabId, life]) =>
      tabs
        .filter((tab) => tab.url === life.url)
        .map((tab) => ({
          life,
          tab,
          drift: Math.abs(tab.lastAccessed - life.lastAccessed),
          sameId: String(tab.id) === oldTabId,
        })),
    )
    .sort((a, b) => Number(b.sameId) - Number(a.sameId) || a.drift - b.drift);

  /** @type {Map<TabId, Life>} */
  const lifeOfTab = new Map();
  /** @type {Set<Life>} */
  const paired = new Set();
  for (const { life, tab, sameId } of pairs) {
    if (paired.has(life) || lifeOfTab.has(tab.id)) continue;
    lifeOfTab.set(tab.id, sameId ? life : carriedOver(life, tab));
    paired.add(life);
  }

  /** @type {Ledger} */
  let next = { lives: Object.fromEntries(lifeOfTab), orphans: ledger.orphans };
  for (const tab of tabs) {
    if (!lifeOfTab.has(tab.id)) next = admit(next, tab, mintId, foundAt(tab, now));
  }
  const stranded = Object.values(ledger.lives).filter((life) => !paired.has(life));
  return { lives: next.lives, orphans: [...next.orphans, ...stranded.map((life) => ({ life, orphanedAt: now }))] };
}

/**
 * Pure. Removes the lives keyed by `tabIds`.
 *
 * @param {Ledger} ledger
 * @param {TabId[]} tabIds
 * @returns {Ledger}
 */
export function forget(ledger, tabIds) {
  const gone = new Set(tabIds.map(String));
  return {
    lives: Object.fromEntries(Object.entries(ledger.lives).filter(([tabId]) => !gone.has(tabId))),
    orphans: ledger.orphans,
  };
}

/**
 * Pure. The answer to "opened when, and ever read?" for a tab about to be buried.
 *
 * `lastAccessed` is the time the tab last became active, and a foreground and
 * a background tab both report their creation time, so `bornActive` carries
 * the foreground case. A tab born in the background was read if it has been
 * touched since. Measured: until then Chrome keeps reporting the exact
 * `lastAccessed` of the `onCreated` event.
 *
 * @param {Life} life
 * @param {TabSnapshot} tab The tab as it is now, at burial.
 * @returns {Provenance}
 */
export function provenanceOf(life, tab) {
  const { origin } = life;
  switch (origin.kind) {
    case 'witnessed':
      return {
        kind: 'witnessed',
        openedAt: origin.openedAt,
        read: origin.bornActive || lastTouched(life, tab) > origin.bornAccessed,
      };
    case 'found':
      return origin;
  }
}

/**
 * The only reader and writer of the "ledger" key.
 *
 * Two rules live behind the three methods, so no caller thinks about either:
 *
 *   Ordering. Every method runs on one promise chain, so `onCreated` handlers
 *   and the sweep cannot interleave their read-modify-write of the key. The
 *   chain is enough because the service worker is the ledger's only writer and
 *   Chrome runs one service worker realm at a time.
 *
 *   Restarts. Before the first method of a browser session touches the ledger
 *   (the "ledger.adopted" session key is absent), the store runs `readopt`,
 *   persists it, and sets the key. `chrome.storage.session` is cleared exactly
 *   when tab ids stop being valid, so the marker cannot outlive the ids it
 *   vouches for.
 *
 * @param {LedgerDeps} deps
 * @returns {LedgerStore}
 */
export function openLedger({ local, session, openTabs, now, mintId, restoreGraceMs }) {
  /** @type {Promise<unknown>} */
  let chain = Promise.resolve();

  /** @returns {Promise<Ledger>} */
  async function load() {
    const stored = /** @type {Ledger | undefined} */ ((await local.get(LEDGER_KEY))[LEDGER_KEY]) ?? EMPTY;
    if (ADOPTED_KEY in (await session.get(ADOPTED_KEY))) return stored;
    const adopted = readopt(stored, await openTabs(), now(), mintId);
    await local.set({ [LEDGER_KEY]: adopted });
    await session.set({ [ADOPTED_KEY]: true });
    return adopted;
  }

  /**
   * @param {(ledger: Ledger) => Ledger | Promise<Ledger>} transition
   * @returns {Promise<Ledger>}
   */
  function enqueue(transition) {
    const result = chain.then(async () => {
      const ledger = await load();
      const next = await transition(ledger);
      if (next !== ledger) await local.set({ [LEDGER_KEY]: next });
      return next;
    });
    // A failed step must not block the steps queued behind it.
    chain = result.catch(() => {});
    return result;
  }

  return {
    async born(tab) {
      await enqueue((ledger) => witnessBirth(ledger, tab, now(), mintId));
    },
    async census() {
      /** @type {TabSnapshot[]} */
      let tabs = [];
      const ledger = await enqueue(async (current) => {
        tabs = await openTabs();
        return reconcile(current, tabs, now(), mintId, restoreGraceMs);
      });
      return tabs.map((tab) => ({ tab, life: ledger.lives[tab.id] }));
    },
    async forget(tabIds) {
      await enqueue((ledger) => forget(ledger, tabIds));
    },
  };
}
