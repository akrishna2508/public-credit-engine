/**
 * Forecast chart: the VAR's projected path for each asset, on a real date
 * axis running from the last observation to the end of the model's usable
 * horizon.
 *
 * The series plotted are whatever /api/returns puts in each asset's `path` —
 * cumulative return in bps at each forecast month, converted to per cent
 * here. Nothing is compounded or extended in this file; the shape of the line
 * is the model's, and the line stops where the model does.
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

/** each view names the key it reads out of the forecast path */
const VOL_VIEWS = {
  gross: { key: "gross", label: "Gross payout", desc: "Expected move to maturity, before the premium." },
  hf: { key: "hf", label: "HF net", desc: "After the dealer premium at institutional size and execution friction." },
  ret: { key: "ret", label: "Retail net", desc: "After the full dealer premium and execution friction." },
};

const HOLD_VIEWS = {
  gross: { key: "ret", label: "Gross carry", desc: "Carry accrued, marked to the forecast spread or yield." },
  net: { key: "net", label: "Net of expected loss", desc: "Gross carry less expected loss; for sovereigns, less the latest inflation print." },
};

export function viewsFor(basis) {
  return basis === "vol" ? VOL_VIEWS : HOLD_VIEWS;
}

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const ts = (d) => new Date(d + "T00:00:00Z").getTime();

/** [[epoch, percent], ...] for one asset under one view */
function pointsFor(asset, key) {
  const path = asset.path || [];
  if (!path.length) return null;
  const pts = [];
  for (const r of path) {
    const v = r[key] !== undefined && r[key] !== null ? r[key] : r.ret;
    if (!Number.isFinite(v)) continue;
    pts.push([ts(r.date), Math.round(v) / 100]);
  }
  return pts.length ? pts : null;
}

export function buildProjectionChart(el, assets, opts = {}) {
  const id = opts.id || "projection";
  const views = opts.views || VOL_VIEWS;
  const view = opts.view && views[opts.view] ? opts.view : Object.keys(views)[0];
  const key = views[view].key;
  const initialHidden = opts.initialHidden || new Set();
  const chart = echarts.init(el);

  const rec = registerChart(id, {
    chart,
    el,
    seriesIds: assets.map((a) => a.id),
    visible: new Set(assets.map((a) => a.id).filter((x) => !initialHidden.has(x))),
    refresh: null,
  });
  const visible = () => rec.visible;

  // full date extent across every asset — horizons differ per market because
  // each panel's model runs out at a different point
  let tMin = Infinity;
  let tMax = -Infinity;
  for (const a of assets) {
    for (const r of a.path || []) {
      const t = ts(r.date);
      if (t < tMin) tMin = t;
      if (t > tMax) tMax = t;
    }
  }
  if (!Number.isFinite(tMin)) {
    tMin = Date.now();
    tMax = tMin;
  }
  const win = { from: tMin, to: tMax };

  const buildOption = () => {
    const series = [];
    assets.forEach((a, ai) => {
      if (!visible().has(a.id)) return;
      const pts = pointsFor(a, key);
      if (!pts) return;
      const color = PALETTE[ai % PALETTE.length];
      const s = {
        id: a.id,
        type: "line",
        name: a.name,
        data: pts,
        showSymbol: false,
        smooth: false,
        lineStyle: { width: 2, color },
        itemStyle: { color },
        emphasis: { focus: "series" },
      };
      // the turning point, where the model says holding longer stops paying
      if (a.peak && a.peak.date) {
        s.markPoint = {
          symbol: "circle",
          symbolSize: 7,
          label: { show: false },
          itemStyle: { color },
          data: [{ coord: [ts(a.peak.date), Math.round(a.peak.value) / 100] }],
        };
      }
      series.push(s);
    });

    return {
      series,
      animation: false,
      backgroundColor: "transparent",
      grid: { left: 64, right: 24, top: 30, bottom: 52 },
      tooltip: {
        trigger: "axis",
        backgroundColor: cssVar("--bg-card"),
        borderColor: cssVar("--border"),
        textStyle: { color: cssVar("--text-main"), fontSize: 12 },
        extraCssText: "box-shadow:0 8px 28px -10px rgba(0,0,0,.4);border-radius:10px;",
        formatter: (params) => {
          if (!params.length) return "";
          const d = new Date(params[0].value[0]);
          const head = d.toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" });
          const rows = params
            .map((p) => {
              const a = assets.find((x) => x.id === p.seriesId);
              const row = (a?.path || []).find((r) => ts(r.date) === p.value[0]);
              const band =
                row && Number.isFinite(row.lo) && Number.isFinite(row.hi)
                  ? `<td style="color:${cssVar("--text-secondary")};padding-left:10px">${(row.lo / 100).toFixed(1)} to ${(row.hi / 100).toFixed(1)}%</td>`
                  : "<td></td>";
              const lvl =
                row && Number.isFinite(row.level)
                  ? `<td style="color:${cssVar("--text-faint")};padding-left:10px">${row.level.toFixed(0)} bps</td>`
                  : "<td></td>";
              return `<tr><td style="color:${p.color};padding-right:10px">${esc(p.seriesName)}</td><td style="text-align:right;font-variant-numeric:tabular-nums">${p.value[1].toFixed(2)}%</td>${band}${lvl}</tr>`;
            })
            .join("");
          return `<div style="font-weight:640;margin-bottom:4px">${head}</div><table style="border-collapse:collapse;font-size:11.5px">${rows}</table>`;
        },
      },
      xAxis: {
        type: "time",
        min: tMin,
        max: tMax,
        axisLine: { lineStyle: { color: cssVar("--border") } },
        axisLabel: { color: cssVar("--axis-text"), fontSize: 10.5, hideOverlap: true },
        splitLine: { lineStyle: { color: cssVar("--grid-line") } },
      },
      yAxis: {
        type: "value",
        name: "Cumulative return (%)",
        nameLocation: "middle",
        nameGap: 44,
        scale: true,
        nameTextStyle: { color: cssVar("--axis-text"), fontSize: 11 },
        axisLabel: { color: cssVar("--axis-text"), fontSize: 10.5, formatter: (v) => `${v}%` },
        splitLine: { lineStyle: { color: cssVar("--grid-line") } },
      },
      dataZoom: dataZoomConfig({ mode: "value", startValue: win.from, endValue: win.to }),
    };
  };

  let currentOption = buildOption();
  chart.setOption(currentOption);
  rec.refresh = () => {
    currentOption = buildOption();
    chart.setOption(currentOption, { notMerge: true });
  };

  // a preset windows the near end of the forecast: "1Y" is the first twelve
  // months of the projection, clamped to the horizon the model actually has
  rec.applyPreset = (preset) => {
    const months = Math.max(1, preset.months || 12);
    const end = Math.min(tMax, new Date(new Date(tMin).setUTCMonth(new Date(tMin).getUTCMonth() + months)).getTime());
    win.from = tMin;
    win.to = end > tMin ? end : tMax;
    for (const dataZoomIndex of [0, 1]) {
      chart.dispatchAction({ type: "dataZoom", dataZoomIndex, startValue: win.from, endValue: win.to });
    }
  };

  /** months of forecast available — lets the page hide presets that overrun */
  rec.horizonMonths = Math.max(
    1,
    Math.round((tMax - tMin) / (1000 * 60 * 60 * 24 * 30.44))
  );

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

export { VOL_VIEWS, HOLD_VIEWS };
