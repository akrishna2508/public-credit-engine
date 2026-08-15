/**
 * Returns page: the VAR forecast path for each asset, on a real date axis.
 *
 * Two economically different books sit behind the same chart, chosen by the
 * BASIS control:
 *
 *   Buy and hold — what you earn by owning the asset. Spread or yield, and
 *   that carry net of the loss you expect to suffer. Nothing is deducted for
 *   a dealer, a premium or execution, because a holder pays none of them.
 *
 *   Volatility strategy — what a long straddle pays. Gross is the average
 *   absolute move captured on high-volatility days; the net tiers subtract
 *   the straddle premium a dealer charges plus execution friction, which is
 *   why they can be negative.
 *
 * They were previously two different pages' worth of ideas crammed into one
 * label ("Pure assets"), which is what made a dealer markup on a bond look
 * like a bug. Each basis now names itself and carries its own view chips.
 */
import { loadReturns, setSeriesVisible } from "../store.js";
import { buildProjectionChart, viewsFor, PALETTE } from "../charts/projection.js";
import { buildLegend } from "../legend.js";
import { buildPeriodBar, PERIODS } from "../controls.js";

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const BASES = [
  { value: "hold", label: "Buy & hold" },
  { value: "vol", label: "Volatility strategy" },
];
const MARKETS = [
  { value: "us", label: "United States" },
  { value: "eu", label: "Europe" },
  { value: "em", label: "Emerging markets" },
  { value: "countries", label: "Countries" },
];
// "Single asset" means one instrument on its own; "Relative value" means the
// difference between two — a straddle on the spread between them under the
// volatility basis, the extra carry one pays over the other under buy & hold.
const MODES = [
  { value: "pure", label: "Single asset" },
  { value: "spread", label: "Relative value" },
];

const BASIS_COPY = {
  hold: {
    heading: "Buy-and-hold forecast",
    blurb:
      "Carry accrued while you own the asset, marked to a VAR forecast of the spread or yield. Where the forecast level rises by more than the carry pays, the line turns over; that point is marked.",
  },
  vol: {
    heading: "Volatility strategy forecast",
    blurb:
      "One at-the-money straddle, opened now and marked to market each month to expiry. Value comes from the underlying drifting away from the strike; against it run time decay, the dealer premium and financing on that premium. Single asset trades the level, relative value trades the spread between two.",
  },
};

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
  let basis = ctx.basis === "vol" ? "vol" : "hold";
  let market = ctx.market || "us";
  let mode = ctx.mode || "pure";
  let view = null; // resolved against the active basis on every rebuild
  let payload = null;
  let chartRec = null;
  let pb = null;
  const hidden = new Set();

  root.innerHTML = `
  <div class="pc-hero">
    <h1 id="hero-h"></h1>
    <p id="hero-p"></p>
  </div>
  <div class="pc-card pc-card-pad">
    <div class="pc-controls" style="justify-content:space-between;flex-wrap:wrap;gap:12px">
      <div class="pc-controls">
        <div id="basis-seg"></div>
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
  const viewSegEl = root.querySelector("#view-seg");
  const modeSegEl = root.querySelector("#mode-seg");

  function rebuild() {
    if (chartRec) {
      chartRec.dispose();
      chartRec = null;
    }
    legendEl.innerHTML = "";

    const copy = BASIS_COPY[basis];
    root.querySelector("#hero-h").textContent = copy.heading;
    root.querySelector("#hero-p").innerHTML = copy.blurb;

    // the view chips belong to the basis: buy & hold has no HF/retail split
    const views = viewsFor(basis);
    if (!view || !views[view]) view = Object.keys(views)[Object.keys(views).length - 1];
    seg(viewSegEl, Object.entries(views).map(([value, v]) => ({ value, label: v.label })), {
      active: view,
      onChange: (v) => {
        view = v;
        rebuild();
      },
    });
    viewDesc.textContent = `${views[view].label} — ${views[view].desc}`;

    const book = payload?.markets?.[market] || {};
    // a market with no relative-value legs (every sovereign book) should not
    // offer a chip that leads to an empty chart
    const modes = MODES.filter((m) => m.value === "pure" || (book[m.value] || []).length);
    if (!modes.some((m) => m.value === mode)) mode = "pure";
    seg(modeSegEl, modes, {
      active: mode,
      onChange: (v) => {
        mode = v;
        hidden.clear();
        rebuild();
      },
    });

    const items = (book[mode] || []).filter((a) => a && !a.unavailable);
    if (!items.length) {
      chartEl.innerHTML = `<div class="pc-empty">No ${market}/${mode} assets on the ${
        basis === "vol" ? "volatility" : "buy-and-hold"
      } basis${payload?.why ? ` — ${payload.why}` : ""}.</div>`;
      methodNote.innerHTML = "";
      return;
    }
    chartEl.innerHTML = "";

    chartRec = buildProjectionChart(chartEl, items, {
      id: "returns",
      view,
      views,
      initialHidden: hidden,
    });
    buildLegend(
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
    // presets that overrun the model's horizon would silently clamp to the
    // same window and read as broken buttons, so only the ones that fit show
    const hz = chartRec.horizonMonths;
    const periods = PERIODS.filter((p, i) => p.months <= hz || (i > 0 && PERIODS[i - 1].months < hz));
    pb = buildPeriodBar(root.querySelector("#periods"), {
      periods,
      initial: periods[periods.length - 1].label,
      onSelect: (preset) => chartRec && chartRec.applyPreset(preset),
    });

    const model = payload?.models?.[market] || Object.values(payload?.models || {})[0];
    const method = (payload.method || []).join(" · ");
    methodNote.innerHTML = `${esc(payload.label || "")}${
      payload.generated ? ` · as of ${new Date(payload.generated).toUTCString().slice(0, 22)}` : ""
    }${model?.why ? `<br>${esc(model.why)}` : ""}${method ? `<br>${esc(method)}` : ""}`;
  }

  async function refresh() {
    payload = await loadReturns(market, mode, basis);
    rebuild();
  }

  seg(root.querySelector("#basis-seg"), BASES, {
    active: basis,
    onChange: (v) => {
      basis = v;
      view = null; // the view chips differ between the two books
      hidden.clear();
      refresh();
    },
  });
  seg(root.querySelector("#market-seg"), MARKETS, {
    active: market,
    onChange: (v) => {
      market = v;
      hidden.clear();
      refresh();
    },
  });

  await refresh();
  return {
    dispose() {
      if (chartRec) chartRec.dispose();
    },
  };
}
