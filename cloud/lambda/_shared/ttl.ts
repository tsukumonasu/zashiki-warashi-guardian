/**
 * DynamoDB TTL helpers. Pure: no AWS imports, time is always passed in.
 *
 * DynamoDB deletes expired items "typically within a few days", so readers must
 * filter on `ttl` themselves. The privacy promise depends on this filter.
 */

const SECONDS_PER_DAY = 86_400;

/** An item that may carry a DynamoDB TTL attribute (epoch seconds). */
export interface TtlItem {
  readonly ttl?: number | null;
}

/**
 * True when the item is still live at `nowSeconds` (epoch seconds).
 * An item whose `ttl` is at or before now has expired. An item without a
 * numeric `ttl` never expires.
 */
export function isLive(item: TtlItem, nowSeconds: number): boolean {
  const ttl = item.ttl;
  if (typeof ttl !== "number" || Number.isNaN(ttl)) {
    return true;
  }
  return ttl > nowSeconds;
}

/** Keeps only the live items, preserving their order. */
export function filterLive<T extends TtlItem>(
  items: readonly T[],
  nowSeconds: number,
): T[] {
  return items.filter((item) => isLive(item, nowSeconds));
}

/**
 * TTL attribute value: creation time plus `days` days, in whole epoch seconds.
 * `createdAtMs` is epoch milliseconds; sub-second parts are dropped.
 */
export function ttlFor(createdAtMs: number, days: number): number {
  return Math.floor(createdAtMs / 1000) + days * SECONDS_PER_DAY;
}
