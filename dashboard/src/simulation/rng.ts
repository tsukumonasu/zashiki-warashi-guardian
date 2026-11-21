// Seeded randomness and formatting helpers for the pure engine. No `Date`, no `Math.random`.

/** mulberry32. Returns a value in [0, 1) and the next 32-bit state. */
export function next(state: number): [number, number] {
  const s = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(s ^ (s >>> 15), 1 | s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return [((t ^ (t >>> 14)) >>> 0) / 4294967296, s];
}

const HEX = "0123456789abcdef";

function hex(n: number, digits: number): string {
  let out = "";
  for (let i = digits - 1; i >= 0; i--) out += HEX[(n >>> (i * 4)) & 0xf];
  return out;
}

/** UUID v4 from four draws of the generator. Returns the id and the next state. */
export function uuidV4(state: number): [string, number] {
  let s = state;
  const words: number[] = [];
  for (let i = 0; i < 4; i++) {
    const [v, ns] = next(s);
    s = ns;
    words.push(Math.floor(v * 4294967296) >>> 0);
  }
  const [w0, w1, w2, w3] = words as [number, number, number, number];
  const timeHi = ((w1 >>> 16) & 0x0fff) | 0x4000; // version 4
  const clockSeq = ((w2 >>> 16) & 0x3fff) | 0x8000; // variant 10
  const id =
    `${hex(w0, 8)}-${hex(w1, 4)}-${hex(timeHi, 4)}-${hex(clockSeq, 4)}-` +
    `${hex(w2, 4)}${hex(w3, 8)}`;
  return [id, s];
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

/** Days since 1970-01-01 to a civil date (Hinnant's algorithm), proleptic Gregorian. */
function civilFromDays(days: number): [number, number, number] {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return [yoe + era * 400 + (m <= 2 ? 1 : 0), m, d];
}

/** ISO 8601 UTC with milliseconds, for epoch milliseconds; same output as `toISOString`. */
export function formatIso(epochMs: number): string {
  const ms = Math.floor(epochMs);
  const days = Math.floor(ms / 86_400_000);
  const rest = ms - days * 86_400_000;
  const [y, mo, d] = civilFromDays(days);
  const h = Math.floor(rest / 3_600_000);
  const mi = Math.floor((rest % 3_600_000) / 60_000);
  const s = Math.floor((rest % 60_000) / 1000);
  return `${pad(y, 4)}-${pad(mo, 2)}-${pad(d, 2)}T${pad(h, 2)}:${pad(mi, 2)}:${pad(s, 2)}.${pad(rest % 1000, 3)}Z`;
}
