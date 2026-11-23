/**
 * Times for people. The cloud and the simulation store UTC ISO strings; the family reads the
 * diary in Japan, so every time shown on a page is Japan time (Asia/Tokyo, UTC+9, no daylight
 * saving), whatever the browser's own time zone is.
 */
const JST = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

/** `2026-11-23T13:51:04.123Z` becomes `2026-11-23 22:51:04`. Text that is not a time is returned as it is. */
export function formatJst(ts: string): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return ts;
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    JST.formatToParts(date).find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}:${part("second")}`;
}
