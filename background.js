// @ts-check

/**
 * Service worker entry point. Wiring only: it turns Chrome events into calls
 * on the ledger and the sweeper, and turns `chrome.*` into the ports they take.
 * Every listener is registered at the top level, synchronously, because MV3
 * only wakes the worker for listeners registered that way.
 *
 * No state lives in this file. The worker can be killed after any line.
 */

import { durations } from './config.js';
import { openLedger, parseTab } from './ledger.js';
import { createKeeper } from './graveyard.js';
import { createSweeper } from './sweep.js';

/** @typedef {import('./types.js').LifeId} LifeId */
/** @typedef {import('./ledger.js').TabId} TabId */
/** @typedef {import('./ledger.js').TabSnapshot} TabSnapshot */

const SWEEP_ALARM = 'sweep';
const GRAVEYARD_URL = chrome.runtime.getURL('graveyard.html');

/** @returns {Promise<TabSnapshot[]>} */
async function openTabs() {
  return (await chrome.tabs.query({})).map(parseTab).filter((tab) => tab !== null);
}

/**
 * @param {TabId} tabId
 * @returns {Promise<TabSnapshot | null>} Null when the tab is gone or incognito.
 */
function getTab(tabId) {
  return chrome.tabs.get(tabId).then(parseTab, () => null);
}

/**
 * Resolves only once the tab is gone. Chrome also rejects a removal while the
 * user drags a tab, and that must fail the sweep so the next one retries.
 *
 * @param {TabId} tabId
 * @returns {Promise<void>}
 */
async function closeTab(tabId) {
  try {
    await chrome.tabs.remove(tabId);
  } catch (error) {
    if (await getTab(tabId)) throw error;
  }
}

/**
 * `chrome.alarms.create` with the same name restarts the countdown, so this
 * reads first and creates only when the alarm is missing or has another period.
 */
async function ensureAlarm() {
  const alarm = await chrome.alarms.get(SWEEP_ALARM);
  if (alarm?.periodInMinutes === durations.sweepPeriodMinutes) return;
  await chrome.alarms.create(SWEEP_ALARM, { periodInMinutes: durations.sweepPeriodMinutes });
}

async function showGraveyard() {
  const [open] = await chrome.tabs.query({ url: GRAVEYARD_URL });
  if (open?.id === undefined) {
    await chrome.tabs.create({ url: GRAVEYARD_URL });
    return;
  }
  await chrome.tabs.update(open.id, { active: true });
  await chrome.windows.update(open.windowId, { focused: true });
}

const ledger = openLedger({
  local: chrome.storage.local,
  session: chrome.storage.session,
  openTabs,
  now: Date.now,
  mintId: () => /** @type {LifeId} */ (crypto.randomUUID()),
  restoreGraceMs: durations.restoreGraceMs,
});

const sweep = createSweeper({
  ledger,
  keeper: createKeeper(chrome.storage.local),
  getTab,
  closeTab,
  now: Date.now,
  durations,
});

chrome.tabs.onCreated.addListener((raw) => {
  const tab = parseTab(raw);
  if (tab) void ledger.born(tab);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SWEEP_ALARM) void sweep();
});

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await sweep();
  // Shown once, so a user whose old tabs were just buried sees where they went.
  if (reason === 'install') await showGraveyard();
});

chrome.runtime.onStartup.addListener(() => {
  void sweep();
});

chrome.action.onClicked.addListener(() => {
  void showGraveyard();
});

void ensureAlarm();
