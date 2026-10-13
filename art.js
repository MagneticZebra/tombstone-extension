// @ts-check

/**
 * The graveyard's pixel art. Pure: strings in, SVG markup out, no DOM.
 *
 * Every drawing is a grid of one-character cells. A cell names a paint, and a
 * paint is either a fixed colour (scenery, which is drawn as a CSS background
 * and cannot see the page's variables) or a CSS class (stones, which the
 * stylesheet recolours per stage). One cell is PIXEL CSS pixels, and every
 * drawing is emitted at that whole multiple so no edge lands between pixels.
 */

export const PIXEL = 4;

const PALETTE = {
  star: '#f4f1de',
  dimStar: '#8d93b8',
  moon: '#f2e9c9',
  moonShade: '#cbbf95',
  hill: '#0e1430',
  wood: '#080b1c',
  woodLit: '#2b3158',
  blade: '#2f5a3a',
  bladeLit: '#3f7a48',
  speck: '#12261c',
  ghost: '#dfe7ff',
  ghostShade: '#a9b4dd',
  ghostEye: '#131a3a',
};

/** @typedef {string[][]} Grid Rows of cells being drawn. '.' is empty. */
/** @typedef {ReadonlyArray<ArrayLike<string>>} Cells A finished grid, or rows written out as strings. */

/**
 * @param {number} width
 * @param {number} height
 * @returns {Grid}
 */
function blank(width, height) {
  return Array.from({ length: height }, () => Array.from({ length: width }, () => '.'));
}

/**
 * @param {Grid} grid
 * @param {number} x
 * @param {number} y
 * @param {string} cell
 */
function put(grid, x, y, cell) {
  if (y >= 0 && y < grid.length && x >= 0 && x < grid[y].length) grid[y][x] = cell;
}

/**
 * A repeatable stream of numbers in [0, 1), so the yard looks the same on
 * every load.
 * @param {number} seed
 * @returns {() => number}
 */
function dice(seed) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * One `<rect>` per horizontal run of equal cells.
 *
 * @param {Cells} grid
 * @param {(cell: string) => string} paint The attributes for a cell, e.g. `fill="#fff"`.
 * @returns {string}
 */
function rects(grid, paint) {
  let markup = '';
  grid.forEach((row, y) => {
    for (let x = 0; x < row.length;) {
      const cell = row[x];
      let end = x + 1;
      while (end < row.length && row[end] === cell) end += 1;
      if (cell !== '.') markup += `<rect x="${x}" y="${y}" width="${end - x}" height="1" ${paint(cell)}/>`;
      x = end;
    }
  });
  return markup;
}

/**
 * @param {number} width In cells.
 * @param {number} height In cells.
 * @param {string} body
 * @param {number} pixel CSS pixels per cell.
 * @returns {string}
 */
function svg(width, height, body, pixel = PIXEL) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width * pixel}" height="${height * pixel}" ` +
    `viewBox="0 0 ${width} ${height}" shape-rendering="crispEdges">${body}</svg>`
  );
}

/**
 * A standalone SVG document with fixed colours.
 *
 * @param {Cells} grid
 * @param {Record<string, string>} colours Cell to fill colour.
 * @param {number} [pixel] CSS pixels per cell.
 * @returns {string}
 */
export function picture(grid, colours, pixel) {
  return svg(
    grid[0].length,
    grid.length,
    rects(grid, (cell) => `fill="${colours[cell]}"`),
    pixel,
  );
}

function stars() {
  const grid = blank(160, 56);
  const roll = dice(7);
  for (let count = 0; count < 46; count += 1) {
    const x = Math.floor(roll() * 156) + 2;
    const y = Math.floor(roll() * 50) + 2;
    const kind = roll();
    put(grid, x, y, kind < 0.55 ? 'd' : 's');
    if (kind > 0.9) {
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ])
        put(grid, x + dx, y + dy, 'd');
    }
  }
  return picture(grid, { s: PALETTE.star, d: PALETTE.dimStar });
}

function moon() {
  return picture(
    [
      '....mmmmmm....',
      '..mmmmmmmmmm..',
      '.mmmmmmmmmmmm.',
      '.mmmmoommmmmm.',
      'mmmmooommmmmmm',
      'mmmmmoommmmmmm',
      'mmmmmmmmmmoomm',
      'mmmmmmmmmmoomm',
      'mmmommmmmmmmmm',
      'mmmoommmmmmmmo',
      '.mmmmmmmoommo.',
      '.mmmmmmmmmmoo.',
      '..mmmmmmmooo..',
      '....mmoooo....',
    ],
    { m: PALETTE.moon, o: PALETTE.moonShade },
  );
}

function hills() {
  const width = 240;
  const height = 22;
  const grid = blank(width, height);
  for (let x = 0; x < width; x += 1) {
    const turn = (x / width) * Math.PI * 2;
    const rise = Math.round(10 + 6 * Math.sin(turn) + 3 * Math.sin(turn * 3 + 1) + 2 * Math.sin(turn * 7 + 2));
    for (let y = height - rise; y < height; y += 1) put(grid, x, y, 'h');
  }
  return picture(grid, { h: PALETTE.hill });
}

function fence() {
  return picture(
    [
      '..l.....',
      '.lw.....',
      '.ww.....',
      '..w.....',
      'llllllll',
      'wwwwwwww',
      '..w.....',
      '..w.....',
      '..w.....',
      'llllllll',
      'wwwwwwww',
      '..w.....',
      '..w.....',
      '..w.....',
    ],
    { w: PALETTE.wood, l: PALETTE.woodLit },
  );
}

function tree() {
  const grid = blank(44, 52);
  const roll = dice(11);
  /**
   * @param {number} x
   * @param {number} y
   * @param {number} angle Radians, 0 is straight up.
   * @param {number} length
   * @param {number} girth
   */
  const branch = (x, y, angle, length, girth) => {
    let endX = x;
    let endY = y;
    for (let step = 0; step < length; step += 1) {
      endX = x + Math.sin(angle) * step;
      endY = y - Math.cos(angle) * step;
      for (let across = 0; across < girth; across += 1) {
        put(grid, Math.round(endX) + across, Math.round(endY), across === 0 && girth > 1 ? 'l' : 'w');
      }
    }
    if (length < 5) return;
    const forks = girth > 2 ? 3 : 2;
    for (let fork = 0; fork < forks; fork += 1) {
      const lean = (fork - (forks - 1) / 2) * 0.9 + (roll() - 0.5) * 0.5;
      branch(endX, endY, angle + lean, length * (0.55 + roll() * 0.2), Math.max(1, girth - 1));
    }
  };
  branch(20, 51, 0.08, 20, 4);
  return picture(grid, { w: PALETTE.wood, l: PALETTE.woodLit });
}

function grass() {
  const grid = blank(64, 40);
  const roll = dice(3);
  for (let count = 0; count < 16; count += 1) {
    const x = Math.floor(roll() * 60) + 2;
    const y = Math.floor(roll() * 36) + 3;
    if (roll() < 0.35) {
      put(grid, x, y, 'k');
      continue;
    }
    put(grid, x, y, 'b');
    put(grid, x, y - 1, 'b');
    put(grid, x + 2, y, 'b');
    put(grid, x + 1, y - 2, roll() < 0.5 ? 'g' : 'b');
  }
  return picture(grid, { b: PALETTE.blade, g: PALETTE.bladeLit, k: PALETTE.speck });
}

function ghost() {
  return picture(
    [
      '...gggggg...',
      '..gggggggg..',
      '.ggggggggggs',
      '.gggggggggss',
      'ggeegggeegss',
      'ggeegggeegss',
      'ggggggggggss',
      'gggggeegggss',
      'ggggggggggss',
      'ggggggggggss',
      'ggggggggggss',
      'ggggggggggss',
      'gg.ggg.gggss',
      'g...g...gg.s',
    ],
    { g: PALETTE.ghost, s: PALETTE.ghostShade, e: PALETTE.ghostEye },
  );
}

/** Tiles and props around the yard, as standalone SVG documents. */
export const SCENERY = {
  stars: stars(),
  moon: moon(),
  hills: hills(),
  fence: fence(),
  tree: tree(),
  grass: grass(),
  ghost: ghost(),
};

/** @param {string} cell */
const classed = (cell) => `class="p-${cell}"`;

const STONE_WIDTH = 32;
const STONE_HEIGHT = 38;
const SLAB_WIDTH = 28;
const SLAB_HEIGHT = 33;

/**
 * Each silhouette is its left inset per row, from the top. Rows past the end
 * of the list are the full slab. The slab is symmetrical.
 */
const SILHOUETTES = [
  [10, 7, 5, 4, 3, 2, 2, 1, 1, 1],
  [13, 12, 10, 9, 7, 6, 5, 4, 3, 2, 2, 1, 1],
  [8, 8, 8, 2, 2, 1],
  [11, 11, 11, 6, 6, 6, 11, 11, 11, 3, 2, 1, 1],
];

/** Carved above the title on the silhouettes with room for it, by index. */
const ENGRAVINGS = [
  ['.e.', 'eee', '.e.', '.e.', '.e.'],
  null,
  ['ee..eee.ee.', 'e.e..e..e.e', 'ee...e..ee.', 'e.e..e..e..', 'e.e.eee.e..'],
  null,
];
const ENGRAVING_ROW = 6;

/** The rows the title is set on. Wear and texture keep clear of them. */
const FACE_TOP = 13;
const FACE_BOTTOM = 31;

/**
 * Moss arrives in MOSS_STEPS patches as a stone's decay fraction grows. The
 * first patch belongs to decay MOSS_FROM. The last would belong to MOSS_UNTIL,
 * which is past 1, so a stone vanishes before it is covered. MOSS_REACH is the
 * share of the slab that moss ever takes.
 */
const MOSS_FROM = 0.45;
const MOSS_UNTIL = 1.05;
const MOSS_REACH = 0.6;
const MOSS_STEPS = 12;

/**
 * @param {number[]} insets
 * @param {string[] | null} engraving
 * @param {number} seed
 * @returns {string}
 */
function stone(insets, engraving, seed) {
  const roll = dice(seed);
  const left = (STONE_WIDTH - SLAB_WIDTH) / 2;
  /** @type {(x: number, y: number) => boolean} */
  const solid = (x, y) => {
    if (y < 0 || y >= SLAB_HEIGHT) return false;
    const inset = insets[y] ?? 0;
    return x >= left + inset && x < left + SLAB_WIDTH - inset;
  };

  /** @type {(x: number, y: number) => boolean} */
  const onFace = (x, y) => y >= FACE_TOP && y < FACE_BOTTOM && solid(x - 2, y) && solid(x + 2, y);
  /** @type {(x: number, y: number) => number} */
  const depth = (x, y) => {
    let cells = 0;
    while (cells < 8 && solid(x - cells, y) && solid(x + cells, y) && solid(x, y - cells)) cells += 1;
    return cells;
  };

  const slab = blank(STONE_WIDTH, STONE_HEIGHT);
  /** @type {Array<{ x: number, y: number, pull: number }>} */
  const mossable = [];
  for (let y = 0; y < SLAB_HEIGHT; y += 1) {
    for (let x = 0; x < STONE_WIDTH; x += 1) {
      if (!solid(x, y)) continue;
      const edge = !solid(x - 1, y) || !solid(x + 1, y) || !solid(x, y - 1);
      const lit = !edge && (!solid(x - 2, y) || !solid(x, y - 2));
      const shaded = !edge && !solid(x + 2, y);
      const speck = !onFace(x, y) && roll() < 0.06;
      put(slab, x, y, edge ? 'i' : lit ? 'h' : shaded || speck ? 'l' : 'm');
      mossable.push({ x, y, pull: (y / SLAB_HEIGHT) * 0.45 - depth(x, y) * 0.06 + roll() * 0.3 });
    }
  }

  engraving?.forEach((row, dy) => {
    const start = (STONE_WIDTH - row.length) / 2;
    [...row].forEach((cell, dx) => {
      if (cell !== '.') put(slab, Math.floor(start) + dx, ENGRAVING_ROW + dy, cell);
    });
  });

  // Cracks and chips stay off the face, so wear never crosses the title.
  const wear = blank(STONE_WIDTH, STONE_HEIGHT);
  /** @param {number} x @param {number} y @param {number} drift */
  const crack = (x, y, drift) => {
    while (solid(x, y) && !onFace(x, y)) {
      put(wear, x, y, 'c');
      y += 1;
      if (roll() < 0.6) x += roll() < drift ? 1 : -1;
    }
  };
  crack(left + 9 + Math.floor(roll() * 4), insets.length > 8 ? 2 : 0, 0.8);
  crack(left + SLAB_WIDTH - 9 - Math.floor(roll() * 3), 4, 0.25);
  for (let y = FACE_TOP + 1; y < FACE_BOTTOM; y += 1) {
    if (roll() < 0.22) put(wear, left + 1, y, 'c');
    if (roll() < 0.22) put(wear, left + SLAB_WIDTH - 2, y, 'c');
  }
  for (let streak = 0; streak < 4; streak += 1) {
    const x = left + 4 + Math.floor(roll() * (SLAB_WIDTH - 8));
    const from = slab.findIndex((row) => row[x] === 'm');
    const until = from + 6 + Math.floor(roll() * 14);
    for (let y = from; y < until; y += 1) {
      if (slab[y][x] === 'm') put(wear, x, y, 's');
    }
  }

  mossable.sort((a, b) => b.pull - a.pull);
  const reach = Math.floor(mossable.length * MOSS_REACH);
  let moss = '';
  for (let step = 0; step < MOSS_STEPS; step += 1) {
    const patch = blank(STONE_WIDTH, STONE_HEIGHT);
    const from = Math.floor((reach * step) / MOSS_STEPS);
    const until = Math.floor((reach * (step + 1)) / MOSS_STEPS);
    for (const { x, y } of mossable.slice(from, until)) put(patch, x, y, roll() < 0.3 ? 'G' : 'g');
    const at = MOSS_FROM + ((MOSS_UNTIL - MOSS_FROM) * step) / MOSS_STEPS;
    moss += `<g class="moss" style="--at:${at.toFixed(3)}">${rects(patch, classed)}</g>`;
  }

  const mound = blank(STONE_WIDTH, STONE_HEIGHT);
  const tufts = blank(STONE_WIDTH, STONE_HEIGHT);
  for (let x = 1; x < STONE_WIDTH - 1; x += 1) {
    const height = Math.round(1 + 4.5 * Math.sin((Math.PI * (x - 1)) / (STONE_WIDTH - 3)));
    for (let y = STONE_HEIGHT - height; y < STONE_HEIGHT; y += 1) {
      put(mound, x, y, y === STONE_HEIGHT - height ? 't' : roll() < 0.12 ? 'p' : 'd');
    }
    if (roll() < 0.3) {
      const late = roll() < 0.55;
      put(tufts, x, STONE_HEIGHT - height - 1, late ? 'U' : 'u');
      if (roll() < 0.5) put(tufts, x, STONE_HEIGHT - height - 2, late ? 'U' : 'u');
    }
  }

  return svg(
    STONE_WIDTH,
    STONE_HEIGHT,
    rects(slab, classed) +
      `<g class="wear">${rects(wear, classed)}</g>` +
      moss +
      rects(mound, classed) +
      rects(tufts, classed),
  );
}

/**
 * The stone shapes. A stone picks one by a hash of its id, so a yard is not a
 * row of identical slabs and a stone keeps its shape across redraws.
 *
 * Classes in the markup: p-i outline, p-h lit face, p-m face, p-l shaded face,
 * p-e engraving, p-c crack and p-s stain (inside the `.wear` group), p-g and
 * p-G moss (inside a `.moss` group that carries the decay fraction it appears
 * at as `--at`), p-d p-p p-t the mound's soil, pebbles and crust, p-u and p-U
 * early and late grass.
 */
export const STONES = SILHOUETTES.map((insets, index) => stone(insets, ENGRAVINGS[index], 101 + index));

/**
 * @param {string} id
 * @returns {number} An index into STONES, stable for the id.
 */
export function shapeOf(id) {
  let hash = 0;
  for (const letter of id) hash = (Math.imul(hash, 31) + letter.charCodeAt(0)) >>> 0;
  return hash % STONES.length;
}
