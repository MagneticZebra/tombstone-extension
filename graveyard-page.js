// @ts-check

/**
 * Entry point of `graveyard.html`. Wiring only: draw whatever the visitor
 * hands over, and turn a click on a stone into `resurrect`.
 *
 * The page holds no copy of the graveyard. Each `watch` callback is the whole
 * current state, so there is no local list to keep in step with storage, and
 * a second graveyard tab stays correct without the two tabs talking.
 */

import { durations } from './config.js';
import { createVisitor } from './graveyard.js';
import { inscription } from './tombstone.js';
import { SCENERY, STONES, shapeOf } from './art.js';

/** @typedef {import('./types.js').LifeId} LifeId */
/** @typedef {import('./graveyard.js').Headstone} Headstone */

const TIP_MARGIN = 8;

const formatDay = new Intl.DateTimeFormat(undefined, { month: 'numeric', day: 'numeric' });

const graveyard = createVisitor({
  area: chrome.storage.local,
  changes: chrome.storage.onChanged,
  openTab: (url, placement) => chrome.tabs.create({ url, active: placement === 'front' }),
  durations,
  now: Date.now,
  formatDate: (at) => formatDay.format(at),
});

const yard = /** @type {HTMLElement} */ (document.getElementById('yard'));
const plots = /** @type {HTMLElement} */ (document.getElementById('plots'));
const quiet = /** @type {HTMLElement} */ (document.getElementById('quiet'));
const stillness = matchMedia('(prefers-reduced-motion: reduce)');

/** @type {Set<LifeId>} Stones clicked and not yet resolved, so a double click opens one tab. */
const rising = new Set();

const shapes = STONES.map((markup) => {
  const template = document.createElement('template');
  template.innerHTML = markup;
  return template.content;
});

for (const [name, markup] of Object.entries(SCENERY)) {
  document.documentElement.style.setProperty(
    `--art-${name}`,
    `url("data:image/svg+xml,${encodeURIComponent(markup)}")`,
  );
}
document.documentElement.style.setProperty('--rise', `${durations.riseMs}ms`);

/**
 * @param {string} className
 * @param {string} [text]
 * @returns {HTMLSpanElement}
 */
function span(className, text = '') {
  const element = document.createElement('span');
  element.className = className;
  element.textContent = text;
  return element;
}

/**
 * @param {Headstone} headstone
 * @returns {HTMLButtonElement}
 */
function carve(headstone) {
  const lines = inscription(headstone.epitaph);
  const stone = document.createElement('button');
  stone.type = 'button';
  stone.className = 'stone';
  stone.dataset.id = headstone.id;
  stone.ariaLabel = lines.join(' ');

  const face = span('face');
  face.append(span('title', headstone.epitaph.title));
  const epitaph = span('epitaph');
  epitaph.append(...lines.map((line) => span('', line)));
  stone.append(shapes[shapeOf(headstone.id)].cloneNode(true), face, epitaph);
  return stone;
}

/**
 * Brings the drawn graveyard in line with `headstones`. A stone that is still
 * standing keeps its element, so it keeps keyboard focus and its hover state.
 *
 * @param {Headstone[]} headstones
 */
function render(headstones) {
  quiet.hidden = headstones.length > 0;
  const wanted = new Set(headstones.map((headstone) => headstone.id));
  /** @type {Map<string | undefined, HTMLElement>} */
  const standing = new Map();
  for (const stone of /** @type {HTMLElement[]} */ ([...plots.children])) {
    if (wanted.has(/** @type {LifeId} */ (stone.dataset.id))) {
      standing.set(stone.dataset.id, stone);
      continue;
    }
    if (stone === document.activeElement) {
      /** @type {HTMLElement | null} */ (stone.nextElementSibling ?? stone.previousElementSibling)?.focus();
    }
    stone.remove();
  }
  headstones.forEach((headstone, index) => {
    const stone = standing.get(headstone.id) ?? carve(headstone);
    stone.dataset.stage = headstone.stage;
    stone.style.setProperty('--decay', headstone.decay.toFixed(3));
    if (plots.children[index] !== stone) plots.insertBefore(stone, plots.children[index] ?? null);
  });
}

/**
 * @param {Event} event
 * @returns {HTMLElement | null} The stone the event happened on.
 */
function stoneAt(event) {
  return /** @type {Element} */ (event.target).closest('.stone');
}

/**
 * Slides a stone's epitaph sideways, or flips it below the stone, so the
 * window edge never cuts it off.
 *
 * @param {Event} event
 */
function keepEpitaphInView(event) {
  const epitaph = /** @type {HTMLElement | null | undefined} */ (stoneAt(event)?.querySelector('.epitaph'));
  if (!epitaph) return;
  epitaph.style.removeProperty('--shift');
  epitaph.classList.remove('below');
  const box = epitaph.getBoundingClientRect();
  const overLeft = TIP_MARGIN - box.left;
  const overRight = box.right - (document.documentElement.clientWidth - TIP_MARGIN);
  if (overLeft > 0) epitaph.style.setProperty('--shift', `${overLeft}px`);
  else if (overRight > 0) epitaph.style.setProperty('--shift', `${-overRight}px`);
  epitaph.classList.toggle('below', box.top < TIP_MARGIN);
}

/** @param {HTMLElement} stone */
function raiseGhost(stone) {
  if (stillness.matches) return;
  const ghost = span('ghost');
  ghost.style.left = `${stone.offsetLeft + stone.offsetWidth / 2}px`;
  ghost.style.top = `${stone.offsetTop}px`;
  ghost.addEventListener('animationend', () => ghost.remove());
  yard.append(ghost);
}

graveyard.watch(render);

plots.addEventListener('pointerover', keepEpitaphInView);
plots.addEventListener('focusin', keepEpitaphInView);

// No redraw here. Removing the key fires storage.onChanged, and `watch`
// redraws this tab and every other graveyard tab the same way.
plots.addEventListener('click', (event) => {
  const stone = stoneAt(event);
  const id = /** @type {LifeId | undefined} */ (stone?.dataset.id);
  if (!stone || !id || rising.has(id)) return;
  const placement = event.metaKey || event.ctrlKey ? 'behind' : 'front';
  rising.add(id);
  // A tab opened in front hides this page, and a hidden page holds its
  // animations until the visitor comes back.
  if (placement === 'behind') raiseGhost(stone);
  void graveyard.resurrect(id, placement).finally(() => rising.delete(id));
});
