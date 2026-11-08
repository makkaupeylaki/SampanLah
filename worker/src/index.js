// harbourlah Worker: cron fetcher + JSON API.
//
//   cron */10       -> fetch MPA feeds + SCC ferry board, keep last good copy per feed, 1 KV write
//   cron 7 */6      -> refresh reference data (vessel types, locations) and the particulars snapshot
//   GET /api/board  -> arrivals + departures built from KV (no-store)
//   GET /api/vessel?imo=1234567 | ?cs=9V1234 -> one vessel's particulars (live, cached, never in KV)

import { mpaFeeds, fetchSnapshot, fetchReference, fetchParticulars } from "./mpa.js";
import { fetchFerries } from "./scc.js";
import { buildBoard } from "./board.js";

const SNAP_KEY = "snap";
const REF_KEY = "ref";
const VESSELS_KEY = "vessels";
const REF_MAX_AGE_MS = 24 * 3600e3;
const BOARD_MEMO_MS = 20e3; // per-isolate memo of the built board (saves KV reads)
const REF_MEMO_MS = 10 * 60e3;
const VESSEL_CACHE_S = 6 * 3600;
const REF_CRON = "7 */6 * * *";

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

// ---------------------------------------------------------------- cron: reference data

/** Vessel types + location codes (daily) and the particulars snapshot (every run). <= 2 KV writes. */
export async function refreshReference(env, now = Date.now(), { force = false } = {}) {
  const [ref, vessels] = await Promise.all([
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
    } catch (e) {
      console.error(`reference failed: ${errMsg(e)}`);
    }
  }
  if (force || !vessels || now - vessels.at > 5 * 3600e3) {
    try {
      const v = await fetchSnapshot(env);
      if (Object.keys(v).length) await env.BOARD_KV.put(VESSELS_KEY, JSON.stringify({ at: now, v }));
    } catch (e) {
      console.error(`snapshot failed: ${errMsg(e)}`);
    }
  }
}

// ---------------------------------------------------------------- API

async function getRefs(env) {
  const hit = memoGet("refs", REF_MEMO_MS);
  if (hit) return hit;
  const [ref, vessels] = await Promise.all([
    env.BOARD_KV.get(REF_KEY, "json"),
    env.BOARD_KV.get(VESSELS_KEY, "json"),
  ]);
  return memoSet("refs", { ref, vessels });
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
    ctx.waitUntil(refreshReference(env).then(() => memo.delete("refs")));
  }
  const { ref, vessels } = await getRefs(env);
  const body = { ...buildBoard(snap, ref, vessels), source };
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
      else if (url.pathname === "/" || url.pathname === "/api") {
        res = json({ name: "harbourlah", endpoints: ["/api/board", "/api/vessel?imo=", "/api/vessel?cs="] });
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
        // First run only: reference data and the particulars snapshot are missing.
        const ref = await env.BOARD_KV.get(REF_KEY);
        if (!ref) await refreshReference(env);
      })()
    );
  },
};
