// Singapore time helpers. SGT is UTC+8 all year (no DST).

export const SGT_OFFSET_MS = 8 * 3600e3;

/** ms -> "yyyy-MM-dd HH:mm:ss" in SGT (the format the MPA API expects). */
export function sgtStamp(ms) {
  return new Date(ms + SGT_OFFSET_MS).toISOString().slice(0, 19).replace("T", " ");
}

/** ms -> "yyyy-MM-dd" in SGT. */
export function sgtDate(ms) {
  return sgtStamp(ms).slice(0, 10);
}

/** SGT hour of day (0-23). */
export function sgtHour(ms) {
  return new Date(ms + SGT_OFFSET_MS).getUTCHours();
}

/**
 * Parse a time from the feeds into epoch ms, or null.
 * Accepts epoch ms/seconds (number or numeric string), "yyyy-MM-dd HH:mm[:ss[.SSS]]"
 * (taken as SGT), and ISO strings that carry their own offset.
 */
export function parseTime(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number" || /^\d{10,13}$/.test(String(v).trim())) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n < 1e12 ? n * 1000 : n;
  }
  const s = String(v).trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/);
  if (m) {
    const ms = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4] || "00"}+08:00`);
    return Number.isFinite(ms) ? ms : null;
  }
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}
