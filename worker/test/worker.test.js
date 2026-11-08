import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker, { refreshBoard, refreshReference, clearMemo } from "../src/index.js";
import { buildBoard, classify } from "../src/board.js";
import { parseFerryPage, slotsFor, operatorName } from "../src/scc.js";
import { normaliseMovements, normaliseSnapshot, vesselKey } from "../src/mpa.js";
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
        { vesselParticulars: { ...vp("MSC DIEGO", "9202649", "3FZP8"), vesselType: "CS", vesselLength: 294, vesselBreadth: 32, grossTonnage: 66000, yearBuilt: "1999", mmsiNumber: "352000000" } },
        { vesselParticulars: { ...vp("SPECTRUM OF THE SEAS", "9778856", "C6DF5", "BS"), vesselType: "PA", vesselLength: 347, grossTonnage: 169379 } },
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
  assert.equal(classify({ typeDesc: "PASSENGER", gt: 0, locDescs: ["MARINA BAY CRUISE CENTRE"] }), "cruise");
  assert.equal(classify({ typeDesc: "BULK CARRIER" }), "cargo");
  assert.equal(classify({}), "cargo");
});

test("normalisers drop junk and key vessels sensibly", () => {
  const items = normaliseMovements([{ vesselParticulars: vp("X", "0", "", "ID"), dueToDepart: "" }, { vesselParticulars: vp("OCEANA BLUE", "0", "", "ID"), dueToDepart: sgt("16:30") }], "dueToDepart");
  assert.equal(items.length, 1);
  assert.equal(items[0].imo, "");
  assert.equal(vesselKey(items[0]), "n:OCEANA BLUE");
  assert.deepEqual(Object.keys(normaliseSnapshot([{ vesselParticulars: vp("A", "9214898", "OVYQ2") }])), ["imo:9214898"]);
});
