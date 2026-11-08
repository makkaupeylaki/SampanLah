// MPA OCEANS-X API client and normalisation. All MPA-specific logic lives here.
//
// Gateway: https://oceans-x.mpa.gov.sg/api/v1/<context>/<version>/<path>
// Auth:    header "apikey: <env.MPA_API_KEY>" (Worker secret, never in code or frontend)
//
// Paths, checked against the live gateway on 8 Nov 2026 (the swagger "servers" URLs put the
// version at the end, but the gateway wants it straight after the resource):
//   vessel/duetoarrive/1.0.0/date/{yyyy-MM-dd HH:mm:ss}/hours/{N}     next N hours
//   vessel/duetodepart/1.0.0/date/{yyyy-MM-dd HH:mm:ss}/hours/{N}     next N hours
//   vessel/arrivals/1.0.0/date/{yyyy-MM-dd HH:mm:ss}/hours/{N}        past N hours
//   vessel/departure/1.0.0/date/{yyyy-MM-dd HH:mm:ss}/hours/{N}       past N hours ("departure", singular:
//                                                                      "departures" does not exist)
//   vessel/departuredeclaration/1.0.0/pastNhours?datetime=&hours=     next port, agent, pax (optional)
//   vessel/positions/1.0.0/snapshot                                    all vessels in port + particulars
//   vessel/particulars/1.1.0/imonumber/{imo}                           one vessel's particulars
//   mdhvessel/reference/types/1.0.0/filetype/json                      vessel type codes
//   mdhvessel/reference/locations/1.0.0/filetype/json                  location codes
// "movements 1.1.0" only has per-vessel lookups (imonumber/vesselname/callsign), no date query,
// so it isn't used for the board.
// Dates are SGT and must be within +/-72 h of now. Hours is 1-2 digits.

import { parseTime, sgtStamp } from "./time.js";

export const MPA_BASE = "https://oceans-x.mpa.gov.sg/api/v1";
const TIMEOUT_MS = 20e3;

export class MpaError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** GET an MPA path and return the JSON array (204 -> []). Throws MpaError. */
export async function mpaGet(env, path) {
  if (!env.MPA_API_KEY) throw new MpaError(0, "MPA_API_KEY secret is not set");
  let res;
  try {
    res = await fetch(MPA_BASE + path, {
      headers: { apikey: env.MPA_API_KEY, Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new MpaError(0, `MPA ${path.split("/").slice(1, 3).join("/")}: ${e.name === "TimeoutError" ? "timeout" : e.message}`);
  }
  if (res.status === 204) return [];
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 160);
    try {
      const j = JSON.parse(text);
      msg = (j.error && (j.error.message || j.error.description)) || j.message || j.description || msg;
    } catch { /* not JSON */ }
    throw new MpaError(res.status, `MPA ${res.status} on ${path.split("?")[0].split("/").slice(1, 4).join("/")}: ${msg}`);
  }
  if (!text.trim()) return [];
  const body = JSON.parse(text);
  if (Array.isArray(body)) return body;
  if (body && Array.isArray(body.data)) return body.data;
  if (body && Array.isArray(body.results)) return body.results;
  return [];
}

/**
 * GET a path that embeds a "yyyy-MM-dd HH:mm:ss" date. The space and colons are
 * percent-encoded; if the gateway answers 404 we retry once with literal colons
 * (the form in MPA's own examples), since the two are routed differently.
 */
export async function mpaGetDated(env, build, stamp) {
  try {
    return await mpaGet(env, build(encodeURIComponent(stamp)));
  } catch (e) {
    if (e.status !== 404) throw e;
    return mpaGet(env, build(stamp.replace(" ", "%20")));
  }
}

// ---------------------------------------------------------------- normalise

const clean = (s) => (s === null || s === undefined ? "" : String(s).trim());
/** IMO "0" / "" means unknown. */
const cleanImo = (s) => {
  const v = clean(s);
  return /^\d{7}$/.test(v) && v !== "0000000" ? v : "";
};

function vessel(row) {
  const p = (row && row.vesselParticulars) || row || {};
  return {
    n: clean(p.vesselName),
    imo: cleanImo(p.imoNumber),
    cs: clean(p.callSign).toUpperCase(),
    fl: clean(p.flag).toUpperCase(),
  };
}

/** Stable identity for matching across feeds: IMO, else call sign, else name. */
export function vesselKey(v) {
  if (v.imo) return `imo:${v.imo}`;
  if (v.cs && /^[A-Z0-9]{3,}$/.test(v.cs)) return `cs:${v.cs}`;
  return `n:${(v.n || "").toUpperCase()}`;
}

/** Feed rows -> compact items { n, imo, cs, fl, t, from, to }. Rows without a usable time are dropped. */
export function normaliseMovements(rows, timeField) {
  const out = [];
  for (const row of rows || []) {
    const t = parseTime(row && row[timeField]);
    if (t === null) continue;
    const v = vessel(row);
    if (!v.n && !v.imo && !v.cs) continue;
    const item = { ...v, t };
    if (row.locationFrom) item.from = clean(row.locationFrom).toUpperCase();
    if (row.locationTo) item.to = clean(row.locationTo).toUpperCase();
    out.push(item);
  }
  return out;
}

/** Departure declarations -> { n, imo, cs, fl, t, next, agent, pax }. */
export function normaliseDeclarations(rows) {
  const out = [];
  for (const row of rows || []) {
    const v = vessel(row);
    const t = parseTime(row.reportedDepartureTime);
    const item = { ...v, t };
    if (row.nextPort) item.next = clean(row.nextPort);
    if (row.agent) item.agent = clean(row.agent);
    if (row.pax !== undefined && row.pax !== null && row.pax !== "") item.pax = Number(row.pax) || 0;
    out.push(item);
  }
  return out;
}

/** Positions snapshot -> { key: [typeCode, length, breadth, grossTonnage, yearBuilt, mmsi] }. */
export function normaliseSnapshot(rows) {
  const out = {};
  for (const row of rows || []) {
    const p = (row && row.vesselParticulars) || {};
    const v = vessel(row);
    if (!v.imo && !v.cs) continue;
    out[vesselKey(v)] = [
      clean(p.vesselType).toUpperCase(),
      Number(p.vesselLength) || 0,
      Number(p.vesselBreadth) || 0,
      Number(p.grossTonnage) || 0,
      clean(p.yearBuilt),
      clean(p.mmsiNumber),
    ];
  }
  return out;
}

/** Reference list -> { code: description }. */
export function normaliseRef(rows, codeField, descField) {
  const out = {};
  for (const row of rows || []) {
    const c = clean(row && row[codeField]).toUpperCase();
    const d = clean(row && row[descField]);
    if (c && d) out[c] = d;
  }
  return out;
}

/** One vessel's particulars -> a display-ready object, or null. */
export function normaliseParticulars(rows) {
  const p = Array.isArray(rows) ? rows[0] : rows;
  if (!p) return null;
  const num = (x) => (Number(x) > 0 ? Number(x) : null);
  return {
    n: clean(p.vesselName),
    imo: cleanImo(p.imoNumber),
    cs: clean(p.callSign).toUpperCase(),
    fl: clean(p.flag).toUpperCase(),
    typeCode: clean(p.vesselType).toUpperCase(),
    len: num(p.vesselLength),
    beam: num(p.vesselBreadth),
    depth: num(p.vesselDepth),
    gt: num(p.grossTonnage),
    nt: num(p.netTonnage),
    dwt: num(p.deadweight),
    built: clean(p.yearBuilt) || null,
    mmsi: clean(p.mmsiNumber) || null,
  };
}

// ---------------------------------------------------------------- feeds

const PAST_H = 12; // arrivals / departures that already happened
const AHEAD_START_H = 3; // "due" windows start a little in the past, so late ships stay matched
const AHEAD_H = 27; // ... and look ~24 h ahead

/** The board feeds, each fetched independently so one failure doesn't sink the rest. */
export function mpaFeeds(now) {
  const nowStamp = sgtStamp(now);
  const dueStamp = sgtStamp(now - AHEAD_START_H * 3600e3);
  return {
    dueArr: async (env) =>
      normaliseMovements(
        await mpaGetDated(env, (d) => `/vessel/duetoarrive/1.0.0/date/${d}/hours/${AHEAD_H}`, dueStamp),
        "duetoArriveTime"
      ),
    dueDep: async (env) =>
      normaliseMovements(
        await mpaGetDated(env, (d) => `/vessel/duetodepart/1.0.0/date/${d}/hours/${AHEAD_H}`, dueStamp),
        "dueToDepart"
      ),
    arr: async (env) =>
      normaliseMovements(
        await mpaGetDated(env, (d) => `/vessel/arrivals/1.0.0/date/${d}/hours/${PAST_H}`, nowStamp),
        "arrivedTime"
      ),
    dep: async (env) =>
      normaliseMovements(
        await mpaGetDated(env, (d) => `/vessel/departure/1.0.0/date/${d}/hours/${PAST_H}`, nowStamp),
        "departedTime"
      ),
    decl: async (env) =>
      normaliseDeclarations(
        await mpaGet(
          env,
          `/vessel/departuredeclaration/1.0.0/pastNhours?datetime=${encodeURIComponent(nowStamp)}&hours=${PAST_H}`
        )
      ),
  };
}

export async function fetchSnapshot(env) {
  return normaliseSnapshot(await mpaGet(env, "/vessel/positions/1.0.0/snapshot"));
}

export async function fetchReference(env) {
  const [types, locs] = await Promise.allSettled([
    mpaGet(env, "/mdhvessel/reference/types/1.0.0/filetype/json"),
    mpaGet(env, "/mdhvessel/reference/locations/1.0.0/filetype/json"),
  ]);
  if (types.status === "rejected" && locs.status === "rejected") throw types.reason;
  return {
    types: types.status === "fulfilled" ? normaliseRef(types.value, "vesselTypeCode", "vesselTypeDescription") : null,
    locs: locs.status === "fulfilled" ? normaliseRef(locs.value, "locationCode", "locationDescription") : null,
    errors: [types, locs].filter((r) => r.status === "rejected").map((r) => r.reason.message),
  };
}

export async function fetchParticulars(env, { imo, cs }) {
  const path = imo ? `/vessel/particulars/1.1.0/imonumber/${imo}` : `/vessel/particulars/1.1.0/callsign/${cs}`;
  return normaliseParticulars(await mpaGet(env, path));
}
