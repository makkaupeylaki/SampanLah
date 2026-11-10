// Singapore Cruise Centre live ferry board (HarbourFront + Tanah Merah), scraped from
// https://singaporecruise.com.sg/schedule/ferries/
//
// The page is server-rendered: ?ferry-status=arrival|departure&date=yyyyMMdd&time=<slot>&pageid=N
// returns a <table class="schedule-table"> with 20 rows per page. The site sits behind
// Incapsula bot protection. We send an honest User-Agent and make no attempt to get past a
// challenge: if the table isn't in the response, this source just reports an error.

import { sgtDate, sgtHour, SGT_OFFSET_MS } from "./time.js";

export const SCC_URL = "https://singaporecruise.com.sg/schedule/ferries/";
const UA = "harbourlah/1.0 (+https://harbourlah.pages.dev; ship board using public schedules)";
const SLOTS = ["00:00hrs-05:59hrs", "06:00hrs-11:59hrs", "12:00hrs-17:59hrs", "18:00hrs-23:59hrs"];
const MAX_PAGES_PER_QUERY = 3;
const MAX_REQUESTS = 12; // per cron run, both directions together
const TIMEOUT_MS = 15e3;
// Fetch the SCC page at most every 30 min (the MPA feeds stay on the 10-minute cron). The cron runs
// every 10 min, so the slack lets a tick a few seconds early still count as "30 min later".
export const SCC_FETCH_INTERVAL_MS = 30 * 60e3;
export const SCC_FETCH_SLACK_MS = 2 * 60e3;

const MONTHS = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };

const text = (html) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** "Sun, 08 Nov 2026" -> "2026-11-08" */
function parseDate(s) {
  const m = String(s).match(/(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})/);
  if (!m || !MONTHS[m[2].toUpperCase()]) return null;
  return `${m[3]}-${String(MONTHS[m[2].toUpperCase()]).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
}

/** date + "0740" / "07:40" -> epoch ms (SGT) */
function atTime(date, hhmm) {
  const m = String(hhmm || "").match(/^(\d{1,2}):?(\d{2})$/);
  if (!date || !m) return null;
  const ms = Date.parse(`${date}T${m[1].padStart(2, "0")}:${m[2]}:00+08:00`);
  return Number.isFinite(ms) ? ms : null;
}

/** A status time near the schedule: pick the day that puts it closest (handles midnight). */
function nearTime(sched, hhmm) {
  if (sched === null) return null;
  const base = atTime(new Date(sched + SGT_OFFSET_MS).toISOString().slice(0, 10), hhmm);
  if (base === null) return null;
  let best = base;
  for (const d of [-86400e3, 86400e3]) if (Math.abs(base + d - sched) < Math.abs(best - sched)) best = base + d;
  return best;
}

const titleCase = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/\b([a-z])/g, (c) => c.toUpperCase())
    .replace(/\bHarbourfront\b/, "HarbourFront");

// Short codes (e.g. "SIN" on some Bintan trips) are kept as-is rather than guessed.
const place = (s) => (/^[A-Z]{2,4}$/.test(String(s).trim()) ? String(s).trim() : titleCase(s));

/** "BATAMFAST PTE LTD" -> "Batamfast" */
export const operatorName = (s) =>
  titleCase(String(s || "").replace(/\b(PTE\.?|LTD\.?|SDN\.?|BHD\.?|PT\.?|CO\.?)\b/gi, "").replace(/[.,]/g, "").trim());

/**
 * Parse one page. Returns { rows, hasNext, blocked, empty?, failed?, reason? }.
 * rows: { dir, trip, op, from, to, st, at, et, status }
 */
// An empty slot (e.g. 00:00-05:59) is a normal 200 page with this text instead of the table.
const NO_SCHEDULE = /no schedules? ha(?:ve|s) been found/i;
// Normal SCC site content. Every real SCC page also loads an Incapsula script, so an Incapsula
// mention alone is NOT a challenge; only a page without SCC content that mentions Incapsula is.
const SCC_SITE = /id="JsFerryFrom"|<title>[^<]*Singapore Cruise Centre/i;
const CHALLENGE = /incapsula|Request unsuccessful/i;

/**
 * Classify a page that has no schedule table.
 * Returns { empty: true } for an empty slot, else { error, blocked } where `blocked` means a real
 * bot challenge (no SCC site content + Incapsula evidence).
 */
export function classifyNonTablePage(html) {
  if (NO_SCHEDULE.test(html)) return { empty: true };
  const site = SCC_SITE.test(html);
  if (!site && CHALLENGE.test(html)) return { blocked: true, error: "bot protection challenge" };
  return { blocked: false, error: site ? "schedule table missing (page layout may have changed)" : "unexpected page" };
}

export function parseFerryPage(html, dir) {
  if (!/class="schedule-table"/.test(html)) {
    const c = classifyNonTablePage(html);
    if (c.empty) return { rows: [], hasNext: false, blocked: false, empty: true };
    return { rows: [], hasNext: false, blocked: c.blocked, failed: true, reason: c.error };
  }
  const start = html.indexOf('class="schedule-table"');
  const end = html.indexOf("</table>", start);
  const table = html.slice(start, end > 0 ? end : undefined);
  const rows = [];
  for (const m of table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const tr = m[1];
    if (/<th\b/.test(tr)) continue;
    const cell = (label) => {
      const c = tr.match(new RegExp(`data-label="${label}"[^>]*>([\\s\\S]*?)</td>`));
      return c ? text(c[1]) : "";
    };
    const date = parseDate(cell("DATE"));
    const st = atTime(date, cell("TIME"));
    if (st === null) continue;
    const statusRaw = cell("STATUS");
    const sm = statusRaw.match(/^([A-Za-z][A-Za-z \-/]*?)\s*(\d{1,2}:\d{2})?$/);
    const word = (sm ? sm[1] : statusRaw).trim().toUpperCase();
    const time = sm && sm[2];
    const row = {
      dir,
      trip: cell("TRIP ID"),
      op: operatorName(cell("FERRY OPERATOR")),
      from: place(cell("FROM")),
      to: place(cell("TO")),
      st,
      at: null,
      et: null,
      status: titleCase(word || "Scheduled"),
    };
    if (/ARRIVED|DEPARTED|LANDED/.test(word)) row.at = nearTime(st, time);
    else if (time && !/CANCEL|CONFIRM/.test(word)) row.et = nearTime(st, time);
    rows.push(row);
  }
  const page = Number((html.match(/page-item active[^>]*>\s*<span[^>]*>\s*(\d+)/) || [])[1] || 1);
  const hasNext = new RegExp(`pageid=${page + 1}\\b`).test(html);
  return { rows, hasNext, blocked: false };
}

/** The time slots to fetch: the current one and the next (which may be tomorrow's first). */
export function slotsFor(now) {
  const date = sgtDate(now);
  const i = Math.floor(sgtHour(now) / 6);
  const out = [{ date, slot: SLOTS[i] }];
  if (i < 3) out.push({ date, slot: SLOTS[i + 1] });
  else out.push({ date: sgtDate(now + 86400e3), slot: SLOTS[0] });
  return out;
}

async function getPage(params) {
  const url = `${SCC_URL}?${new URLSearchParams(params)}`;
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "text/html" },
    redirect: "follow",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`SCC HTTP ${res.status}`);
  return res.text();
}

/** Fetch arrivals and departures for the current and next time slot. */
export async function fetchFerries(now) {
  const rows = [];
  let requests = 0;
  for (const dir of ["arrival", "departure"]) {
    for (const { date, slot } of slotsFor(now)) {
      for (let page = 1; page <= MAX_PAGES_PER_QUERY && requests < MAX_REQUESTS; page++) {
        requests++;
        const params = { "ferry-status": dir, date: date.replace(/-/g, ""), time: slot };
        if (page > 1) params.pageid = String(page);
        const html = await getPage(params);
        const parsed = parseFerryPage(html, dir === "arrival" ? "arr" : "dep");
        // An empty slot just has no rows; carry on with the other slots and directions.
        if (parsed.failed) throw new Error(`SCC ferry board unavailable (${parsed.reason})`);
        rows.push(...parsed.rows);
        if (!parsed.hasNext) break;
      }
    }
  }
  // De-duplicate (pages can overlap when the board changes between requests).
  const seen = new Set();
  return rows.filter((r) => {
    const k = `${r.dir}|${r.trip}|${r.st}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
