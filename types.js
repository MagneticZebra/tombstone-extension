// @ts-check

/**
 * Types shared by modules that do not otherwise depend on each other.
 */

/** @typedef {number} EpochMs */

/**
 * Our id for one tab, from first sight to burial. Survives restarts.
 * The tombstone of that tab uses the same id.
 * @typedef {string & { readonly __brand: 'LifeId' }} LifeId
 */

/**
 * The slice of `chrome.storage.StorageArea` the stores use, so tests pass a
 * Map-backed fake.
 * @typedef {Object} KeyValueArea
 * @property {(keys: string | string[] | null) => Promise<Record<string, unknown>>} get
 * @property {(items: Record<string, unknown>) => Promise<void>} set
 * @property {(keys: string | string[]) => Promise<void>} remove
 */

export {};
