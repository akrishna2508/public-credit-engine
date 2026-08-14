/**
 * Real-history chart: 15y+ actual series (no extrapolation). Multi-series
 * lines with the same custom full-name legend, period buttons and
 * wheel/pinch zoom as every other chart. Time x-axis.
 */
import * as echarts from "echarts";
import { dataZoomConfig } from "../controls.js";
import { registerChart } from "../store.js";
import { cssVar, onThemeChange } from "../theme.js";

export const PALETTE = [
  "#2563eb", "#0f9d58", "#d98613", "#d92d20", "#7c3aed",
  "#0891b2", "#be185d", "#65a30d", "#ea580c", "#4f46e5",
  "#0f766e", "#c026d3",
];

const unitOf = (s) => s?.unit || "pct";
const unitLabel = (u) => (u === "bps" ? "bps" : "%");

export function buildHistoryChart(el, { series, id = "history", initialHidden = new Set(), initialMonths = null } = {}) {
  const chart = echarts.init(el);
  const names = Object.keys(series);

  /**
   * Series can carry different units — the US panel plots grade spreads in
   * basis points alongside a default rate in percent. Forcing both onto one
   * axis pinned a ~3% default rate to the floor of a 0-1200 bps scale, which
   * read as a flat line at zero. A second axis on the right carries whatever
   * unit is not the majority, and those series are drawn dashed.
   */
  const primaryUnit = unitOf(series[names[0]]);
  const secondaryUnit = names.map((n) => unitOf(series[n])).find((u) => u !== primaryUnit) || null;
  const rec = registerChart(id, {
    chart,
    el,
    seriesIds: names,
    visible: new Set(names.filter((n) => !initialHidden.has(n))),
    refresh: null,
  });

  /** full time extent across every series, used to turn a preset into a % window */
  const extent = (() => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const n of names) {
      for (const [d] of series[n].points || []) {
        const t = Date.parse(d + "T00:00:00Z");
        if (!Number.isFinite(t)) continue;
        if (t < lo) lo = t;
        if (t > hi) hi = t;
      }
    }
    return Number.isFinite(lo) && Number.isFinite(hi) && hi > lo ? { lo, hi } : null;
  })();

  // the zoom window is state, so a theme repaint or a legend toggle rebuilds
  // the option without snapping the view back to "all history"
  const zoomWindow = { start: 0 };

  /** turn "show the last N months" into a % of the full time extent */
  const startPctFor = (months) => {
    if (!extent) return 0;
    const span = extent.hi - extent.lo;
    const wanted = months * 30.44 * 86400000;
    return wanted >= span ? 0 : Math.max(0, Math.min(99, ((span - wanted) / span) * 100));
  };
  if (initialMonths) zoomWindow.start = startPctFor(initialMonths);

  const buildOption = () => {
    const rows = [];
    for (let ni = 0; ni < names.length; ni++) {
      const name = names[ni];
      const s = series[name];
      // omit hidden series rather than flagging them: ECharts has no `hidden`
      // series property, so the old flag was ignored and the legend was inert
      if (!rec.visible.has(name)) continue;
      const pts = (s.points || []).map(([d, v]) => [Date.parse(d + "T00:00:00Z"), v]);
      const axis = unitOf(s) === secondaryUnit ? 1 : 0;
      rows.push({
        id: name,
        type: "line",
        name: s.standsFor || name,
        data: pts,
        yAxisIndex: axis,
        showSymbol: false,
        lineStyle: { width: 1.6, color: PALETTE[ni % PALETTE.length], type: axis === 1 ? "dashed" : "solid" },
        itemStyle: { color: PALETTE[ni % PALETTE.length] },
        emphasis: { focus: "series" },
      });
    }
    return {
      series: rows,
      animation: false,
      backgroundColor: "transparent",
      grid: { left: 64, right: 24, top: 30, bottom: 48 },
      tooltip: {
        trigger: "axis",
        backgroundColor: cssVar("--bg-card"),
        borderColor: cssVar("--border"),
        textStyle: { color: cssVar("--text-main"), fontSize: 12 },
        extraCssText: "box-shadow:0 8px 28px -10px rgba(0,0,0,.4);border-radius:10px;",
        formatter: (params) => {
          if (!params.length) return "";
          const d = new Date(params[0].value[0]).toISOString().slice(0, 10);
          const rows = params
            .map((p) => {
              const u = unitLabel(unitOf(series[p.seriesId]));
              return `<tr><td style="color:${p.color};padding-right:12px">${esc(p.seriesName)}</td><td style="text-align:right;font-variant-numeric:tabular-nums">${Number(p.value[1]).toFixed(2)} ${u}</td></tr>`;
            })
            .join("");
          return `<div style="font-weight:640;margin-bottom:4px">${d}</div><table style="border-collapse:collapse;font-size:11.5px">${rows}</table>`;
        },
      },
      xAxis: {
        type: "time",
        axisLine: { lineStyle: { color: cssVar("--border") } },
        axisLabel: { color: cssVar("--axis-text"), fontSize: 10.5, formatter: (v) => new Date(v).toISOString().slice(0, 4) },
        splitLine: { show: false },
      },
      yAxis: [
        {
          type: "value",
          name: unitLabel(primaryUnit),
          // fit the data instead of anchoring to zero: a 10Y yield that lives
          // between 6% and 13% was being drawn in the top half of a 0-14 axis
          scale: true,
          nameTextStyle: { color: cssVar("--axis-text"), fontSize: 11 },
          axisLabel: { color: cssVar("--axis-text"), fontSize: 10.5 },
          splitLine: { lineStyle: { color: cssVar("--grid-line") } },
        },
        ...(secondaryUnit
          ? [
              {
                type: "value",
                name: unitLabel(secondaryUnit),
                position: "right",
                scale: true,
                nameTextStyle: { color: cssVar("--axis-text"), fontSize: 11 },
                axisLabel: { color: cssVar("--axis-text"), fontSize: 10.5 },
                splitLine: { show: false },
              },
            ]
          : []),
      ],
      // percentage window: this is a TIME axis, so the numeric startValue /
      // endValue form would be read as epoch milliseconds
      dataZoom: dataZoomConfig({ mode: "percent", start: zoomWindow.start, end: 100 }),
    };
  };

  let option = buildOption();
  chart.setOption(option);
  rec.refresh = () => {
    option = buildOption();
    chart.setOption(option, { notMerge: true });
  };
  /** show the last `months` of history; expressed as a % of the full extent */
  rec.applyPreset = (months) => {
    if (!extent) return;
    zoomWindow.start = startPctFor(months);
    for (const dataZoomIndex of [0, 1]) {
      chart.dispatchAction({ type: "dataZoom", dataZoomIndex, start: zoomWindow.start, end: 100 });
    }
  };

  const onResize = () => chart.resize();
  window.addEventListener("resize", onResize);
  const offTheme = onThemeChange(() => rec.refresh());
  rec.dispose = () => {
    window.removeEventListener("resize", onResize);
    offTheme();
    chart.dispose();
  };
  return rec;
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}