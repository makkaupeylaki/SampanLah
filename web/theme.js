// harbourlah theme toggle: Legacy (default, dark green + lime) or Classic (navy + amber),
// mirroring flightlah's theme.js. The choice is applied before first paint by the inline
// script in index.html's <head>; this file wires up the Legacy | Classic buttons. The active
// button's look comes from html[data-theme] in style.css, so it is right from the first paint;
// aria-pressed is set here for screen readers. The browser bar colour (meta theme-color)
// follows the theme's --bg token.
(function () {
  var KEY = "harbourlah-theme";
  var root = document.documentElement;
  function current() { return root.dataset.theme === "classic" ? "classic" : "legacy"; }
  function sync() {
    var t = current();
    var btns = document.querySelectorAll("[data-theme-set]");
    for (var i = 0; i < btns.length; i++) btns[i].setAttribute("aria-pressed", String(btns[i].dataset.themeSet === t));
    var meta = document.querySelector('meta[name="theme-color"]');
    var bg = getComputedStyle(root).getPropertyValue("--bg").trim();
    if (meta && bg) meta.setAttribute("content", bg);
    // Canvas drawing (the Tracker's ships) reads colours from the tokens: tell it to re-read.
    try { window.dispatchEvent(new CustomEvent("themechange", { detail: t })); } catch (err) { /* old browser */ }
  }
  function apply(t) {
    root.dataset.theme = t === "classic" ? "classic" : "legacy";
    sync();
  }
  document.addEventListener("click", function (e) {
    var b = e.target && e.target.closest ? e.target.closest("[data-theme-set]") : null;
    if (!b) return;
    apply(b.dataset.themeSet);
    try { localStorage.setItem(KEY, current()); } catch (err) { /* storage blocked: this page only */ }
  });
  // Changed in another tab: follow it here too.
  window.addEventListener("storage", function (e) { if (e.key === KEY) apply(e.newValue); });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", sync);
  else sync();
})();
