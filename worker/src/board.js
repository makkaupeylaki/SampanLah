// Build the board (arrivals + departures) from the stored feed snapshot.
// Pure functions: no fetches, no KV, easy to test.

import { vesselKey } from "./mpa.js";

export const STALE_MS = 15 * 60e3; // a source older than this is flagged stale
const MATCH_WINDOW_MS = 12 * 3600e3; // due vs actual of the same ship must be this close
const SHOW_PAST_MS = 12 * 3600e3;
const SHOW_AHEAD_MS = 24 * 3600e3;
export const CORE_FEEDS = ["dueArr", "arr", "dueDep", "dep"];

// ---------------------------------------------------------------- categories

/**
 * "ferry" | "cruise" | "cargo" (Cargo/Other). Based on MPA's vessel type description,
 * size, and the berth's location description; SCC rows are always ferries.
 */
export function classify({ src, typeDesc, gt, len, locDescs = [] }) {
  if (src === "scc") return "ferry";
  const t = String(typeDesc || "").toUpperCase();
  const where = locDescs.join(" ").toUpperCase();
  if (/CRUISE/.test(t)) return "cruise";
  if (/PASSENGER|FERRY/.test(t)) {
    if (/CRUISE/.test(where) || gt >= 20000 || len >= 180) return "cruise";
    return "ferry";
  }
  if (/CRUISE/.test(where) && !t) return "cruise";
  if (/FERRY TERMINAL/.test(where) && !t) return "ferry";
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

// ---------------------------------------------------------------- rows

function mpaRow(dir, due, act, ctx) {
  const v = due || act;
  const key = vesselKey(v);
  const p = ctx.vessels[key] || null; // [typeCode, len, beam, gt, built, mmsi]
  const tc = p ? p[0] : "";
  const typeDesc = (tc && ctx.types[tc]) || "";
  const fromCode = (due && due.from) || (act && act.from) || "";
  const toCode = (act && act.to) || (due && due.to) || "";
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
    cat: classify({ src: "mpa", typeDesc, gt: p ? p[3] : 0, len: p ? p[1] : 0, locDescs: [ctx.locs[toCode] || "", ctx.locs[fromCode] || ""] }),
    from: dir === "arr" ? loc(fromCode) || null : null,
    to: dir === "arr" ? loc(toCode) || null : (decl && decl.next ? titleCase(decl.next) : null),
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
  // "Updated" = the oldest of the sources that are working at all, so it never overstates freshness.
  const okTimes = [mpa.okAt, scc.okAt].filter(Boolean);
  const updatedAt = okTimes.length ? Math.min(...okTimes) : null;
  return {
    updatedAt,
    checkedAt: (snap && snap.checkedAt) || null,
    stale: !updatedAt || mpa.stale || (scc.okAt ? scc.stale : false),
    sources: { mpa, scc },
    arr: rows.arr,
    dep: rows.dep,
  };
}
