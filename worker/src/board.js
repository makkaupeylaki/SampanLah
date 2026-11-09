// Build the board (arrivals + departures) from the stored feed snapshot.
// Pure functions: no fetches, no KV, easy to test.

import { vesselKey } from "./mpa.js";

export const STALE_MS = 15 * 60e3; // a source older than this is flagged stale
const MATCH_WINDOW_MS = 12 * 3600e3; // due vs actual of the same ship must be this close
const SHOW_PAST_MS = 12 * 3600e3;
const SHOW_AHEAD_MS = 24 * 3600e3;
export const CORE_FEEDS = ["dueArr", "arr", "dueDep", "dep"];

// ---------------------------------------------------------------- categories

// Berths, by MPA location code and (as a fallback) by MPA's location description.
// Descriptions seen in the live data: "MARINA BAY CC BTH 1", "TANAH MERAH FERRY TERM",
// "REGIONAL FERRY PLAT 1".."6", "MARINA SOUTH FERRY TML".
//   CC01, CC01E, CC01W, CC02  HarbourFront Cruise Centre
//   CM01, CM02                Marina Bay Cruise Centre
//   RFT1-8, DFT5-8, TMFT, CFT regional/domestic ferry terminals (HarbourFront, Tanah Merah, Changi)
const CRUISE_CODE = /^(CC0[12][EW]?|CM0[12])$/i;
const FERRY_CODE = /^(RFT[1-8]|DFT[5-8]|TMFT|CFT)$/i;
const CRUISE_DESC = /cruise|\bcc\s*bth\b|marina bay cc|harbou?rfront cc|\b(mbcc|hfcc)\b/i;
const FERRY_DESC = /\bferry\b|\bfry\s*(term|tml|plat)/i;

/** "cruise" | "ferry" | null for a berth, from its code or description. */
export function berthKind(code, desc) {
  if (code && CRUISE_CODE.test(code)) return "cruise";
  if (code && FERRY_CODE.test(code)) return "ferry";
  if (desc && CRUISE_DESC.test(desc)) return "cruise";
  if (desc && FERRY_DESC.test(desc)) return "ferry";
  return null;
}

/**
 * "ferry" | "cruise" | "cargo" (Cargo/Other).
 * 1. SCC rows are ferries.
 * 2. A known vessel type decides: cruise/passenger/ferry types are cruise or ferry (by berth and
 *    size); any other known type (tanker, tug, yacht, ...) is Cargo/Other, even at a ferry berth.
 * 3. Unknown type (ship not in the particulars snapshot yet, e.g. still inbound): the berth decides.
 * All text tests are case-insensitive. `berths` is a list of { code, desc }.
 */
export function classify({ src, typeDesc, gt = 0, len = 0, berths = [] }) {
  if (src === "scc") return "ferry";
  const kinds = berths.map((b) => berthKind(b && b.code, b && b.desc));
  const atCruise = kinds.includes("cruise");
  const atFerry = kinds.includes("ferry");
  const t = String(typeDesc || "");
  if (/cruise/i.test(t)) return "cruise";
  if (/passenger|ferry/i.test(t)) return atCruise || gt >= 20000 || len >= 180 ? "cruise" : "ferry";
  if (t) return "cargo";
  if (atCruise) return "cruise";
  if (atFerry) return "ferry";
  return "cargo";
}

const titleCase = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/\b([a-z])/g, (c) => c.toUpperCase());

// ---------------------------------------------------------------- matching

/** For each "due" item find the same ship's actual movement (nearest in time, used once). */
function matchActuals(due, actual) {
  const byKey = new Map();
  actual.forEach((a, i) => {
    const k = vesselKey(a);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(i);
  });
  const used = new Set();
  const pairs = due.map((d) => {
    const cands = byKey.get(vesselKey(d)) || [];
    let best = -1;
    for (const i of cands) {
      if (used.has(i)) continue;
      const dt = Math.abs(actual[i].t - d.t);
      if (dt <= MATCH_WINDOW_MS && (best < 0 || dt < Math.abs(actual[best].t - d.t))) best = i;
    }
    if (best >= 0) used.add(best);
    return [d, best >= 0 ? actual[best] : null];
  });
  const unmatched = actual.filter((_, i) => !used.has(i));
  return { pairs, unmatched };
}

/** Latest departure declaration per ship (for next port, agent, pax). */
function declIndex(decl) {
  const m = new Map();
  for (const d of decl || []) {
    const k = vesselKey(d);
    const prev = m.get(k);
    if (!prev || (d.t || 0) > (prev.t || 0)) m.set(k, d);
  }
  return m;
}

/** Latest arrival berth code per ship (actual arrivals win over "due" entries at the same time). */
function lastBerths(arrivals) {
  const m = new Map();
  const at = new Map();
  for (const a of arrivals) {
    if (!a.to) continue;
    const k = vesselKey(a);
    if (!m.has(k) || a.t >= at.get(k)) {
      m.set(k, a.to);
      at.set(k, a.t);
    }
  }
  return m;
}

// ---------------------------------------------------------------- rows

function mpaRow(dir, due, act, ctx) {
  const v = due || act;
  const key = vesselKey(v);
  const p = ctx.vessels[key] || null; // [typeCode, len, beam, gt, built, mmsi]
  const tc = p ? p[0] : "";
  const typeDesc = (tc && ctx.types[tc]) || "";
  const fromCode = (due && due.from) || (act && act.from) || "";
  // Departures carry no berth; use where the same ship arrived (if it's in the arrival feeds).
  const toCode = (act && act.to) || (due && due.to) || (dir === "dep" ? ctx.lastBerth.get(key) || "" : "");
  const loc = (c) => (c ? titleCase(ctx.locs[c] || c) : "");
  const decl = dir === "dep" ? ctx.decl.get(key) : null;
  const st = due ? due.t : null;
  const at = act ? act.t : null;
  let status;
  if (dir === "arr") status = at ? "Arrived" : st > ctx.now ? "Expected" : "Due";
  else status = at ? "Departed" : st > ctx.now ? "Scheduled" : "Due";
  const row = {
    id: `mpa|${dir}|${key}|${st || at}`,
    src: "mpa",
    dir,
    name: v.n || v.cs || v.imo,
    imo: v.imo || null,
    cs: v.cs || null,
    fl: v.fl || null,
    tc: tc || null,
    type: typeDesc ? titleCase(typeDesc) : tc || null,
    cat: classify({ src: "mpa", typeDesc, gt: p ? p[3] : 0, len: p ? p[1] : 0, berths: [
      { code: toCode, desc: ctx.locs[toCode] || "" },
      { code: fromCode, desc: ctx.locs[fromCode] || "" },
    ] }),
    from: dir === "arr" ? loc(fromCode) || null : null,
    to: dir === "arr" ? loc(toCode) || null : (decl && decl.next ? titleCase(decl.next) : null),
    loc: toCode || null, // MPA berth/anchorage code (for departures: where it arrived, if known)
    st,
    et: null,
    at,
    status,
  };
  if (p) {
    if (p[1]) row.len = p[1];
    if (p[2]) row.beam = p[2];
    if (p[3]) row.gt = p[3];
    if (p[4]) row.built = p[4];
    if (p[5]) row.mmsi = p[5];
  }
  if (decl) {
    if (decl.agent) row.agent = titleCase(decl.agent);
    if (decl.pax) row.pax = decl.pax;
  }
  return row;
}

function sccRow(r) {
  return {
    id: `scc|${r.dir}|${r.trip}|${r.st}`,
    src: "scc",
    dir: r.dir,
    name: r.op ? `${r.op} ${r.trip}`.trim() : r.trip,
    op: r.op || null,
    trip: r.trip || null,
    imo: null,
    cs: null,
    fl: null,
    type: "Ferry",
    cat: "ferry",
    from: r.from || null,
    to: r.to || null,
    st: r.st,
    et: r.et || null,
    at: r.at || null,
    status: r.status,
  };
}

const shownTime = (r) => r.at || r.et || r.st;

// ---------------------------------------------------------------- sources

function sourceState(feeds, names, now) {
  const fs = names.map((n) => feeds[n]).filter(Boolean);
  if (!fs.length) return { okAt: null, error: "not fetched yet", stale: true };
  const oks = fs.map((f) => f.okAt || 0);
  const okAt = Math.min(...oks) || null;
  const error = (fs.find((f) => f.error) || {}).error || null;
  return { okAt, error, stale: Boolean(error) || !okAt || now - okAt > STALE_MS };
}

/**
 * snap: { checkedAt, feeds: { dueArr, arr, dueDep, dep, decl, scc: { okAt, error, items } } }
 * ref: { types, locs } | null      vessels: { v: { key: [...] } } | null
 */
export function buildBoard(snap, ref, vessels, now = Date.now()) {
  const feeds = (snap && snap.feeds) || {};
  const items = (n) => (feeds[n] && feeds[n].items) || [];
  const ctx = {
    now,
    types: (ref && ref.types) || {},
    locs: (ref && ref.locs) || {},
    vessels: (vessels && vessels.v) || {},
    decl: declIndex(items("decl")),
    lastBerth: lastBerths([...items("dueArr"), ...items("arr")]),
  };

  const rows = { arr: [], dep: [] };
  for (const [dir, dueName, actName] of [["arr", "dueArr", "arr"], ["dep", "dueDep", "dep"]]) {
    const { pairs, unmatched } = matchActuals(items(dueName), items(actName));
    for (const [d, a] of pairs) rows[dir].push(mpaRow(dir, d, a, ctx));
    for (const a of unmatched) rows[dir].push(mpaRow(dir, null, a, ctx));
  }
  for (const r of items("scc")) rows[r.dir === "arr" ? "arr" : "dep"].push(sccRow(r));

  for (const dir of ["arr", "dep"]) {
    rows[dir] = rows[dir]
      .filter((r) => {
        const t = shownTime(r);
        return t >= now - SHOW_PAST_MS && t <= now + SHOW_AHEAD_MS;
      })
      .sort((a, b) => shownTime(a) - shownTime(b) || a.name.localeCompare(b.name));
  }

  const mpa = sourceState(feeds, CORE_FEEDS, now);
  const scc = sourceState(feeds, ["scc"], now);
  // "Updated" and `stale` follow MPA, the main source. The SCC ferry board is a secondary source behind
  // bot protection that can block it for hours; its own state is in sources.scc and the page shows it
  // as a ferry note, so a blocked SCC never makes fresh MPA data look stale. If MPA has never
  // worked, fall back to SCC's time (and the board is stale).
  const updatedAt = mpa.okAt || scc.okAt || null;
  return {
    updatedAt,
    checkedAt: (snap && snap.checkedAt) || null,
    stale: !mpa.okAt || mpa.stale,
    sources: { mpa, scc },
    arr: rows.arr,
    dep: rows.dep,
  };
}

// ---------------------------------------------------------------- positions (Tracker)

/**
 * Slim positions + reference types -> { ships (each with c: category), types: { code: description } }.
 * `types` holds only the codes present, so the page can name a ship's type without per-ship strings.
 */
export function categorisePositions(ships, ref) {
  const all = (ref && ref.types) || {};
  const types = {};
  const out = (ships || []).map((s) => {
    const desc = (s.tc && all[s.tc]) || "";
    if (desc) types[s.tc] = titleCase(desc);
    return { ...s, c: classify({ src: "mpa", typeDesc: desc, gt: s.g || 0, len: s.l || 0 }) };
  });
  return { ships: out, types };
}

/** Wrap stored positions for /api/positions with the same staleness rules as the board. */
export function presentPositions(stored, now = Date.now()) {
  const okAt = (stored && stored.okAt) || null;
  const error = (stored && stored.error) || null;
  return {
    updatedAt: okAt,
    checkedAt: (stored && stored.checkedAt) || null,
    stale: !okAt || Boolean(error) || now - okAt > STALE_MS,
    error,
    count: ((stored && stored.ships) || []).length,
    types: (stored && stored.types) || {},
    ships: (stored && stored.ships) || [],
  };
}

/** Positions as a vessels map for the board ({ key: [typeCode, length, 0, gt] }), for ships the 6-hourly snapshot misses. */
export function positionsAsVessels(stored) {
  const v = {};
  for (const s of (stored && stored.ships) || []) {
    if (s.imo && s.tc) v[`imo:${s.imo}`] = [s.tc, s.l || 0, 0, s.g || 0, "", ""];
  }
  return v;
}
