"use strict";

// ================================================================ config

const API = (() => {
  const c = (window.HARBOURLAH_API || "").replace(/\/+$/, "");
  if (c) return c;
  if (["localhost", "127.0.0.1"].includes(location.hostname) && location.port !== "8787") return "http://localhost:8787";
  return "";
})();

const AUTO_REFRESH_MS = 2 * 60e3; // while the page is visible
const OLD_DATA_MS = 15 * 60e3; // show a staleness hint when the data is older than this
const MIN_SPIN_MS = 600;
const DELAY_TAG_MIN = 15; // show a tag when 15+ minutes late or early
const EARLY_ARRIVAL_WINDOW_MIN = 180; // arrivals: "Early" only when due within 3 hours
const EARLIER_GRACE_MIN = 60; // hide finished movements older than this (with a "show" button)

// ================================================================ utils

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const store = {
  get(k, d) { try { const v = localStorage.getItem("hl:" + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("hl:" + k, JSON.stringify(v)); } catch { /* ignore */ } },
};

const fmtTime = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Singapore", hour: "2-digit", minute: "2-digit", hour12: false });
const fmtDay = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Singapore", weekday: "short" });
const fmtYmd = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Singapore", year: "numeric", month: "2-digit", day: "2-digit" });
const hm = (ms) => (ms ? fmtTime.format(new Date(ms)) : "");
const sameDay = (a, b) => fmtYmd.format(new Date(a)) === fmtYmd.format(new Date(b));
const fmtDate = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Singapore", weekday: "short", day: "numeric", month: "short" });
/** "17:30" today, "yesterday 17:30", else "Sun 8 Nov 17:30" (all SGT). */
function whenSGT(ms, now = Date.now()) {
  if (!ms) return "";
  if (sameDay(ms, now)) return hm(ms);
  if (sameDay(ms, now - 86400e3)) return `yesterday ${hm(ms)}`;
  return `${fmtDate.format(new Date(ms))} ${hm(ms)}`;
}

let regionNames = null;
try { regionNames = new Intl.DisplayNames(["en"], { type: "region" }); } catch { /* old browser */ }
function countryName(code) {
  if (!code || !/^[A-Z]{2}$/.test(code)) return "";
  try { const n = regionNames && regionNames.of(code); return n && n !== code ? n : ""; } catch { return ""; }
}

async function getJSON(path, { fresh = false } = {}) {
  const res = await fetch(API + path, { cache: fresh ? "no-store" : "default" });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

// ================================================================ ships

const shownTime = (s) => s.at || s.et || s.st;
const isFinished = (s) => Boolean(s.at) || /arrived|departed|cancel/i.test(s.status || "");

function statusClass(s) {
  const t = (s.status || "").toLowerCase();
  if (/cancel|delay/.test(t)) return "bad";
  if (/^due\b/.test(t)) return "due";
  if (/arrived|departed/.test(t)) return "done";
  return "ok";
}

/** Minutes between the actual (else estimated) time and the schedule; null when unknown or cancelled. */
function delayMinutes(s) {
  if (/cancel/i.test(s.status || "")) return null;
  const t = s.at || s.et;
  if (!t || !s.st) return null;
  return Math.round((t - s.st) / 60e3);
}

function delayTagHTML(s) {
  const m = delayMinutes(s);
  if (m === null || Math.abs(m) < DELAY_TAG_MIN) return "";
  if (m < 0 && s.dir === "arr") {
    // As on flightlah: "Early" helps before arrival (e.g. a pickup), and only when it's due soon.
    if (s.at) return "";
    if (shownTime(s) - Date.now() > EARLY_ARRIVAL_WINDOW_MIN * 60e3) return "";
  }
  const basis = s.at ? "actual" : "estimated";
  return m > 0
    ? `<span class="delay-tag late" title="${basis} time is ${m} min later than scheduled">Delayed +${m}m</span>`
    : `<span class="delay-tag early" title="${basis} time is ${-m} min earlier than scheduled">Early -${-m}m</span>`;
}

const CAT_LABEL = { ferry: "Ferry", cruise: "Cruise", cargo: "Cargo/Other" };
const CHIP_LABEL = { all: "All", ferry: "Ferry", cruise: "Cruise", cargo: "Cargo" };

/** "to Pasir Panjang Terminal" / "from Batam Centre" */
function placeText(s) {
  if (s.dir === "arr") {
    if (s.src === "scc") return s.from ? `from ${s.from}${s.to ? ` → ${s.to}` : ""}` : "";
    return s.to ? `to ${s.to}` : s.from ? `from ${s.from}` : "";
  }
  if (s.src === "scc") return s.to ? `${s.from ? `${s.from} → ` : ""}${s.to}` : "";
  return s.to ? `to ${s.to}` : "";
}

function timeHTML(s) {
  const t = shownTime(s);
  const changed = Boolean(s.st && t !== s.st && Math.abs(t - s.st) >= 60e3);
  const day = sameDay(t, Date.now()) ? "" : fmtDay.format(new Date(t));
  const title = [s.st && `Scheduled ${hm(s.st)}`, s.et && `Estimated ${hm(s.et)}`, s.at && `Actual ${hm(s.at)}`, day].filter(Boolean).join(", ");
  return `<span class="s-time${changed ? " changed" : ""}" title="${esc(title)}">${esc(hm(t))}${day ? `<small>${esc(day)}</small>` : ""}</span>`;
}

/** FIDS row. Desktop: TIME | FLAG | SHIP | TYPE | FROM / TO | REMARKS. Phones: two lines (see style.css). */
function rowHTML(s) {
  const open = state.open.has(s.id);
  const type = s.type || CAT_LABEL[s.cat];
  const flag = s.fl ? `<span class="s-flag" title="${esc(countryName(s.fl) || s.fl)}">${esc(s.fl)}</span>` : `<span class="s-flag"></span>`;
  return `<div class="ship${open ? " open" : ""}" data-id="${esc(s.id)}">
    <div class="s-row" role="button" tabindex="0" aria-expanded="${open}">
      ${timeHTML(s)}
      ${flag}
      <span class="s-name">${esc(s.name)}</span>
      <span class="s-sub"><span class="s-type cat-${esc(s.cat)}"><span class="s-type-text">${esc(type)}</span></span><span class="s-berth">${esc(placeText(s))}</span></span>
      <span class="s-status"><span class="pill ${statusClass(s)}">${esc(s.status)}</span>${delayTagHTML(s)}</span>
    </div>
    ${open ? detailHTML(s) : ""}
  </div>`;
}

const COL_LABELS = `<div class="col-labels" aria-hidden="true"><span>Time</span><span>Flag</span><span>Ship</span><span>Type</span><span>From / to</span><span class="l-rem">Remarks</span></div>`;

const kv = (k, v, cls = "") => (v ? `<div class="kv${cls ? " " + cls : ""}"><dt>${esc(k)}</dt><dd>${v}</dd></div>` : "");
const timeWithDay = (ms) => (ms ? `${esc(hm(ms))}${sameDay(ms, Date.now()) ? "" : ` <small>${esc(fmtDay.format(new Date(ms)))}</small>`}` : "");
const num = (n) => (n ? Number(n).toLocaleString("en-GB") : "");

function detailHTML(s) {
  const p = (s.imo && particulars.get(s.imo)) || {};
  const len = s.len || p.len;
  const beam = s.beam || p.beam;
  const dims = len ? `${num(len)} m${beam ? ` × ${num(beam)} m` : ""}` : "";
  const flag = s.fl || p.fl;
  const flagText = flag ? `${esc(countryName(flag) || flag)}${countryName(flag) ? ` <small>${esc(flag)}</small>` : ""}` : "";
  const loading = s.imo && !len && particulars.get(s.imo) === undefined;
  const ferry = s.src === "scc";
  return `<dl class="s-detail">
    ${ferry ? kv("Operator", esc(s.op)) + kv("Trip", esc(s.trip)) : ""}
    ${!ferry ? kv("IMO", esc(s.imo) || "—") + kv("Call sign", esc(s.cs || p.cs) || "—") + kv("Flag", flagText || "—") : ""}
    ${kv("Type", esc(s.type || (p.typeCode ? p.typeCode : "") || CAT_LABEL[s.cat]))}
    ${!ferry ? kv("Length × beam", dims || (loading ? "Loading…" : "—")) : ""}
    ${!ferry ? kv("Gross tonnage", num(s.gt || p.gt)) + kv("Built", esc(s.built || p.built)) : ""}
    ${kv("Scheduled", timeWithDay(s.st) || "—")}
    ${s.et ? kv("Estimated", timeWithDay(s.et)) : ""}
    ${kv(s.dir === "arr" ? "Arrived" : "Departed", timeWithDay(s.at) || "—")}
    ${s.from ? kv(ferry ? "From" : "Coming from", esc(s.from)) : ""}
    ${s.to ? kv(ferry ? "To" : s.dir === "arr" ? "Heading to" : "Next port", esc(s.to), "wide") : ""}
    ${s.agent ? kv("Agent", esc(s.agent), "wide") : ""}
    ${s.pax ? kv("Passengers", num(s.pax)) : ""}
    ${ferry ? "" : `<div class="s-actions"><button class="track-btn" type="button" data-track="${esc(s.id)}">Track on map</button></div>`}
    <p class="src">${ferry ? "Source: Singapore Cruise Centre ferry board" : "Source: MPA port declarations (updated about hourly)"}</p>
  </dl>`;
}

// ================================================================ particulars (on expand)

const particulars = new Map(); // imo -> object | null (unavailable); missing = not asked yet

async function loadParticulars(s) {
  if (!s.imo || s.len || particulars.has(s.imo)) return;
  particulars.set(s.imo, undefined);
  try {
    const { vessel } = await getJSON(`/api/vessel?imo=${encodeURIComponent(s.imo)}`);
    particulars.set(s.imo, vessel || null);
  } catch {
    particulars.set(s.imo, null);
  }
  if (state.open.has(s.id)) renderBoard();
}

// ================================================================ state + board

const state = {
  view: "board",
  dir: store.get("dir", "arr"),
  cat: store.get("cat", "all"),
  q: "",
  open: new Set(),
  showEarlier: false,
  data: null,
  loading: false,
  error: null,
};

function matches(s, q) {
  if (!q) return true;
  const compact = q.replace(/\s+/g, "");
  const hay = [s.name, s.fl, countryName(s.fl), s.cs, s.op, s.trip, s.from, s.to, s.type]
    .filter(Boolean).join(" | ").toLowerCase();
  return hay.includes(q) || (s.imo && s.imo.includes(compact)) || (s.cs && s.cs.toLowerCase() === compact);
}

function listFor(dir = state.dir, { cat = state.cat, q = state.q } = {}) {
  const query = q.trim().toLowerCase();
  return ((state.data && state.data[dir]) || []).filter((s) => (cat === "all" || s.cat === cat) && matches(s, query));
}

const isEarlier = (s) => isFinished(s) && shownTime(s) < Date.now() - EARLIER_GRACE_MIN * 60e3;

function renderUpdated() {
  const el = $("#updated");
  const d = state.data;
  if (!d) { el.textContent = ""; return; }
  if (!d.updatedAt) { el.innerHTML = `<span class="stale">No data yet</span>`; el.parentElement.classList.add("is-stale"); return; }
  const old = Date.now() - d.updatedAt > OLD_DATA_MS;
  const errors = Object.entries(d.sources || {}).filter(([, v]) => v && v.error && v.okAt).map(([k, v]) => `${k}: ${v.error}`);
  const stale = Boolean(state.error || d.stale || old);
  const tail = stale
    ? `<span class="stale" title="${esc([state.error, ...errors].filter(Boolean).join("\n"))}">${old ? `${Math.round((Date.now() - d.updatedAt) / 60e3)} min old, may be stale` : "may be stale"}</span>`
    : `auto ${AUTO_REFRESH_MS / 60e3} min`;
  el.innerHTML = `Updated ${esc(hm(d.updatedAt))} SGT · ${tail}`;
  el.parentElement.classList.toggle("is-stale", stale);
}

function renderNote() {
  const el = $("#note");
  const lines = [];
  // Without MPA's reference data the Worker can't tell ship types apart.
  if (state.data && state.data.typesUnavailable) {
    lines.push("Ship types unavailable right now, so most ships show as Cargo/Other.");
  }
  const scc = state.data && state.data.sources && state.data.sources.scc;
  if (scc && scc.error && (state.cat === "all" || state.cat === "ferry")) {
    lines.push(scc.okAt
      ? `Ferry terminal board not updating (last good ${whenSGT(scc.okAt)} SGT).`
      : "Ferry terminal board unavailable right now; ferries shown come from MPA declarations only.");
  }
  el.hidden = !lines.length;
  el.textContent = lines.join(" ");
}

function renderChips() {
  for (const b of $$("[data-cat]")) {
    const c = b.dataset.cat;
    const n = state.data ? listFor(state.dir, { cat: c, q: "" }).length : 0;
    const label = CHIP_LABEL[c];
    b.innerHTML = `${label}${state.data ? ` <span class="chip-count">${n}</span>` : ""}`;
    b.setAttribute("aria-pressed", String(c === state.cat));
  }
}

function renderBoard() {
  const box = $("#board");
  box.setAttribute("aria-busy", String(state.loading));
  renderUpdated();
  renderNote();
  renderChips();
  if (!state.data) {
    box.innerHTML = state.loading
      ? `<p class="empty">Loading ships…</p>`
      : `<p class="empty error">Couldn't load ships${state.error ? `: ${esc(state.error)}` : ""}.</p>`;
    return;
  }
  let list = listFor();
  let hidden = 0;
  if (!state.q && !state.showEarlier) {
    const keep = list.filter((s) => !isEarlier(s));
    hidden = list.length - keep.length;
    list = keep;
  }
  const more = hidden ? `<button class="more" type="button" data-act="earlier">Show ${hidden} earlier ${hidden === 1 ? "ship" : "ships"}</button>` : "";
  const less = state.showEarlier && !state.q ? `<button class="more" type="button" data-act="later">Hide earlier ships</button>` : "";
  const word = state.dir === "arr" ? "arrivals" : "departures";
  box.innerHTML = list.length
    ? COL_LABELS + more + less + list.map(rowHTML).join("")
    : more + `<p class="empty">${state.q ? "No ships match your search." : `No ${state.cat === "all" ? "" : CAT_LABEL[state.cat].toLowerCase() + " "}${word} in the next 24 hours.`}</p>`;
}

async function loadBoard({ quiet = false, fresh = false } = {}) {
  if (!quiet) { state.loading = true; renderBoard(); }
  try {
    state.data = await getJSON("/api/board", { fresh });
    state.error = null;
  } catch (e) {
    state.error = e.message;
  } finally {
    state.loading = false;
  }
  const y = window.scrollY;
  renderBoard();
  if (quiet && window.scrollY !== y) window.scrollTo(0, y);
}

function findShip(id) {
  for (const dir of ["arr", "dep"]) {
    const s = ((state.data && state.data[dir]) || []).find((x) => x.id === id);
    if (s) return s;
  }
  return null;
}

function toggleRow(id) {
  if (state.open.has(id)) state.open.delete(id);
  else {
    state.open.add(id);
    const s = findShip(id);
    if (s) loadParticulars(s);
  }
  renderBoard();
}

function setDir(dir) {
  state.dir = dir === "dep" ? "dep" : "arr"; store.set("dir", state.dir); state.open.clear(); state.showEarlier = false;
  for (const b of $$("[data-dir]")) b.setAttribute("aria-pressed", String(b.dataset.dir === state.dir));
  renderBoard();
}

/** "board" (Arrivals/Departures) or "tracker". Keeps #tracker in the URL so it can be linked. */
function showView(view) {
  state.view = view;
  $("#view-board").hidden = view !== "board";
  $("#view-tracker").hidden = view !== "tracker";
  document.body.classList.toggle("tracker-on", view === "tracker");
  for (const t of $$(".tab")) t.setAttribute("aria-selected", String(t.dataset.view === view));
  const hash = view === "tracker" ? "#tracker" : "";
  if (location.hash !== hash) history.replaceState(null, "", location.pathname + location.search + hash);
  if (view === "tracker") openTracker();
}

function bind() {
  $$(".tab").forEach((t) => t.addEventListener("click", () => showView(t.dataset.view)));
  $$("[data-dir]").forEach((b) => b.addEventListener("click", () => setDir(b.dataset.dir)));
  $$("[data-cat]").forEach((b) => b.addEventListener("click", () => {
    state.cat = b.dataset.cat; store.set("cat", state.cat); renderBoard();
  }));
  let timer;
  $("#search").addEventListener("input", (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => { state.q = e.target.value; renderBoard(); }, 80);
  });
  $("#board").addEventListener("click", (e) => {
    const act = e.target.closest("[data-act]");
    if (act) { state.showEarlier = act.dataset.act === "earlier"; renderBoard(); return; }
    const track = e.target.closest("[data-track]");
    if (track) { const s = findShip(track.dataset.track); if (s) trackShip(s); return; }
    const row = e.target.closest(".ship");
    if (row && e.target.closest(".s-row")) toggleRow(row.dataset.id);
  });
  $("#board").addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const rowEl = e.target.closest(".s-row");
    if (!rowEl || e.target !== rowEl) return;
    e.preventDefault();
    const id = rowEl.parentElement.dataset.id;
    toggleRow(id);
    const again = $$(".ship").find((el) => el.dataset.id === id);
    if (again) again.querySelector(".s-row").focus();
  });
  $("#refresh").addEventListener("click", () => refreshNow({ manual: true }));
  bindTracker();
  setDir(state.dir);
  showView(location.hash === "#tracker" ? "tracker" : "board");
}

// ================================================================ tracker
//
// ~1,200 ships around Singapore from MPA's positions snapshot (via /api/positions).
// Drawn on one canvas over the Leaflet map instead of 1,200 DOM markers, so panning
// stays smooth on a phone. Taps are matched to the nearest drawn ship.

const STRAIT = [1.22, 103.84]; // Singapore Strait, off HarbourFront / Marina South
const STRAIT_ZOOM = 11;
const TRACK_ZOOM = 14;
const HIT_PX = 18; // tap tolerance around a ship

const tracker = {
  map: null,
  canvas: null,
  ctx: null,
  data: null,
  cat: store.get("mcat", "all"),
  group: null, // "In Singapore waters now" filter: moving | stopped | tankers | container | bulk
  showSeamarks: store.get("seamarks", true) !== false, // OpenSeaMap overlay, default on
  seamarks: null,
  selected: null, // ship key
  drawn: [], // [{ s, x, y }] from the last draw, for hit-testing
  fetchedAt: 0,
  error: null,
  loading: null, // promise while a fetch is running
  colors: null,
};

const shipKey = (s) => (s.imo ? `imo:${s.imo}` : `n:${s.n}`);

function catColors() {
  if (tracker.colors) return tracker.colors;
  const css = getComputedStyle(document.documentElement);
  const v = (n, d) => (css.getPropertyValue(n) || "").trim() || d;
  tracker.colors = {
    ferry: v("--t4", "#79b392"), cruise: v("--t2", "#a693c9"), cargo: v("--t1", "#7ba7c7"),
    accent: v("--amber", "#a3e61a"), outline: `rgba(${v("--overlay-rgb", "10, 16, 14")}, 0.85)`,
  };
  return tracker.colors;
}
// Theme switched (theme.js): re-read the tokens and redraw the ships.
window.addEventListener("themechange", () => { tracker.colors = null; draw(); });

function bindTracker() {
  $$("[data-mcat]").forEach((b) => b.addEventListener("click", () => {
    tracker.cat = b.dataset.mcat; store.set("mcat", tracker.cat);
    const sel = selectedShip();
    if (sel && !visibleShips().includes(sel)) select(null);
    renderMapChips(); renderMapNote(); draw();
  }));
  $(".card-close").addEventListener("click", () => select(null));
  $$("[data-group]").forEach((b) => b.addEventListener("click", () => setGroup(b.dataset.group)));
  renderWaters();
  $("#seamarks-toggle").addEventListener("click", () => setSeamarks(!tracker.showSeamarks));
  setSeamarks(tracker.showSeamarks);
  renderMapChips();
}

// ---------------------------------------------------------------- sea marks (OpenSeaMap)

const SEAMARK_URL = "https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png";
const SEAMARK_FALLBACK_HOST = "t1.openseamap.org";

/**
 * Seamark tiles that quietly retry each tile once on the t1 host, then just stay hidden:
 * a failed or blocked OpenSeaMap never shows an error or a broken image, and the map works as before.
 */
const SeamarkLayer = window.L
  ? L.TileLayer.extend({
    createTile(coords, done) {
      const img = document.createElement("img");
      img.alt = "";
      img.setAttribute("role", "presentation");
      const url = this.getTileUrl(coords);
      let retried = false;
      img.onload = () => done(null, img);
      img.onerror = () => {
        if (!retried) {
          retried = true;
          img.src = url.replace("//tiles.openseamap.org/", `//${SEAMARK_FALLBACK_HOST}/`);
          return;
        }
        img.classList.add("seamark-failed");
        done(null, img); // treat as loaded-but-empty: no tileerror, no retries
      };
      img.src = url;
      return img;
    },
  })
  : null;

function setSeamarks(on) {
  tracker.showSeamarks = on;
  store.set("seamarks", on);
  $("#seamarks-toggle").setAttribute("aria-pressed", String(on));
  const layer = tracker.seamarks;
  if (!tracker.map || !layer) return;
  if (on && !tracker.map.hasLayer(layer)) layer.addTo(tracker.map);
  if (!on && tracker.map.hasLayer(layer)) tracker.map.removeLayer(layer);
}

function renderMapChips() {
  const ships = (tracker.data && tracker.data.ships) || [];
  for (const b of $$("[data-mcat]")) {
    const c = b.dataset.mcat;
    const label = CHIP_LABEL[c];
    const n = c === "all" ? ships.length : ships.filter((s) => s.c === c).length;
    b.innerHTML = `${label}${tracker.data ? ` <span class="chip-count">${n}</span>` : ""}`;
    b.setAttribute("aria-pressed", String(c === tracker.cat));
  }
}

function initMap() {
  if (tracker.map || !window.L) return;
  const map = L.map("map", { center: STRAIT, zoom: STRAIT_ZOOM, zoomControl: false, attributionControl: true });
  L.control.zoom({ position: "bottomright" }).addTo(map);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18,
    attribution: 'Map data &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, <a href="https://www.openseamap.org">OpenSeaMap</a> · Positions: MPA via OCEANS-X',
  }).addTo(map);
  // OpenSeaMap seamarks: above the base map (own pane, z 250 > tiles 200), below the ship canvas (z 450).
  map.createPane("seamarks").style.zIndex = 250;
  tracker.seamarks = new SeamarkLayer(SEAMARK_URL, { pane: "seamarks", maxZoom: 18, opacity: 0.95 });
  if (tracker.showSeamarks) tracker.seamarks.addTo(map);
  const canvas = document.createElement("canvas");
  canvas.className = "ship-canvas";
  map.getContainer().appendChild(canvas);
  tracker.canvas = canvas;
  tracker.ctx = canvas.getContext("2d");
  // Leaflet animates zoom with CSS transforms the canvas can't follow: hide it until the zoom ends.
  map.on("zoomstart", () => { canvas.style.visibility = "hidden"; });
  map.on("zoomend", () => { canvas.style.visibility = ""; draw(); });
  map.on("move resize", requestDraw);
  map.on("click", (e) => {
    const hit = nearestShip(e.containerPoint);
    select(hit ? shipKey(hit) : null);
  });
  tracker.map = map;
}

function openTracker() {
  if (!window.L) {
    // Leaflet is loaded with `defer` before this script, so this is only a CDN failure.
    $("#map-note").innerHTML = `<span class="stale">Map library didn't load. Check your connection.</span>`;
    return;
  }
  initMap();
  // The map container was hidden until now: let Leaflet measure it.
  setTimeout(() => { tracker.map.invalidateSize(); draw(); }, 0);
  if (!tracker.data || Date.now() - tracker.fetchedAt > AUTO_REFRESH_MS) loadPositions();
}

async function loadPositions() {
  if (tracker.loading) return tracker.loading;
  tracker.loading = (async () => {
    try {
      tracker.data = await getJSON("/api/positions");
      tracker.error = null;
      tracker.fetchedAt = Date.now();
    } catch (e) {
      tracker.error = e.message;
    } finally {
      tracker.loading = null;
    }
    renderMapNote();
    renderMapChips();
    renderWaters();
    draw();
    renderCard();
  })();
  return tracker.loading;
}

function renderMapNote() {
  const el = $("#map-note");
  const d = tracker.data;
  if (!d) { el.innerHTML = tracker.error ? `<span class="stale">Couldn't load positions: ${esc(tracker.error)}</span>` : "Loading positions…"; return; }
  if (!d.updatedAt) { el.innerHTML = `<span class="stale">No positions yet</span>`; return; }
  const age = Date.now() - d.updatedAt;
  const old = age > OLD_DATA_MS;
  const shown = visibleShips().length;
  const tail = tracker.error || d.stale || old
    ? ` · <span class="stale" title="${esc([tracker.error, d.error].filter(Boolean).join("\n"))}">${old ? `${Math.round(age / 60e3)} min old, may be stale` : "may be stale"}</span>`
    : "";
  el.innerHTML = `Updated ${esc(hm(d.updatedAt))} SGT · ${num(shown) || 0} ships${tail}`;
}

function visibleShips() {
  const ships = (tracker.data && tracker.data.ships) || [];
  const group = tracker.group && WATERS_GROUPS[tracker.group];
  const codes = group && group.codes ? groupCodes(tracker.group) : null;
  return ships.filter((s) =>
    (tracker.cat === "all" || s.c === tracker.cat) && (!group || group.test(s, codes)));
}

// ---------------------------------------------------------------- "In Singapore waters now"
//
// Counts from the positions feed already loaded (no extra requests). Tapping a count filters the
// map to those ships (together with the ALL / FERRY / CRUISE / CARGO chips); tap again to clear.

const STOPPED_KN = 0.5; // below this a ship counts as stopped (anchored or alongside)
const WATERS_GROUPS = {
  moving: { test: (s) => s.s !== undefined && s.s >= STOPPED_KN },
  stopped: { test: (s) => s.s !== undefined && s.s < STOPPED_KN },
  tankers: { codes: ["TA", "CH", "LP", "LN"], test: (s, codes) => codes.has(s.tc) },
  container: { codes: ["CS", "CF", "CR"], test: (s, codes) => codes.has(s.tc) },
  bulk: { codes: ["BC", "OB"], test: (s, codes) => codes.has(s.tc) },
};

/** A group's type codes that the live feed actually uses (codes missing from its `types` map are ignored). */
function groupCodes(name) {
  const types = (tracker.data && tracker.data.types) || {};
  return new Set((WATERS_GROUPS[name].codes || []).filter((c) => Object.prototype.hasOwnProperty.call(types, c)));
}

function renderWaters() {
  const d = tracker.data;
  const ships = (d && d.ships) || [];
  const have = Boolean(d && d.updatedAt);
  const set = (id, n) => { $(`#${id}`).textContent = have ? num(n) || "0" : "—"; };
  set("w-total", ships.length);
  for (const name of Object.keys(WATERS_GROUPS)) {
    const g = WATERS_GROUPS[name];
    const codes = g.codes ? groupCodes(name) : null;
    set(`w-${name}`, ships.filter((s) => g.test(s, codes)).length);
  }
  for (const b of $$("[data-group]")) {
    b.setAttribute("aria-pressed", String(b.dataset.group === tracker.group));
    b.disabled = !have;
  }
  const st = $("#waters-status");
  if (!d) st.innerHTML = tracker.error ? `<span class="stale">Positions unavailable</span>` : "Loading…";
  else if (!have) st.innerHTML = `<span class="stale">No positions yet</span>`;
  else {
    const age = Date.now() - d.updatedAt;
    st.innerHTML = tracker.error || d.stale || age > OLD_DATA_MS
      ? `<span class="stale">${esc(hm(d.updatedAt))} SGT · may be stale</span>`
      : `${esc(hm(d.updatedAt))} SGT`;
  }
}

function setGroup(name) {
  tracker.group = tracker.group === name ? null : name;
  const sel = selectedShip();
  if (sel && !visibleShips().includes(sel)) select(null);
  renderWaters(); renderMapNote(); draw();
}

function selectedShip() {
  if (!tracker.selected || !tracker.data) return null;
  return tracker.data.ships.find((s) => shipKey(s) === tracker.selected) || null;
}

/** Marker size from ship length (m), a little bigger when zoomed in. */
function shipRadius(s, zoom) {
  const l = s.l || 0;
  const base = l >= 250 ? 8 : l >= 150 ? 7 : l >= 60 ? 5.5 : 4.5;
  return base * (zoom >= 14 ? 1.4 : zoom >= 12 ? 1.15 : zoom <= 9 ? 0.75 : 1);
}

function drawShip(ctx, x, y, r, heading, fill, ring, outline) {
  ctx.save();
  ctx.translate(x, y);
  ctx.beginPath();
  if (heading === undefined || heading === null) {
    ctx.arc(0, 0, r * 0.62, 0, Math.PI * 2);
  } else {
    // A pointed hull, bow up, then rotated to the heading (degrees clockwise from north).
    ctx.rotate((heading * Math.PI) / 180);
    ctx.moveTo(0, -r * 1.5);
    ctx.lineTo(r * 0.72, r * 0.25);
    ctx.lineTo(r * 0.55, r);
    ctx.lineTo(-r * 0.55, r);
    ctx.lineTo(-r * 0.72, r * 0.25);
    ctx.closePath();
  }
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = outline;
  ctx.stroke();
  ctx.restore();
  if (ring) {
    ctx.beginPath();
    ctx.arc(x, y, r * 1.9, 0, Math.PI * 2);
    ctx.lineWidth = 2;
    ctx.strokeStyle = ring;
    ctx.stroke();
  }
}

function draw() {
  const map = tracker.map;
  if (!map || !tracker.canvas || state.view !== "tracker") return;
  const { x: w, y: h } = map.getSize();
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const c = tracker.canvas;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    c.style.width = `${w}px`; c.style.height = `${h}px`;
  }
  const ctx = tracker.ctx;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const colors = catColors();
  const zoom = map.getZoom();
  const bounds = map.getBounds().pad(0.05);
  const drawn = [];
  // Busy categories first, so the rarer cruise ships and ferries sit on top.
  const order = { cargo: 0, ferry: 1, cruise: 2 };
  const ships = visibleShips().slice().sort((a, b) => (order[a.c] || 0) - (order[b.c] || 0));
  let sel = null;
  for (const s of ships) {
    if (!bounds.contains([s.la, s.lo])) continue;
    const p = map.latLngToContainerPoint([s.la, s.lo]);
    const r = shipRadius(s, zoom);
    if (shipKey(s) === tracker.selected) { sel = { s, p, r }; continue; }
    drawShip(ctx, p.x, p.y, r, s.h, colors[s.c] || colors.cargo, null, colors.outline);
    drawn.push({ s, x: p.x, y: p.y });
  }
  if (sel) {
    drawShip(ctx, sel.p.x, sel.p.y, sel.r * 1.25, sel.s.h, colors[sel.s.c] || colors.cargo, colors.accent, colors.outline);
    drawn.push({ s: sel.s, x: sel.p.x, y: sel.p.y });
  }
  tracker.drawn = drawn;
}

let drawFrame = 0;
/** Coalesce redraws while panning: at most one per animation frame. */
function requestDraw() {
  if (drawFrame) return;
  drawFrame = requestAnimationFrame(() => { drawFrame = 0; draw(); });
}

function nearestShip(pt) {
  let best = null;
  let bestD = HIT_PX * HIT_PX;
  // Later entries are drawn on top, so prefer them on a tie.
  for (let i = tracker.drawn.length - 1; i >= 0; i--) {
    const d = tracker.drawn[i];
    const dd = (d.x - pt.x) ** 2 + (d.y - pt.y) ** 2;
    if (dd < bestD) { bestD = dd; best = d.s; }
  }
  return best;
}

function select(key) {
  tracker.selected = key;
  draw();
  renderCard();
}

function renderCard() {
  const card = $("#card");
  const s = selectedShip();
  if (!s) {
    card.classList.remove("show");
    card.setAttribute("aria-hidden", "true");
    $(".map-wrap").classList.remove("card-open");
    return;
  }
  const types = (tracker.data && tracker.data.types) || {};
  const type = (s.tc && types[s.tc]) || s.tc || CAT_LABEL[s.c];
  const flag = s.fl ? `${esc(countryName(s.fl) || s.fl)}${countryName(s.fl) ? ` <small>${esc(s.fl)}</small>` : ""}` : "—";
  const speed = s.s === undefined ? "—" : s.s < STOPPED_KN ? "Stopped" : `${s.s.toFixed(1)} kn`;
  $("#card-body").innerHTML = `
    <p class="c-name">${esc(s.n)}</p>
    <p class="c-type cat-${esc(s.c)}">${esc(type)}${type !== CAT_LABEL[s.c] ? ` <span class="c-cat">· ${esc(CAT_LABEL[s.c])}</span>` : ""}</p>
    <dl class="c-stats">
      ${kv("Flag", flag)}
      ${kv("Speed", esc(speed))}
      ${kv("Length", s.l ? `${num(s.l)} m` : "—")}
      ${kv("IMO", esc(s.imo) || "—")}
    </dl>`;
  card.classList.add("show");
  card.setAttribute("aria-hidden", "false");
  $(".map-wrap").classList.add("card-open");
}

let toastTimer;
function toast(text) {
  const el = $("#toast");
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 3200);
}

/** From an expanded board row: open the Tracker centred on that ship, if it's in the positions. */
async function trackShip(row) {
  showView("tracker");
  if (!tracker.map) return;
  if (!tracker.data || Date.now() - tracker.fetchedAt > AUTO_REFRESH_MS) await loadPositions();
  const ships = (tracker.data && tracker.data.ships) || [];
  const name = (row.name || "").toUpperCase();
  const s = (row.imo && ships.find((x) => x.imo === row.imo)) || ships.find((x) => (x.n || "").toUpperCase() === name);
  if (!s) {
    toast(`${row.name} isn't in the live positions right now.`);
    return;
  }
  if (!visibleShips().includes(s)) {
    tracker.cat = "all"; store.set("mcat", "all"); tracker.group = null;
    renderMapChips(); renderMapNote(); renderWaters();
  }
  tracker.map.setView([s.la, s.lo], Math.max(tracker.map.getZoom(), TRACK_ZOOM));
  select(shipKey(s));
}

// ================================================================ refresh

let refreshing = null;
let lastRefresh = Date.now();

function refreshNow({ manual = false } = {}) {
  if (refreshing) return refreshing;
  const btn = $("#refresh");
  const started = Date.now();
  if (manual) { btn.classList.add("spinning"); btn.disabled = true; }
  else { btn.classList.remove("pulse"); void btn.offsetWidth; btn.classList.add("pulse"); }
  refreshing = loadBoard({ quiet: true, fresh: manual }).then(async () => {
    if (manual) {
      const wait = MIN_SPIN_MS - (Date.now() - started);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      btn.classList.remove("spinning"); btn.disabled = false;
    }
    lastRefresh = Date.now();
    refreshing = null;
  });
  return refreshing;
}

// Auto-refresh whatever is on screen, only while the page is visible.
setInterval(() => {
  if (document.visibilityState !== "visible") { renderUpdated(); return; }
  if (state.view === "tracker") loadPositions(); else refreshNow();
}, AUTO_REFRESH_MS);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (state.view === "tracker") { if (Date.now() - tracker.fetchedAt > AUTO_REFRESH_MS) loadPositions(); }
  else if (Date.now() - lastRefresh > AUTO_REFRESH_MS) refreshNow();
});

// ---------------------------------------------------------------- header clock

const fmtClockTime = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Singapore", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const fmtClockDate = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Singapore", weekday: "short", day: "numeric", month: "short" });

/** Header clock, Singapore time ("13:01" over "SAT 14 NOV · SGT"). Purely visual. */
function startClock() {
  const t = $("#clock-time"), d = $("#clock-date");
  if (!t || !d) return;
  const tick = () => {
    const now = new Date();
    t.textContent = fmtClockTime.format(now);
    const p = Object.fromEntries(fmtClockDate.formatToParts(now).map((x) => [x.type, x.value]));
    d.textContent = `${p.weekday} ${p.day} ${p.month} · SGT`.toUpperCase();
  };
  tick();
  setInterval(tick, 1000);
}

try { startClock(); } catch { /* the clock never blocks the board */ }
bind();
loadBoard();
