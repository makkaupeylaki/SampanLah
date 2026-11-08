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
  if (/arrived|departed/.test(t)) return "done";
  if (/due|board|gate|berthing/.test(t)) return "warn";
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
  const title = [s.st && `Scheduled ${hm(s.st)}`, s.et && `Estimated ${hm(s.et)}`, s.at && `Actual ${hm(s.at)}`].filter(Boolean).join(", ");
  const day = sameDay(t, Date.now()) ? "" : `<small>${esc(fmtDay.format(new Date(t)))}</small>`;
  return `<span class="s-time${changed ? " changed" : ""}" title="${esc(title)}">${esc(hm(t))}${day}</span>`;
}

function rowHTML(s) {
  const open = state.open.has(s.id);
  const type = s.type || CAT_LABEL[s.cat];
  const sub = [`<span class="s-type cat-${esc(s.cat)}">${esc(type)}</span>`, esc(placeText(s))].filter(Boolean).join(" · ");
  return `<div class="ship${open ? " open" : ""}" data-id="${esc(s.id)}">
    <div class="s-row" role="button" tabindex="0" aria-expanded="${open}">
      ${timeHTML(s)}
      <span class="s-main"><span class="s-name">${esc(s.name)}</span><span class="s-sub">${sub}</span></span>
      <span class="s-status"><span class="pill ${statusClass(s)}">${esc(s.status)}</span>${delayTagHTML(s)}</span>
    </div>
    ${open ? detailHTML(s) : ""}
  </div>`;
}

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
  if (!d.updatedAt) { el.innerHTML = `<span class="stale">No data yet</span>`; return; }
  const old = Date.now() - d.updatedAt > OLD_DATA_MS;
  const errors = Object.entries(d.sources || {}).filter(([, v]) => v && v.error && v.okAt).map(([k, v]) => `${k}: ${v.error}`);
  const tail = state.error || d.stale || old
    ? `<span class="stale" title="${esc([state.error, ...errors].filter(Boolean).join("\n"))}">${old ? `${Math.round((Date.now() - d.updatedAt) / 60e3)} min old, may be stale` : "may be stale"}</span>`
    : `auto-refreshes every ${AUTO_REFRESH_MS / 60e3} min`;
  el.innerHTML = `Updated ${esc(hm(d.updatedAt))} SGT · ${tail}`;
}

function renderNote() {
  const el = $("#note");
  const scc = state.data && state.data.sources && state.data.sources.scc;
  const show = scc && scc.error && (state.cat === "all" || state.cat === "ferry");
  el.hidden = !show;
  if (show) {
    el.textContent = scc.okAt
      ? `Ferry terminal board not updating (last good ${hm(scc.okAt)} SGT).`
      : "Ferry terminal board unavailable right now; ferries shown come from MPA declarations only.";
  }
}

function renderChips() {
  for (const b of $$("[data-cat]")) {
    const c = b.dataset.cat;
    const n = state.data ? listFor(state.dir, { cat: c, q: "" }).length : 0;
    const label = { all: "All", ferry: "Ferries", cruise: "Cruise", cargo: "Cargo/Other" }[c];
    b.innerHTML = `${label}${state.data ? `<span class="chip-count">${n}</span>` : ""}`;
    b.setAttribute("aria-pressed", String(c === state.cat));
  }
}

function renderBoard() {
  const box = $("#board");
  box.setAttribute("aria-busy", String(state.loading));
  box.setAttribute("aria-labelledby", `tab-${state.dir}`);
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
    ? more + less + list.map(rowHTML).join("")
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
  state.dir = dir; store.set("dir", dir); state.open.clear(); state.showEarlier = false;
  for (const t of $$(".tab")) t.setAttribute("aria-selected", String(t.dataset.dir === dir));
  renderBoard();
}

function bind() {
  $$(".tab").forEach((t) => t.addEventListener("click", () => setDir(t.dataset.dir)));
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
  setDir(state.dir);
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

setInterval(() => {
  if (document.visibilityState === "visible") refreshNow();
  else renderUpdated();
}, AUTO_REFRESH_MS);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && Date.now() - lastRefresh > AUTO_REFRESH_MS) refreshNow();
});

bind();
loadBoard();
