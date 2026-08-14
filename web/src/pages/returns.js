/**
 * Returns page: cumulative 1-month -> 15-year projections extrapolated from
 * the live hold-horizon curves. Market / mode / view chips, period bar,
 * full-name toggleable legend, honest methodology notes.
 */
import { loadReturns, setSeriesVisible } from "../store.js";
import { buildProjectionChart, VIEWS, PALETTE } from "../charts/projection.js";
import { buildLegend } from "../legend.js";
import { buildPeriodBar } from "../controls.js";

const MARKETS = [
  { value: "us", label: "United States" },
  { value: "eu", label: "Europe" },
  { value: "em", label: "Emerging markets" },
  { value: "countries", label: "Countries" },
];
// "pure" means a SINGLE-asset straddle; "spread" means a straddle on the
// difference between two assets. Neither is a buy-and-hold bond position —
// the old "Pure assets" label read as if it were, which is why a dealer
// markup on it looked like a mistake. Holding is priced on the Spreads page.
const MODES = [
  { value: "pure", label: "Single asset" },
  { value: "spread", label: "Relative value" },
];
const VIEW_CHIPS = [
  { value: "gross", label: "Gross payout" },
  { value: "hf", label: "HF net" },
  { value: "ret", label: "Retail net" },
];

function seg(container, options, { onChange, active } = {}) {
  container.classList.add("pc-seg");
  container.innerHTML = "";
  for (const o of options) {
    const b = document.createElement("button");
    b.textContent = o.label;
    b.dataset.value = o.value;
    if (o.value === active) b.classList.add("active");
    b.addEventListener("click", () => {
      container.querySelectorAll("button").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      onChange(o.value);
    });
    container.appendChild(b);
  }
}

export async function render(root, ctx = {}) {
  let market = ctx.market || "us";
  let mode = ctx.mode || "pure";
  let view = ctx.view || "ret";
  let payload = null;
  let chartRec = null;
  let legendApi = null;
  let pb = null;
  const hidden = new Set();

  root.innerHTML = `
  <div class="pc-hero">
    <h1>Volatility strategy returns</h1>
    <p>This page prices a <b>long-volatility straddle</b>, not a bond you buy and hold. Gross is the average absolute move captured on high-volatility days; the net tiers subtract the straddle premium a dealer charges plus execution friction, which is why they can be negative. For what you earn simply by <b>owning</b> credit — spread minus expected loss, with no dealer markup of any kind — see <a href="#/spreads" style="color:var(--accent);font-weight:600">Spreads</a>.</p>
  </div>
  <div class="pc-card pc-card-pad">
    <div class="pc-controls" style="justify-content:space-between;flex-wrap:wrap;gap:12px">
      <div class="pc-controls">
        <div id="market-seg"></div>
        <div id="mode-seg"></div>
        <div id="view-seg"></div>
      </div>
      <div id="periods"></div>
    </div>
    <div class="pc-note" id="view-desc" style="margin:14px 0 4px"></div>
    <div class="grid-12">
      <div class="col-8"><div id="chart-el" style="height:520px"></div></div>
      <div class="col-4">
        <div class="pc-card-sub" style="margin-top:2px">Legend — click a name to toggle exactly that line</div>
        <div id="legend-el"></div>
        <div class="pc-note" id="method-note"></div>
      </div>
    </div>
  </div>`;

  const chartEl = root.querySelector("#chart-el");
  const legendEl = root.querySelector("#legend-el");
  const viewDesc = root.querySelector("#view-desc");
  const methodNote = root.querySelector("#method-note");

  function rebuild() {
    if (chartRec) {
      chartRec.dispose();
      chartRec = null;
    }
    legendEl.innerHTML = "";
    legendApi = null;
    viewDesc.textContent = VIEWS[view] ? `${VIEWS[view].label} — ${VIEWS[view].desc}` : "";

    const items = (payload?.markets?.[market]?.[mode] || []).filter((a) => a && !a.unavailable);
    if (!items.length) {
      chartEl.innerHTML = `<div class="pc-empty">No ${market}/${mode} assets${
        payload?.why ? ` — ${payload.why}` : ""
      }.</div>`;
      methodNote.innerHTML = "";
      return;
    }

    chartRec = buildProjectionChart(chartEl, items, { id: "returns", view, initialHidden: hidden });
    legendApi = buildLegend(
      legendEl,
      items.map((a, i) => ({
        id: a.id,
        name: a.name,
        standsFor: a.standsFor,
        color: PALETTE[i % PALETTE.length],
      })),
      {
        onToggle: (id, on) => {
          if (on) hidden.delete(id);
          else hidden.add(id);
          setSeriesVisible("returns", id, on);
        },
      }
    );
    if (!pb) {
      pb = buildPeriodBar(root.querySelector("#periods"), {
        onSelect: (preset) => chartRec && chartRec.applyPreset(preset),
      });
    }
    // switching market/mode/view builds a NEW chart at full range, so the
    // still-highlighted preset button would be lying about the visible window
    const active = pb.current();
    if (active) chartRec.applyPreset(active);
    const approx = (payload.approximations || []).join(" · ");
    methodNote.innerHTML = `${payload.label || "Extrapolated from live hold-horizon curves — not a forecast"}${
      payload.generated ? ` · as of ${new Date(payload.generated).toUTCString().slice(0, 22)}` : ""
    }${approx ? `<br>${approx}` : ""}`;
  }

  async function refresh() {
    payload = await loadReturns(market, mode);
    rebuild();
  }

  seg(root.querySelector("#market-seg"), MARKETS, {
    active: market,
    onChange: (v) => {
      market = v;
      hidden.clear();
      refresh();
    },
  });
  seg(root.querySelector("#mode-seg"), MODES, {
    active: mode,
    onChange: (v) => {
      mode = v;
      hidden.clear();
      refresh();
    },
  });
  seg(root.querySelector("#view-seg"), VIEW_CHIPS, {
    active: view,
    onChange: (v) => {
      view = v;
      rebuild();
    },
  });

  await refresh();
  return {
    dispose() {
      if (chartRec) chartRec.dispose();
    },
  };
}