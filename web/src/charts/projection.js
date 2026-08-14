/**
 * Projection chart: cumulative return extrapolated from the live hold-horizon
 * curves, horizon axis 1 month -> 15 years.
 *
 * Mechanics (honest, labeled): the first month is anchored to the observed
 * hold-curve payout (net bps at the longest evaluated hold — 21 days for
 * daily series, 1 month for the monthly country series); beyond that the
 * curve compounds the same annualized edge. Three views: Gross payout / HF
 * net / Retail net (heatmap tiers 1-3). Period buttons + wheel/pinch zoom via
 * dataZoom. Each line's legend entry shows the full name + what it stands
 * for, and clicking an entry toggles exactly that line.
 */
import * as echarts from "echarts";
import { dataZoomConfig } from "../controls.js";
import { registerChart, unregisterChart } from "../store.js";
import { cssVar, onThemeChange } from "../theme.js";

export const PALETTE = [
  "#2563eb", "#0f9d58", "#d98613", "#d92d20", "#7c3aed",
  "#0891b2", "#be185d", "#65a30d", "#ea580c", "#4f46e5",
  "#0f766e", "#c026d3", "#15803d", "#db2777", "#ca8a04", "#1d4ed8",
];

// The three tiers differ only in what the straddle costs to put on. Gross
// assumes you get the option for nothing, which no one does; it is the
// ceiling, not a return.
const VIEWS = {
  gross: {
    col: 1,
    label: "Gross payout",
    desc: "Tier 1 · the average absolute move captured on high-volatility days, before paying for the option. A ceiling, not an achievable return.",
  },
  hf: {
    col: 2,
    label: "HF net",
    desc: "Tier 2 · after the dealer's straddle premium at institutional size, with the prime-broker volume discount applied.",
  },
  ret: {
    col: 3,
    label: "Retail net",
    desc: "Tier 3 · after the full dealer straddle premium and execution friction. Negative means the option costs more than the move it captures.",
  },
};

function firstMonthBps(asset, col) {
  // daily units: net at the longest evaluated hold (21 days ~ 1 month);
  // monthly units: net at the 1-month hold
  const rows = asset.curves || [];
  const idx = asset.unit === "months" ? 0 : rows.length - 1;
  const row = rows[idx];
  if (!row) return null;
  const v = row[col];
  return Number.isFinite(v) ? v : null;
}

function cumulativeSeries(asset, col, totalMonths = 180) {
  const r1 = firstMonthBps(asset, col); // bps over the first month
  const edge = asset.edge ? asset.edge[col === 1 ? "gross" : col === 2 ? "hf" : "ret"] : null;
  if (r1 == null || edge == null) return null;
  const monthly = edge / 12 / 10000; // annualized bps -> monthly fraction
  const pts = [[0, 0]];
  for (let h = 1; h <= totalMonths; h++) {
    const cum = (1 + r1 / 10000) * Math.pow(1 + monthly, h - 1) - 1;
    pts.push([h, Math.round(cum * 10000) / 10000 * 100]);
  }
  return pts;
}

export function buildProjectionChart(el, assets, opts = {}) {
  const id = opts.id || "projection";
  const view = opts.view || "ret";
  const initialHidden = opts.initialHidden || new Set();
  const col = VIEWS[view].col;
  const totalMonths = 180;
  const chart = echarts.init(el);

  const rec = registerChart(id, {
    chart,
    el,
    seriesIds: assets.map((a) => a.id),
    visible: new Set(assets.map((a) => a.id).filter((x) => !initialHidden.has(x))),
    refresh: null, // set below
  });
  const visible = () => rec.visible;

  // The x-axis is a FORWARD horizon (0 = now, 180 = fifteen years out), so a
  // period preset windows the NEAR end of the projection: "1Y" means the
  // first twelve months, not the last twelve. The previous code windowed from
  // the far end, which collapsed "1M" onto the single final point.
  const horizon = { end: totalMonths };

  const buildOption = () => {
    const series = [];
    for (let ai = 0; ai < assets.length; ai++) {
      const a = assets[ai];
      // a hidden series is OMITTED, not flagged. ECharts has no `hidden`
      // series property, so the old `hidden: !show` was silently ignored and
      // legend clicks did nothing.
      if (!visible().has(a.id)) continue;
      const pts = cumulativeSeries(a, col, totalMonths);
      if (!pts) continue;
      series.push({
        id: a.id,
        type: "line",
        name: a.name,
        data: pts,
        showSymbol: false,
        smooth: false,
        lineStyle: { width: 2, color: PALETTE[ai % PALETTE.length] },
        itemStyle: { color: PALETTE[ai % PALETTE.length] },
        emphasis: { focus: "series" },
      });
    }
    return {
      series,
      animation: false,
      backgroundColor: "transparent",
      grid: { left: 64, right: 24, top: 30, bottom: 48 },
      tooltip: {
        trigger: "axis",
        backgroundColor: cssVar("--bg-card"),
        borderColor: cssVar("--border"),
        textStyle: { color: cssVar("--text-main"), fontSize: 12 },
        extraCssText: "box-shadow:0 8px 28px -10px rgba(0,0,0,.4);border-radius:10px;",
        valueFormatter: (v) => `${Number(v).toFixed(2)}%`,
        formatter: (params) => {
          if (!params.length) return "";
          const h = params[0].value[0];
          const label =
            h === 0 ? "today" : h < 12 ? `${h}M` : h % 12 === 0 ? `${h / 12}Y` : `${(h / 12).toFixed(1)}Y`;
          const rows = params
            .map((p) => {
              const a = assets.find((x) => x.id === p.seriesId);
              const r1 = firstMonthBps(a, col);
              return `<tr><td style="color:${p.color};padding-right:10px">${esc(p.seriesName)}</td><td style="text-align:right;font-variant-numeric:tabular-nums">${p.value[1] != null ? p.value[1].toFixed(2) : "—"}%</td><td style="color:${cssVar("--text-secondary")};padding-left:10px">month-1 net ${r1 != null ? r1.toFixed(1) : "—"} bps</td></tr>`;
            })
            .join("");
          return `<div style="font-weight:640;margin-bottom:4px">Horizon: ${label}</div>
                  <table style="border-collapse:collapse;font-size:11.5px">${rows}</table>
                  <div style="font-size:10.5px;color:${cssVar("--text-faint")};margin-top:5px">Extrapolated from live hold-horizon curves — not a forecast</div>`;
        },
      },
      xAxis: {
        type: "value",
        name: "Horizon",
        nameLocation: "middle",
        nameGap: 26,
        min: 0,
        max: totalMonths,
        nameTextStyle: { color: cssVar("--axis-text"), fontSize: 11 },
        axisLine: { lineStyle: { color: cssVar("--border") } },
        axisLabel: {
          color: cssVar("--axis-text"),
          fontSize: 10.5,
          formatter: (v) => {
            if (v === 0) return "now";
            if (v < 12) return `${v}M`;
            if (v % 12 === 0) return `${v / 12}Y`;
            return `${(v / 12).toFixed(1)}Y`;
          },
        },
        splitLine: { lineStyle: { color: cssVar("--grid-line") } },
      },
      yAxis: {
        type: "value",
        name: "Cumulative return (%)",
        nameLocation: "middle",
        nameGap: 44,
        nameTextStyle: { color: cssVar("--axis-text"), fontSize: 11 },
        axisLabel: { color: cssVar("--axis-text"), fontSize: 10.5, formatter: (v) => `${v}%` },
        splitLine: { lineStyle: { color: cssVar("--grid-line") } },
      },
      dataZoom: dataZoomConfig({ mode: "value", startValue: 0, endValue: horizon.end }),
    };
  };

  let currentOption = buildOption();
  chart.setOption(currentOption);
  rec.refresh = () => {
    currentOption = buildOption();
    chart.setOption(currentOption, { notMerge: true });
  };

  rec.applyPreset = (preset) => {
    horizon.end = Math.max(1, Math.min(totalMonths, preset.months));
    // both components must be told, or the slider handles and the plot drift
    // apart after a preset click
    for (const dataZoomIndex of [0, 1]) {
      chart.dispatchAction({ type: "dataZoom", dataZoomIndex, startValue: 0, endValue: horizon.end });
    }
  };

  const onResize = () => chart.resize();
  window.addEventListener("resize", onResize);
  const offTheme = onThemeChange(() => rec.refresh());
  rec.dispose = () => {
    unregisterChart(id);
    window.removeEventListener("resize", onResize);
    offTheme();
    chart.dispose();
  };
  return rec;
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export { VIEWS };