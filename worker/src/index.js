// harbourlah Worker: cron fetcher + JSON API.
//
//   cron */10       -> fetch MPA feeds + SCC ferry board, keep last good copy per feed, 1 KV write
//   cron 7 */6      -> refresh reference data (vessel types, locations) and the particulars snapshot
//   GET /api/board  -> arrivals + departures built from KV (no-store)
//   GET /api/vessel?imo=1234567 | ?cs=9V1234 -> one vessel's particulars (live, cached, never in KV)
//   GET /api/positions -> slim live positions for the Tracker (stored by the */10 cron, no-store)

import { mpaFeeds, fetchSnapshot, fetchReference, fetchParticulars, fetchPositions } from "./mpa.js";
import { fetchFerries } from "./scc.js";
import { buildBoard, categorisePositions, presentPositions, positionsAsVessels } from "./board.js";

const SNAP_KEY = "snap";
const REF_KEY = "ref";
const VESSELS_KEY = "vessels";
const POS_KEY = "positions";
const POS_MEMO_MS = 20e3; // per-isolate memo of stored positions (saves KV reads)
const REF_MAX_AGE_MS = 24 * 3600e3;
const BOARD_MEMO_MS = 20e3; // per-isolate memo of the built board (saves KV reads)
const REF_MEMO_MS = 10 * 60e3;
const VESSEL_CACHE_S = 6 * 3600;
const REF_CRON = "7 */6 * * *";
const REF_LOCK_KEY = "ref-attempt"; // short-lived KV marker: a lazy reference fetch was tried recently
const REF_RETRY_MS = 30 * 60e3; // at most one lazy reference fetch per 30 min (across isolates)
const REF_WAIT_MS = 8e3; // how long /api/board waits for a lazy fetch before answering without it
const REF_MISSING_MEMO_MS = 60e3; // re-check KV soon when reference data is missing

// ---------------------------------------------------------------- helpers

function corsHeaders(request, env) {
  const allowed = (env.ALLOWED_ORIGINS || "*").split(",").map((s) => s.trim());
  const origin = request.headers.get("Origin");
  let allow = "*";
  if (!allowed.includes("*")) allow = origin && allowed.includes(origin) ? origin : allowed[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
}

function json(data, { status = 200, maxAge = 0, headers = {} } = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": maxAge ? `public, max-age=${maxAge}` : "no-store",
      ...headers,
    },
  });
}

const memo = new Map();
function memoGet(key, maxAgeMs) {
  const hit = memo.get(key);
  return hit && Date.now() - hit.at < maxAgeMs ? hit.value : undefined;
}
function memoSet(key, value) {
  memo.set(key, { at: Date.now(), value });
  if (memo.size > 100) memo.delete(memo.keys().next().value);
  return value;
}
export function clearMemo() { memo.clear(); }

const errMsg = (e) => String((e && e.message) || e).slice(0, 300);

// ---------------------------------------------------------------- cron: board

/**
 * Fetch every feed. A feed that fails keeps its previous items and okAt and gets an
 * `error`, so the board keeps showing the last good data, flagged stale.
 * Exactly one KV write. Returns the new snapshot.
 */
export async function refreshBoard(env, now = Date.now()) {
  const prev = (await env.BOARD_KV.get(SNAP_KEY, "json")) || { feeds: {} };
  const jobs = { ...mpaFeeds(now), scc: () => fetchFerries(now) };
  const names = Object.keys(jobs);
  const results = await Promise.allSettled(names.map((n) => jobs[n](env)));
  const feeds = {};
  names.forEach((n, i) => {
    const r = results[i];
    const old = (prev.feeds && prev.feeds[n]) || null;
    if (r.status === "fulfilled") {
      feeds[n] = { okAt: now, error: null, items: r.value };
    } else {
      console.error(`feed ${n} failed: ${errMsg(r.reason)}`);
      feeds[n] = { okAt: old ? old.okAt : null, error: errMsg(r.reason), failedAt: now, items: old ? old.items : [] };
    }
  });
  const snap = { checkedAt: now, feeds };
  await env.BOARD_KV.put(SNAP_KEY, JSON.stringify(snap));
  console.log(
    "board: " + names.map((n) => `${n}=${feeds[n].error ? "ERR" : feeds[n].items.length}`).join(" ")
  );
  return snap;
}

// ---------------------------------------------------------------- cron: positions

/**
 * Fetch the MPA positions snapshot, slim it and store it: at most 1 KV write.
 * On failure the previous ships are kept; the error is written only when it starts
 * (so a long outage doesn't cost a write per tick), and staleness follows okAt.
 */
export async function refreshPositions(env, now = Date.now()) {
  const [prev, ref] = await Promise.all([
    env.BOARD_KV.get(POS_KEY, "json"),
    env.BOARD_KV.get(REF_KEY, "json"),
  ]);
  try {
    const { ships, types } = categorisePositions(await fetchPositions(env), ref);
    if (!ships.length) throw new Error("positions snapshot was empty");
    const next = { okAt: now, checkedAt: now, error: null, types, ships };
    await env.BOARD_KV.put(POS_KEY, JSON.stringify(next));
    console.log(`positions: ${ships.length} ships`);
    return next;
  } catch (e) {
    console.error(`positions failed: ${errMsg(e)}`);
    const next = { ...(prev || { okAt: null, types: {}, ships: [] }), error: errMsg(e), checkedAt: now };
    if (!prev || !prev.error) await env.BOARD_KV.put(POS_KEY, JSON.stringify(next));
    return next;
  }
}

// ---------------------------------------------------------------- cron: reference data

/**
 * Vessel types + location codes (daily) and the particulars snapshot (every run). <= 2 KV writes.
 * Returns what is now stored: { ref, vessels } (the previous copy for a part that failed).
 */
export async function refreshReference(env, now = Date.now(), { force = false } = {}) {
  let [ref, vessels] = await Promise.all([
    env.BOARD_KV.get(REF_KEY, "json"),
    env.BOARD_KV.get(VESSELS_KEY, "json"),
  ]);
  if (force || !ref || now - ref.at > REF_MAX_AGE_MS) {
    try {
      const r = await fetchReference(env);
      const next = {
        at: now,
        types: r.types || (ref && ref.types) || {},
        locs: r.locs || (ref && ref.locs) || {},
        errors: r.errors,
      };
      await env.BOARD_KV.put(REF_KEY, JSON.stringify(next));
      ref = next;
    } catch (e) {
      console.error(`reference failed: ${errMsg(e)}`);
    }
  }
  if (force || !vessels || now - vessels.at > 5 * 3600e3) {
    try {
      const v = await fetchSnapshot(env);
      if (Object.keys(v).length) {
        vessels = { at: now, v };
        await env.BOARD_KV.put(VESSELS_KEY, JSON.stringify(vessels));
      }
    } catch (e) {
      console.error(`snapshot failed: ${errMsg(e)}`);
    }
  }
  return { ref, vessels };
}

/** Ship labels need both the type/location lists and the per-ship snapshot. */
export const refsComplete = ({ ref, vessels } = {}) =>
  Boolean(
    ref && ref.types && Object.keys(ref.types).length &&
    vessels && vessels.v && Object.keys(vessels.v).length
  );

// Lazy reference fetch, guarded so it runs at most once at a time per isolate (shared promise)
// and at most once per REF_RETRY_MS across isolates (KV marker with a TTL). Costs <= 3 KV writes
// per attempt (marker, ref, vessels), and attempts stop as soon as the data is in KV.
let refInflight = null;
let refTriedAt = 0;

/** Start (or join) a lazy reference fetch. Returns its promise, or null when one was tried recently. */
export function lazyRefs(env, now = Date.now()) {
  if (refInflight) return refInflight;
  if (now - refTriedAt < REF_RETRY_MS) return null;
  refTriedAt = now;
  refInflight = (async () => {
    if (await env.BOARD_KV.get(REF_LOCK_KEY)) return null; // another isolate tried recently
    await env.BOARD_KV.put(REF_LOCK_KEY, String(now), { expirationTtl: REF_RETRY_MS / 1000 });
    const refs = await refreshReference(env, now);
    memoSet("refs", refs);
    return refs;
  })()
    .catch((e) => {
      console.error(`lazy reference fetch failed: ${errMsg(e)}`);
      return null;
    })
    .finally(() => {
      refInflight = null;
    });
  return refInflight;
}

export function resetRefGuard() {
  refInflight = null;
  refTriedAt = 0;
}

// ---------------------------------------------------------------- API

async function getRefs(env) {
  const hit = memoGet("refs", REF_MEMO_MS);
  // A copy missing reference data is only trusted briefly, so the cron's next write is seen soon.
  if (hit && (refsComplete(hit) || memoGet("refs", REF_MISSING_MEMO_MS))) return hit;
  const [ref, vessels] = await Promise.all([
    env.BOARD_KV.get(REF_KEY, "json"),
    env.BOARD_KV.get(VESSELS_KEY, "json"),
  ]);
  return memoSet("refs", { ref, vessels });
}

/** Reference data for the board; if KV lacks it, fetch it once (guarded), waiting up to REF_WAIT_MS. */
async function boardRefs(env, ctx) {
  const refs = await getRefs(env);
  if (refsComplete(refs)) return refs;
  const pending = lazyRefs(env);
  if (!pending) return refs;
  ctx.waitUntil(pending); // let it finish and store even if we stop waiting
  const fetched = await Promise.race([pending, new Promise((r) => setTimeout(() => r(null), REF_WAIT_MS))]);
  if (!fetched) return refs;
  // Keep whatever part was already present if the fetch only filled the other.
  return { ref: fetched.ref || refs.ref, vessels: fetched.vessels || refs.vessels };
}

let posInflight = null;

/** Stored positions (memoised ~20 s). On a fresh deploy, fetch once (one shared fetch per isolate). */
async function getPositions(env, { seed = false } = {}) {
  const hit = memoGet("positions", POS_MEMO_MS);
  if (hit !== undefined && (hit || !seed)) return hit;
  let stored = await env.BOARD_KV.get(POS_KEY, "json");
  if (!stored && seed) {
    posInflight = posInflight || refreshPositions(env).finally(() => { posInflight = null; });
    stored = await posInflight;
  }
  return memoSet("positions", stored);
}

async function handlePositions(env) {
  const hit = memoGet("positions-body", POS_MEMO_MS);
  if (hit) return json(hit);
  const body = presentPositions(await getPositions(env, { seed: true }));
  memoSet("positions-body", body);
  return json(body);
}

async function handleBoard(env, ctx) {
  const hit = memoGet("board", BOARD_MEMO_MS);
  if (hit) return json(hit);
  let snap = await env.BOARD_KV.get(SNAP_KEY, "json");
  let source = "kv";
  if (!snap) {
    // Cold start (cron hasn't run yet): fetch now and seed KV.
    snap = await refreshBoard(env);
    source = "live";
  }
  const refs = await boardRefs(env, ctx);
  // Fresher types/lengths from the 10-minute positions for ships the 6-hourly snapshot doesn't have yet.
  const positions = await getPositions(env);
  const vessels = positions
    ? { ...(refs.vessels || {}), v: { ...positionsAsVessels(positions), ...((refs.vessels && refs.vessels.v) || {}) } }
    : refs.vessels;
  const body = {
    ...buildBoard(snap, refs.ref, vessels),
    source,
    // Without reference data every MPA ship would read "Cargo/Other"; the page shows a hint.
    typesUnavailable: !refsComplete(refs),
  };
  memoSet("board", body);
  return json(body);
}

async function handleVessel(env, ctx, url) {
  const imo = (url.searchParams.get("imo") || "").trim();
  const cs = (url.searchParams.get("cs") || "").trim().toUpperCase();
  if (!(/^\d{7}$/.test(imo) || (!imo && /^[A-Z0-9]{3,10}$/.test(cs)))) {
    return json({ error: "give imo=<7 digits> or cs=<call sign>" }, { status: 400 });
  }
  const key = imo ? `imo-${imo}` : `cs-${cs}`;
  const m = memoGet(key, VESSEL_CACHE_S * 1000);
  if (m !== undefined) return json(m, { maxAge: VESSEL_CACHE_S });
  const cacheKey = new Request(`https://harbourlah.internal/vessel/${key}`);
  const cached = await caches.default.match(cacheKey);
  if (cached) return json(memoSet(key, await cached.json()), { maxAge: VESSEL_CACHE_S });
  try {
    const body = { vessel: await fetchParticulars(env, { imo, cs }) };
    memoSet(key, body);
    ctx.waitUntil(
      caches.default.put(cacheKey, new Response(JSON.stringify(body), { headers: { "Cache-Control": `max-age=${VESSEL_CACHE_S}` } }))
    );
    return json(body, { maxAge: VESSEL_CACHE_S });
  } catch (e) {
    return json({ error: `Particulars unavailable: ${errMsg(e)}` }, { status: 502 });
  }
}

// ---------------------------------------------------------------- entry

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "GET") return json({ error: "Method not allowed" }, { status: 405, headers: cors });

    let res;
    try {
      if (url.pathname === "/api/board") res = await handleBoard(env, ctx);
      else if (url.pathname === "/api/vessel") res = await handleVessel(env, ctx, url);
      else if (url.pathname === "/api/positions") res = await handlePositions(env);
      else if (url.pathname === "/" || url.pathname === "/api") {
        res = json({ name: "harbourlah", endpoints: ["/api/board", "/api/positions", "/api/vessel?imo=", "/api/vessel?cs="] });
      } else res = json({ error: "Not found" }, { status: 404 });
    } catch (e) {
      console.error(e);
      res = json({ error: errMsg(e) || "Internal error" }, { status: 500 });
    }
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    return res;
  },

  async scheduled(event, env, ctx) {
    if (event.cron === REF_CRON) {
      ctx.waitUntil(refreshReference(env));
      return;
    }
    ctx.waitUntil(
      (async () => {
        await refreshBoard(env);
        // Reference data missing (fresh deploy, failed 6-hourly run): same guarded lazy fetch.
        const [ref, vessels] = await Promise.all([
          env.BOARD_KV.get(REF_KEY, "json"),
          env.BOARD_KV.get(VESSELS_KEY, "json"),
        ]);
        if (!refsComplete({ ref, vessels })) await lazyRefs(env);
        // Last, as the heaviest step (~600 KB of JSON): if it fails, the board is already saved.
        await refreshPositions(env);
      })()
    );
  },
};
