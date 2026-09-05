(function () {
  "use strict";

  /* ── Mobile menu ─────────────────────────────────────────── */
  var burger = document.getElementById("nav-burger");
  var backdrop = document.getElementById("mobile-menu-backdrop");
  var CLOSE_MS = 300;
  var closeTimer = null;

  function openMenu() {
    document.body.classList.remove("menu-closing");
    document.body.classList.add("menu-open");
    if (burger) burger.setAttribute("aria-expanded", "true");
  }
  function closeMenu() {
    if (!document.body.classList.contains("menu-open")) return;
    document.body.classList.remove("menu-open");
    document.body.classList.add("menu-closing");
    if (burger) burger.setAttribute("aria-expanded", "false");
    clearTimeout(closeTimer);
    closeTimer = setTimeout(function () {
      document.body.classList.remove("menu-closing");
    }, CLOSE_MS);
  }
  if (burger) {
    burger.addEventListener("click", function () {
      document.body.classList.contains("menu-open") ? closeMenu() : openMenu();
    });
  }
  if (backdrop) backdrop.addEventListener("click", closeMenu);
  document.querySelectorAll(".mobile-menu-link, .mobile-menu-cta").forEach(function (el) {
    el.addEventListener("click", closeMenu);
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") closeMenu();
  });
  window.addEventListener("resize", function () {
    if (window.innerWidth > 639) {
      document.body.classList.remove("menu-open", "menu-closing");
      if (burger) burger.setAttribute("aria-expanded", "false");
    }
  });

  /* ── GitHub stars ────────────────────────────────────────── */
  var starsBtn = document.getElementById("gh-stars-btn");
  var starsCount = document.getElementById("gh-stars-count");
  var GH_REPO = "focux/open-ota";
  var GH_KEY = "openota:gh-stars";
  var GH_TTL = 5 * 60 * 1000;

  function fmtStars(n) {
    if (n >= 1000) return (Math.round(n / 100) / 10) + "k";
    return String(n);
  }
  function setStars(n) {
    if (starsCount) starsCount.textContent = fmtStars(n);
    if (starsBtn) starsBtn.removeAttribute("data-loading");
  }
  if (starsBtn && starsCount) {
    var cached = null;
    try { cached = JSON.parse(sessionStorage.getItem(GH_KEY) || "null"); } catch (e) {}
    if (cached && Date.now() - cached.t < GH_TTL) {
      setStars(cached.n);
    } else {
      fetch("https://api.github.com/repos/" + GH_REPO)
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (typeof d.stargazers_count === "number") {
            try { sessionStorage.setItem(GH_KEY, JSON.stringify({ n: d.stargazers_count, t: Date.now() })); } catch (e) {}
            setStars(d.stargazers_count);
          } else if (cached) { setStars(cached.n); }
          else { if (starsCount) starsCount.textContent = "Star"; if (starsBtn) starsBtn.removeAttribute("data-loading"); }
        })
        .catch(function () {
          if (cached) setStars(cached.n);
          else { if (starsCount) starsCount.textContent = "Star"; if (starsBtn) starsBtn.removeAttribute("data-loading"); }
        });
    }
  }
})();
