/** Parsing helpers shared by the HTML/JSON connectors. */

/** Collapse whitespace, normalize non-breaking spaces, trim. */
export function clean(s: string | null | undefined): string {
  if (!s) return "";
  return s.replace(/ /g, " ").replace(/\s+/g, " ").trim();
}

/** Resolve a possibly-relative href against a base URL. */
export function absolutize(base: string, href: string | null | undefined): string | null {
  if (!href) return null;
  try {
    return new URL(href, base).toString();
  } catch {
    return href.startsWith("http") ? href : null;
  }
}

/** Microsoft "/Date(1782411340000)/" -> ISO string. */
export function msDateToISO(v: string | null | undefined): string | null {
  if (!v) return null;
  const m = /\/Date\((-?\d+)\)\//.exec(v);
  if (!m) return null;
  const d = new Date(Number(m[1]));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Standard-time offsets we use to interpret portal wall-clock times (DST-aware-ish for 2026). */
export const TZ_OFFSET_MIN = {
  ET: -240, // America/New_York, EDT (UTC-4) — correct for Mar–Nov
  CT: -300, // America/Chicago, CDT (UTC-5)
} as const;

/**
 * Parse US-style "M/D/YYYY", "M/D/YYYY h:mm[:ss] AM/PM", or with a trailing tz
 * abbreviation (CDT/EST...). Interprets the wall time as `offsetMinutes` from UTC.
 * Returns an ISO datetime string (UTC) or null.
 */
export function usDateToISO(
  input: string | null | undefined,
  offsetMinutes: number = TZ_OFFSET_MIN.ET,
): string | null {
  if (!input) return null;
  const s = clean(input);
  const m =
    /(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?/.exec(s);
  if (!m) return null;
  const [, moStr, dStr, yStr, hStr, minStr, secStr, ap] = m;
  let year = Number(yStr);
  if (year < 100) year += 2000;
  let hour = hStr ? Number(hStr) : 0;
  const min = minStr ? Number(minStr) : 0;
  const sec = secStr ? Number(secStr) : 0;
  if (ap) {
    const pm = /p/i.test(ap);
    if (pm && hour < 12) hour += 12;
    if (!pm && hour === 12) hour = 0;
  }
  const utcMs = Date.UTC(year, Number(moStr) - 1, Number(dStr), hour, min, sec) - offsetMinutes * 60_000;
  const d = new Date(utcMs);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Extract all M/D/YYYY date tokens in order (TN/AR list cells stack two dates). */
export function findDates(text: string): string[] {
  return clean(text).match(/[0-1]?\d\/[0-3]?\d\/20\d{2}/g) ?? [];
}

/** Truncate a free-text description to a sane stored length. */
export function trimDescription(s: string | null | undefined, max = 4000): string | null {
  const c = clean(s);
  if (!c) return null;
  return c.length > max ? c.slice(0, max) : c;
}
