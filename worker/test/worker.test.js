import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker, { refreshBoard, refreshReference, clearMemo, resetRefGuard } from "../src/index.js";
import { buildBoard, classify } from "../src/board.js";
import { parseFerryPage, slotsFor, operatorName } from "../src/scc.js";
import { normaliseMovements, normaliseSnapshot, normalisePositions, vesselKey } from "../src/mpa.js";
import { refreshPositions } from "../src/index.js";
import { parseTime, sgtStamp } from "../src/time.js";
import { makeKV, installCaches, makeCtx } from "./harness.js";

installCaches();
const SCC_HTML = readFileSync(new URL("./fixtures/scc-arrival.html", import.meta.url), "utf8");
const NOW = Date.parse("2026-11-08T10:00:00Z"); // 18:00 SGT
const sgt = (hm, day = "2026-11-08") => `${day} ${hm}:00`;
const vp = (vesselName, imoNumber, callSign = "", flag = "PA") => ({ vesselName, imoNumber, callSign, flag });

/** Mock MPA gateway + SCC site. `fail` = set of feed names to fail. Records requests. */
function mockUpstream({ fail = new Set(), scc = SCC_HTML } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, headers: init.headers || {} });
    if (u.startsWith("https://singaporecruise.com.sg/")) {
      if (fail.has("scc")) return new Response("<html><script src=/_Incapsula_Resource></script></html>", { status: 200 });
      // Only the first arrival page has rows; everything else is an empty table.
      const isFirstArrival = u.includes("ferry-status=arrival") && !u.includes("pageid") && u.includes("18%3A00hrs");
      return new Response(isFirstArrival ? SCC_HTML.replace(/pageid=\d+/g, "pageid=999") : '<table class="schedule-table"><tr><th>x</th></tr></table>');
    }
    assert.ok(u.startsWith("https://oceans-x.mpa.gov.sg/api/v1/"), u);
    assert.equal(init.headers.apikey, "test-key", "apikey header");
    const feed =
      u.includes("/duetoarrive/") ? "dueArr" : u.includes("/duetodepart/") ? "dueDep" : u.includes("/arrivals/") ? "arr"
      : u.includes("/departure/") ? "dep" : u.includes("/departuredeclaration/") ? "decl" : u.includes("/snapshot") ? "snapshot"
      : u.includes("/reference/types") ? "types" : u.includes("/reference/locations") ? "locs" : u.includes("/particulars/") ? "particulars" : "?";
    if (fail.has(feed)) return Response.json({ error: { code: "503", message: "Service Unavailable" } }, { status: 503 });
    const data = {
      dueArr: [
        { vesselParticulars: vp("MSC DIEGO", "9202649", "3FZP8"), duetoArriveTime: sgt("14:00"), locationFrom: "SEA", locationTo: "PPBG" },
        { vesselParticulars: vp("SPECTRUM OF THE SEAS", "9778856", "C6DF5", "BS"), duetoArriveTime: sgt("20:00"), locationFrom: "SEAE", locationTo: "PMBCC" },
      ],
      arr: [{ vesselParticulars: vp("MSC DIEGO", "9202649", "3FZP8"), arrivedTime: sgt("14:40"), locationFrom: "SEA", locationTo: "PPBG" }],
      dueDep: [{ vesselParticulars: vp("KOTA GABUNG", "9616852", "VRQR3", "HK"), dueToDepart: sgt("21:30") }],
      dep: [{ vesselParticulars: vp("GOLDEN STAR 1", "8952857", "5IM444", "TZ"), departedTime: sgt("16:30") }],
      decl: [{ vesselParticulars: vp("KOTA GABUNG", "9616852", "VRQR3", "HK"), nextPort: "PORT KLANG", agent: "PIL PTE LTD", reportedDepartureTime: sgt("21:30"), pax: "0" }],
      snapshot: [
        { vesselParticulars: { ...vp("MSC DIEGO", "9202649", "3FZP8"), vesselType: "CS", vesselLength: 294, vesselBreadth: 32, grossTonnage: 66000, yearBuilt: "1999", mmsiNumber: "352000000" },
          latitude: 0.0221, longitude: 1.8113, latitudeDegrees: 1.26623, longitudeDegrees: 103.78123, speed: 0.1, course: 127.9, heading: 0, timeStamp: "2026-11-08 17:58:00" },
        { vesselParticulars: { ...vp("SPECTRUM OF THE SEAS", "9778856", "C6DF5", "BS"), vesselType: "PA", vesselLength: 347, grossTonnage: 169379 },
          latitudeDegrees: 1.2101, longitudeDegrees: 103.9001, speed: 14.27, course: 280, heading: 281 },
      ],
      types: [{ vesselTypeCode: "CS", vesselTypeDescription: "CONTAINER SHIP" }, { vesselTypeCode: "PA", vesselTypeDescription: "PASSENGER" }],
      locs: [{ locationCode: "PPBG", locationDescription: "PASIR PANJANG TERMINAL" }, { locationCode: "PMBCC", locationDescription: "MARINA BAY CRUISE CENTRE" }],
      particulars: [{ vesselName: "MSC DIEGO", imoNumber: "9202649", callSign: "3FZP8", flag: "PA", vesselType: "CS", vesselLength: 294, vesselBreadth: 32, grossTonnage: 66000, yearBuilt: "1999" }],
    }[feed];
    return Response.json(data);
  };
  return calls;
}

const env = () => ({ BOARD_KV: makeKV(), MPA_API_KEY: "test-key" });

test("time helpers use SGT", () => {
  assert.equal(sgtStamp(NOW), "2026-11-08 18:00:00");
  assert.equal(parseTime("2026-11-08 18:00:00"), NOW);
  assert.equal(parseTime(String(NOW)), NOW);
  assert.equal(parseTime(""), null);
});

test("MPA paths: version right after the resource, encoded date, apikey header, 'departure' singular", async () => {
  const e = env();
  const calls = mockUpstream();
  await refreshBoard(e, NOW);
  const mpa = calls.filter((c) => c.url.includes("oceans-x")).map((c) => c.url.replace("https://oceans-x.mpa.gov.sg/api/v1", ""));
  assert.ok(mpa.includes("/vessel/duetoarrive/1.0.0/date/2026-11-08%2015%3A00%3A00/hours/27"), mpa.join("\n"));
  assert.ok(mpa.includes("/vessel/duetodepart/1.0.0/date/2026-11-08%2015%3A00%3A00/hours/27"));
  assert.ok(mpa.includes("/vessel/arrivals/1.0.0/date/2026-11-08%2018%3A00%3A00/hours/12"));
  assert.ok(mpa.includes("/vessel/departure/1.0.0/date/2026-11-08%2018%3A00%3A00/hours/12"));
  assert.ok(mpa.some((p) => p.startsWith("/vessel/departuredeclaration/1.0.0/pastNhours?datetime=")));
  assert.equal(e.BOARD_KV.writes, 1, "one KV write per board tick");
});

test("board merges due + actual, adds particulars, categories and delay basis", async () => {
  const e = env();
  mockUpstream();
  await refreshReference(e, NOW, { force: true });
  const snap = await refreshBoard(e, NOW);
  const b = buildBoard(snap, await e.BOARD_KV.get("ref", "json"), await e.BOARD_KV.get("vessels", "json"), NOW);
  const diego = b.arr.find((r) => r.name === "MSC DIEGO");
  assert.equal(diego.status, "Arrived");
  assert.equal(diego.st, parseTime(sgt("14:00")));
  assert.equal(diego.at, parseTime(sgt("14:40")));
  assert.equal(diego.cat, "cargo");
  assert.equal(diego.type, "Container Ship");
  assert.equal(diego.to, "Pasir Panjang Terminal");
  assert.equal(diego.len, 294);
  const cruise = b.arr.find((r) => r.name === "SPECTRUM OF THE SEAS");
  assert.equal(cruise.cat, "cruise");
  assert.equal(cruise.status, "Expected");
  const kota = b.dep.find((r) => r.name === "KOTA GABUNG");
  assert.equal(kota.to, "Port Klang");
  assert.equal(kota.status, "Scheduled");
  assert.equal(b.dep.find((r) => r.name === "GOLDEN STAR 1").status, "Departed");
  const ferries = b.arr.filter((r) => r.src === "scc");
  assert.equal(ferries.length, 4, "SCC ferries from this morning are within the 12 h window");
  assert.ok(ferries.every((r) => r.cat === "ferry"));
});

test("SCC page parsing: rows, actual times, cancellations, pagination", () => {
  const p = parseFerryPage(SCC_HTML, "arr");
  assert.equal(p.blocked, false);
  assert.equal(p.rows.length, 4);
  const [first] = p.rows;
  assert.equal(first.trip, "NTDI0600");
  assert.equal(first.op, "Batamfast");
  assert.equal(first.from, "Nongsapura");
  assert.equal(first.to, "Tanah Merah");
  assert.equal(first.st, Date.parse("2026-11-08T07:40:00+08:00"));
  assert.equal(first.at, Date.parse("2026-11-08T07:29:00+08:00"));
  const cancelled = p.rows.find((r) => /cancel/i.test(r.status));
  assert.ok(cancelled && cancelled.at === null);
  assert.equal(p.hasNext, true);
  assert.equal(operatorName("MAJESTIC FAST FERRY PTE LTD"), "Majestic Fast Ferry");
  const blocked = parseFerryPage("<html>_Incapsula_Resource</html>", "arr");
  assert.equal(blocked.blocked, true);
});

test("SCC slots: current and next, rolling over midnight", () => {
  assert.deepEqual(slotsFor(NOW), [
    { date: "2026-11-08", slot: "18:00hrs-23:59hrs" },
    { date: "2026-11-09", slot: "00:00hrs-05:59hrs" },
  ]);
  assert.equal(slotsFor(Date.parse("2026-11-08T06:00:00Z"))[0].slot, "12:00hrs-17:59hrs");
});

test("a failing feed keeps its last good items and marks the board stale", async () => {
  const e = env();
  mockUpstream();
  await refreshBoard(e, NOW);
  mockUpstream({ fail: new Set(["arr", "dueArr", "scc"]) });
  const later = NOW + 20 * 60e3;
  const snap = await refreshBoard(e, later);
  assert.equal(snap.feeds.arr.items.length, 1, "kept");
  assert.equal(snap.feeds.arr.okAt, NOW);
  assert.match(snap.feeds.arr.error, /503/);
  assert.match(snap.feeds.scc.error, /bot protection/);
  const b = buildBoard(snap, null, null, later);
  assert.equal(b.stale, true);
  assert.equal(b.updatedAt, NOW);
  assert.ok(b.arr.some((r) => r.name === "MSC DIEGO"), "last good arrivals still shown");
  assert.equal(e.BOARD_KV.writes, 2);
});

test("SCC unavailable from the start doesn't make MPA data stale", async () => {
  const e = env();
  mockUpstream({ fail: new Set(["scc"]) });
  const snap = await refreshBoard(e, NOW);
  const b = buildBoard(snap, null, null, NOW + 60e3);
  assert.equal(b.stale, false);
  assert.ok(b.sources.scc.error);
});

test("/api/board serves no-store JSON, seeding KV on a cold start", async () => {
  clearMemo();
  const e = env();
  mockUpstream();
  const ctx = makeCtx();
  const res = await worker.fetch(new Request("https://w.example/api/board", { headers: { Origin: "https://harbourlah.pages.dev" } }), { ...e, ALLOWED_ORIGINS: "https://harbourlah.pages.dev" }, ctx);
  await ctx.drain();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Cache-Control"), "no-store");
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "https://harbourlah.pages.dev");
  const body = await res.json();
  assert.ok(body.updatedAt);
  assert.ok(Array.isArray(body.arr) && Array.isArray(body.dep));
  assert.equal(body.source, "live");
  assert.ok(await e.BOARD_KV.get("snap"));
});

test("/api/vessel validates input and returns particulars", async () => {
  clearMemo();
  const e = env();
  mockUpstream();
  const bad = await worker.fetch(new Request("https://w.example/api/vessel?imo=12"), e, makeCtx());
  assert.equal(bad.status, 400);
  const ok = await worker.fetch(new Request("https://w.example/api/vessel?imo=9202649"), e, makeCtx());
  const body = await ok.json();
  assert.equal(body.vessel.len, 294);
  assert.equal(body.vessel.beam, 32);
});

test("missing secret is reported, not thrown", async () => {
  const e = { BOARD_KV: makeKV() };
  mockUpstream({ fail: new Set(["scc"]) });
  const snap = await refreshBoard(e, NOW);
  assert.match(snap.feeds.dueArr.error, /MPA_API_KEY/);
  assert.equal(buildBoard(snap, null, null, NOW).stale, true);
});

test("classification", () => {
  assert.equal(classify({ src: "scc" }), "ferry");
  assert.equal(classify({ typeDesc: "PASSENGER", gt: 300, len: 35 }), "ferry");
  assert.equal(classify({ typeDesc: "PASSENGER", gt: 90000 }), "cruise");
  assert.equal(classify({ typeDesc: "Passenger Vessel", berths: [{ desc: "MARINA BAY CC BTH 1" }] }), "cruise");
  assert.equal(classify({ typeDesc: "BULK CARRIER" }), "cargo");
  assert.equal(classify({ typeDesc: "Tug Boat", berths: [{ code: "RFT2" }] }), "cargo", "known non-passenger type wins");
  assert.equal(classify({}), "cargo");
});

test("unknown type: berth codes and real MPA descriptions decide, case-insensitively", () => {
  for (const code of ["CC01", "CC01E", "CC01W", "CC02", "CM01", "CM02", "cm01"]) {
    assert.equal(classify({ berths: [{ code }] }), "cruise", code);
  }
  for (const code of ["RFT1", "RFT8", "DFT5", "DFT8", "TMFT", "CFT"]) {
    assert.equal(classify({ berths: [{ code }] }), "ferry", code);
  }
  // Descriptions as they come from MPA (upper case) and as shown on the board (title case).
  for (const desc of ["MARINA BAY CC BTH 1", "Marina Bay Cc Bth 1", "HarbourFront Cruise Centre"]) {
    assert.equal(classify({ berths: [{ desc }] }), "cruise", desc);
  }
  for (const desc of ["TANAH MERAH FERRY TERM", "Regional Ferry Plat 4", "MARINA SOUTH FERRY TML"]) {
    assert.equal(classify({ berths: [{ desc }] }), "ferry", desc);
  }
  for (const desc of ["Brani Terminal Berth 7", "Marina Berth 1", "Vopak Terminal Berth 1", "Western Petroleum A Anchorage"]) {
    assert.equal(classify({ berths: [{ desc }] }), "cargo", desc);
  }
  assert.equal(classify({ berths: [{ code: "RFT9" }, { code: "CC03" }] }), "cargo", "only the listed codes");
});

test("inbound cruise ship with no particulars yet is Cruise, and its departure too", () => {
  const now = Date.parse("2026-11-08T10:00:00Z");
  const ship = { n: "NEW CRUISER", imo: "9999991", cs: "ABCD1", fl: "BS" };
  const feed = (items) => ({ okAt: now, error: null, items });
  const snap = { feeds: {
    dueArr: feed([{ ...ship, t: now + 3600e3, from: "SEAE", to: "CM01" }]),
    arr: feed([]),
    dueDep: feed([{ ...ship, t: now + 10 * 3600e3 }]),
    dep: feed([]),
  } };
  const ref = { types: { CS: "CONTAINER SHIP" }, locs: { CM01: "MARINA BAY CC BTH 1" } };
  const b = buildBoard(snap, ref, { v: {} }, now);
  assert.equal(b.arr[0].cat, "cruise");
  assert.equal(b.arr[0].to, "Marina Bay Cc Bth 1");
  assert.equal(b.dep[0].cat, "cruise");
  assert.equal(b.dep[0].loc, "CM01");
});

test("normalisers drop junk and key vessels sensibly", () => {
  const items = normaliseMovements([{ vesselParticulars: vp("X", "0", "", "ID"), dueToDepart: "" }, { vesselParticulars: vp("OCEANA BLUE", "0", "", "ID"), dueToDepart: sgt("16:30") }], "dueToDepart");
  assert.equal(items.length, 1);
  assert.equal(items[0].imo, "");
  assert.equal(vesselKey(items[0]), "n:OCEANA BLUE");
  assert.deepEqual(Object.keys(normaliseSnapshot([{ vesselParticulars: vp("A", "9214898", "OVYQ2") }])), ["imo:9214898"]);
});

// ---------------------------------------------------------------- reference data fallback

const refCalls = (calls) => calls.filter((c) => /\/reference\/|\/snapshot/.test(c.url)).length;
async function boardReq(e) {
  const ctx = makeCtx();
  const res = await worker.fetch(new Request("https://w.example/api/board"), e, ctx);
  await ctx.drain();
  return res.json();
}
async function seeded() {
  clearMemo();
  resetRefGuard();
  const e = env();
  mockUpstream();
  await refreshBoard(e, Date.now());
  return e;
}

test("missing reference data is fetched lazily once, stored, and used for labels", async () => {
  const e = await seeded();
  const calls = mockUpstream();
  const writesBefore = e.BOARD_KV.writes;
  const [a, b, c] = await Promise.all([boardReq(e), boardReq(e), boardReq(e)]);
  assert.equal(refCalls(calls), 3, "types + locations + snapshot fetched exactly once for 3 concurrent requests");
  for (const body of [a, b, c]) {
    assert.equal(body.typesUnavailable, false);
    const cruise = body.arr.find((r) => r.name === "SPECTRUM OF THE SEAS");
    if (cruise) assert.equal(cruise.cat, "cruise");
  }
  assert.ok(await e.BOARD_KV.get("ref") && await e.BOARD_KV.get("vessels"), "stored in KV");
  assert.equal(e.BOARD_KV.writes - writesBefore, 3, "marker + ref + vessels");
  clearMemo();
  await boardReq(e);
  assert.equal(refCalls(calls), 3, "not refetched once stored");
});

test("failed reference fetch: board still served, flagged, and not retried per request", async () => {
  const e = await seeded();
  const calls = mockUpstream({ fail: new Set(["types", "locs", "snapshot"]) });
  const body = await boardReq(e);
  assert.equal(body.typesUnavailable, true);
  // Served with fresh MPA data (row counts depend on today's date vs the fixed mock times).
  assert.ok(body.updatedAt && body.sources.mpa.okAt && Array.isArray(body.arr), "board still served");
  assert.ok(body.arr.filter((r) => r.src === "mpa").every((r) => r.cat === "cargo"));
  const after = refCalls(calls);
  clearMemo();
  await boardReq(e);
  clearMemo();
  await boardReq(e);
  assert.equal(refCalls(calls), after, "no refetch inside the retry window");
  // Another isolate (fresh in-memory guard) sees the KV marker and doesn't refetch either.
  resetRefGuard();
  clearMemo();
  await boardReq(e);
  assert.equal(refCalls(calls), after, "KV marker stops other isolates");
});

test("cron tick fills missing reference data through the same guard", async () => {
  const e = await seeded();
  const calls = mockUpstream();
  const ctx = makeCtx();
  await worker.scheduled({ cron: "*/10 * * * *" }, e, ctx);
  await ctx.drain();
  assert.equal(refCalls(calls), 4, "types + locations + snapshot, then the positions snapshot");
  assert.ok(await e.BOARD_KV.get("ref"));
});

// ---------------------------------------------------------------- positions (Tracker)

test("positions are slimmed: degrees (radians fallback), heading fallback, no extra fields", () => {
  const ships = normalisePositions([
    { vesselParticulars: { ...vp("A", "9214898", "OVYQ2", "DK"), vesselType: "CS", vesselLength: 347, grossTonnage: 91560, mmsiNumber: "1" },
      latitude: 0.0241476315047, longitude: 1.80084330648, speed: 5.17939, course: 127.988, heading: 0 },
    { vesselParticulars: vp("B", "0", "", "SG"), latitudeDegrees: 1.3, longitudeDegrees: 103.7, speed: 0, course: 0, heading: 511 },
    { vesselParticulars: vp("NOPOS", "9999999") },
  ]);
  assert.equal(ships.length, 2);
  const [a, b] = ships;
  assert.ok(Math.abs(a.la - 1.38356) < 1e-4 && Math.abs(a.lo - 103.18072) < 1e-4, "radians converted");
  assert.equal(a.h, 128, "heading 0 falls back to course");
  assert.equal(a.s, 5.2);
  assert.deepEqual(Object.keys(a).sort(), ["fl", "g", "h", "imo", "l", "la", "lo", "n", "s", "tc"]);
  assert.equal(b.h, undefined, "511 and a resting 0 course mean unknown");
  assert.equal(b.imo, undefined);
});

test("board tick writes the board and positions: 2 KV puts", async () => {
  clearMemo(); resetRefGuard();
  const e = env();
  mockUpstream();
  await refreshReference(e, NOW, { force: true });
  const before = e.BOARD_KV.writes;
  const ctx = makeCtx();
  await worker.scheduled({ cron: "*/10 * * * *" }, e, ctx);
  await ctx.drain();
  assert.equal(e.BOARD_KV.writes - before, 2);
  const stored = await e.BOARD_KV.get("positions", "json");
  assert.equal(stored.ships.length, 2);
  const spectrum = stored.ships.find((x) => x.n === "SPECTRUM OF THE SEAS");
  assert.equal(spectrum.c, "cruise");
  assert.equal(stored.types.PA, "Passenger");
  assert.ok(JSON.stringify(stored).length < 1000);
});

test("positions failure keeps last ships, writes the error once, and goes stale", async () => {
  clearMemo();
  const e = env();
  mockUpstream();
  const t0 = Date.now();
  await refreshPositions(e, t0);
  mockUpstream({ fail: new Set(["snapshot"]) });
  const w = e.BOARD_KV.writes;
  await refreshPositions(e, t0 + 10 * 60e3);
  await refreshPositions(e, t0 + 20 * 60e3);
  assert.equal(e.BOARD_KV.writes - w, 1, "error written once, not every tick");
  const res = await worker.fetch(new Request("https://w.example/api/positions"), e, makeCtx());
  assert.equal(res.headers.get("Cache-Control"), "no-store");
  const body = await res.json();
  assert.equal(body.count, 2, "last good ships still served");
  assert.equal(body.updatedAt, t0);
  assert.equal(body.stale, true);
  assert.match(body.error, /503/);
});

test("/api/positions seeds KV on a fresh deploy", async () => {
  clearMemo();
  const e = env();
  mockUpstream();
  const res = await worker.fetch(new Request("https://w.example/api/positions"), e, makeCtx());
  const body = await res.json();
  assert.equal(body.count, 2);
  assert.equal(body.stale, false);
  assert.ok(await e.BOARD_KV.get("positions"));
});

test("SCC blocked after working once: board follows MPA, not stale; SCC state stays in sources", async () => {
  const e = env();
  mockUpstream();
  await refreshBoard(e, NOW); // SCC works at 18:00
  mockUpstream({ fail: new Set(["scc"]) }); // then bot protection kicks in
  const later = NOW + 50 * 60e3;
  const snap = await refreshBoard(e, later);
  const b = buildBoard(snap, null, null, later + 60e3);
  assert.equal(b.updatedAt, later, "Updated time is MPA's, not SCC's last good time");
  assert.equal(b.stale, false);
  assert.equal(b.sources.scc.stale, true);
  assert.equal(b.sources.scc.okAt, NOW);
  assert.match(b.sources.scc.error, /bot protection/);
});
