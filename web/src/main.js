/**
 * App shell: theme boot, hash router, page mount/unmount, and the "data
 * updated" stamp. Installs window.__pc for the audit harness.
 */
import "./theme.css";
import { initTheme, cycleTheme, currentPreference, THEME_ICON } from "./theme.js";
import { loadAtlas, subscribe, installAuditHandle } from "./store.js";
import { render as renderMap } from "./pages/map.js";
import { render as renderOpportunities } from "./pages/opportunities.js";
import { render as renderForecast } from "./pages/forecast.js";
import { render as renderSpreads } from "./pages/spreads.js";
import { render as renderReturns } from "./pages/returns.js";
import { render as renderHistory } from "./pages/history.js";
import { render as renderCountry } from "./pages/country.js";
import { render as renderSignals } from "./pages/signals.js";
import { render as renderDrivers } from "./pages/drivers.js";

initTheme();
installAuditHandle();

const PAGES = {
  map: { el: "page-map", render: renderMap },
  opportunities: { el: "page-opportunities", render: renderOpportunities },
  forecast: { el: "page-forecast", render: renderForecast },
  spreads: { el: "page-spreads", render: renderSpreads },
  returns: { el: "page-returns", render: renderReturns },
  history: { el: "page-history", render: renderHistory },
  country: { el: "page-country", render: renderCountry },
  signals: { el: "page-signals", render: renderSignals },
  drivers: { el: "page-drivers", render: renderDrivers },
};

let current = { dispose: null };
let navSeq = 0;

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, "") || "map";
  const [name, param] = raw.split("/");
  return { name: PAGES[name] ? name : "map", param: param || null };
}

async function route() {
  const my = ++navSeq;
  const { name, param } = parseHash();
  const spec = PAGES[name];

  if (current.dispose) {
    try {
      current.dispose();
    } catch (e) {
      /* already disposed */
    }
    current.dispose = null;
  }

  for (const [key, page] of Object.entries(PAGES)) {
    document.getElementById(page.el).classList.toggle("active", key === name);
  }
  // the country drill-down is reached from the map, so Map stays lit for it
  const navFor = name === "country" ? "map" : name;
  document.querySelectorAll(".pc-nav a").forEach((a) => a.classList.toggle("active", a.dataset.route === navFor));

  const el = document.getElementById(spec.el);
  el.innerHTML = "";
  window.scrollTo({ top: 0 });

  let rendered = null;
  try {
    rendered = await spec.render(el, param ? { iso: param } : {});
  } catch (e) {
    // a page that throws must not leave a blank shell behind
    console.error(`[pc] page "${name}" failed to render`, e);
    el.innerHTML = `<div class="pc-empty">
      <div style="font-weight:620;color:var(--text-main);margin-bottom:6px">This view failed to render</div>
      <div style="font-size:12px">${String(e && e.message ? e.message : e)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")}</div></div>`;
  }

  if (my !== navSeq) {
    // a newer navigation superseded this one mid-render — dispose the orphan
    // immediately so chart registries never leak stale instances
    rendered?.dispose?.();
    return;
  }
  current.dispose = rendered?.dispose || null;
}

subscribe(() => {
  const stamp = document.getElementById("pc-stamp");
  const g = window.__pc?.state?.generated;
  if (stamp && g) stamp.textContent = new Date(g).toUTCString().slice(5, 22);
});

/* ---------------- theme toggle ---------------- */
const themeBtn = document.getElementById("pc-theme");
function paintThemeBtn() {
  const pref = currentPreference();
  themeBtn.textContent = THEME_ICON[pref];
  themeBtn.title = `Theme: ${pref} — click to change`;
  themeBtn.setAttribute("aria-label", `Theme: ${pref}`);
}
if (themeBtn) {
  paintThemeBtn();
  themeBtn.addEventListener("click", () => {
    cycleTheme();
    paintThemeBtn();
  });
}

window.addEventListener("hashchange", route);

// warm the atlas before the first route so the stamp and map land together
loadAtlas()
  .then(route)
  .catch(() => route());
