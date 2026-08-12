/**
 * App shell: hash router, page mount/unmount, "data updated" stamp pulled
 * from the store. Installs window.__pc for the audit harness.
 */
import "./theme.css";
import { loadAtlas, subscribe, installAuditHandle } from "./store.js";
import { render as renderMap } from "./pages/map.js";
import { render as renderReturns } from "./pages/returns.js";
import { render as renderHistory } from "./pages/history.js";
import { render as renderCountry } from "./pages/country.js";
import { render as renderSignals } from "./pages/signals.js";

installAuditHandle();

const PAGES = {
  map: { el: "page-map", render: renderMap },
  returns: { el: "page-returns", render: renderReturns },
  history: { el: "page-history", render: renderHistory },
  country: { el: "page-country", render: renderCountry },
  signals: { el: "page-signals", render: renderSignals },
};

let current = { dispose: null, el: null };
let navSeq = 0;

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, "") || "map";
  const [name, param] = raw.split("/");
  return { name: name || "map", param: param || null };
}

async function route() {
  const my = ++navSeq;
  const { name, param } = parseHash();
  const spec = PAGES[name] || PAGES.map;

  if (current.dispose) {
    try {
      current.dispose();
    } catch (e) {
      /* already disposed */
    }
  }

  for (const [key, page] of Object.entries(PAGES)) {
    document.getElementById(page.el).classList.toggle("active", key === (name === "country" ? "country" : name) || (name !== "country" && !PAGES[name] && key === "map"));
  }
  document.querySelectorAll(".pc-nav a").forEach((a) => {
    const isActive =
      a.dataset.route === name ||
      (name === "country" && a.dataset.route === "map") ||
      (!PAGES[name] && a.dataset.route === "map");
    a.classList.toggle("active", isActive);
  });

  const el = document.getElementById(spec.el);
  el.innerHTML = "";
  current.el = el;
  const rendered = await spec.render(el, param ? { iso: param } : {});
  if (my !== navSeq) {
    // a newer navigation superseded this one mid-render — dispose the
    // orphan immediately so chart registries never leak stale instances
    rendered?.dispose?.();
    return;
  }
  current.dispose = rendered?.dispose || null;
}

subscribe(() => {
  const stamp = document.getElementById("pc-stamp");
  if (stamp && window.__pc?.state?.generated) {
    stamp.textContent = new Date(window.__pc.state.generated).toUTCString().slice(0, 22);
  }
});

window.addEventListener("hashchange", route);

// warm the atlas cache before the first route so the stamp renders fast
loadAtlas()
  .then(route)
  .catch(() => route());