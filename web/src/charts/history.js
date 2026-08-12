/**
 * Real-history chart: 15y+ actual series (no extrapolation). Multi-series
 * lines with the same custom full-name legend, period buttons and
 * wheel/pinch zoom as every other chart. Time x-axis.
 */
import * as echarts from "echarts";
import { dataZoomConfig } from "../controls.js";
import { registerChart } from "../store.js";

export const PALETTE = [
  "#12b76a", "#4e5ba6", "#f79009", "#0ea5e9", "#f04438", "#9d4edd",
  "#0f766e", "#c026d3", "#64748b", "#b45309", "#2563eb", "#7c3aed",
];

export function buildHistoryChart(el, { series, id = "history", initialHidden = new Set() } = {}) {
  const chart = echarts.init(el);
  const names = Object.keys(series);
  const rec = registerChart(id, {
    chart,
    el,
    seriesIds: names,
    visible: new Set(names.filter((n) => !initialHidden.has(n))),
    refresh: null,
  });

  const buildOption = () => {
    const rows = [];
    for (let ni = 0; ni < names.length; ni++) {
      const name = names[ni];
      const s = series[name];
      const show = rec.visible.has(name);
      const pts = (s.points || []).map(([d, v]) => [Date.parse(d + "T00:00:00Z"), v]);
      rows.push({
        id: name,
        type: "line",
        name: s.standsFor || name,
        data: pts,
        showSymbol: false,
        lineStyle: { width: 1.6, color: PALETTE[ni % PALETTE.length] },
        itemStyle: { color: PALETTE[ni % PALETTE.length] },
        emphasis: { focus: "series" },
        hidden: !show,
      });
    }
    const first = series[names[0]];
    const isBps = first?.unit === "bps";
    return {
      animation: false,
      grid: { left: 64, right: 24, top: 30, bottom: 48 },
      tooltip: {
        trigger: "axis",
        formatter: (params) => {
          if (!params.length) return "";
          const d = new Date(params[0].value[0]).toISOString().slice(0, 10);
          const rows = params
            .map((p) => `<tr><td style="color:${p.color}">${esc(p.seriesName)}</td><td style="text-align:right;font-variant-numeric:tabular-nums">${Number(p.value[1]).toFixed(2)}</td></tr>`)
            .join("");
          return `<div style="font-weight:600;margin-bottom:4px">${d}</div><table style="border-collapse:collapse;font-size:12px">${rows}</table>`;
        },
      },
      xAxis: {
        type: "time",
        axisLabel: { formatter: (v) => new Date(v).toISOString().slice(0, 4) },
        splitLine: { show: false },
      },
      yAxis: {
        type: "value",
        name: first?.unit === "bps" ? "bps" : "%",
        splitLine: { lineStyle: { color: "#eef0f3" } },
      },
      dataZoom: dataZoomConfig({ total: 180, unit: "months" }),
    };
  };

  let option = buildOption();
  chart.setOption(option);
  rec.refresh = () => {
    option = buildOption();
    chart.setOption(option, { notMerge: true });
  };
  rec.applyPreset = (months) => {
    const all = rec.chart.getModel().getOption();
    const x = all.xAxis[0];
    // window in time-value coordinates: last `months` before the data end
    const pts = (series[names[0]]?.points || []).map(([d]) => Date.parse(d + "T00:00:00Z"));
    if (!pts.length) return;
    const end = Math.max(...pts);
    const start = end - months * 30.44 * 86400000;
    rec.chart.dispatchAction({ type: "dataZoom", startValue: start, endValue: end });
  };

  const onResize = () => chart.resize();
  window.addEventListener("resize", onResize);
  rec.dispose = () => {
    window.removeEventListener("resize", onResize);
    chart.dispose();
  };
  return rec;
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}