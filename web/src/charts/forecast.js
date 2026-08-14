/**
 * Forecast visuals.
 *
 *  buildVarChart  — observed spread-minus-EL history with the VAR projection
 *                   continuing past the last observation, one line per
 *                   adjacent-grade pair, split by a "today" marker.
 *  buildIrfMatrix — the K x K impulse-response contagion grid: each cell is
 *                   the response of one pair to a shock in another, drawn as a
 *                   zero-baselined area sparkline on a shared y-scale per row.
 */
import * as echarts from "echarts";
import { cssVar, onThemeChange } from "../theme.js";
import { registerChart, unregisterChart } from "../store.js";

export const PALETTE = [
  "#2563eb", "#0f9d58", "#d98613", "#d92d20", "#7c3aed",
  "#0891b2", "#be185d", "#65a30d", "#ea580c", "#4f46e5",
];

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/* ===================================================================== */
/* VAR projection chart                                                   */
/* ===================================================================== */
export function buildVarChart(el, payload, { id = "var-forecast", initialHidden = new Set(), histWindow = 90 } = {}) {
  const cols = payload.cols || [];
  const chart = echarts.init(el, null, { renderer: "canvas" });

  const rec = registerChart(id, {
    chart,
    el,
    seriesIds: cols,
    visible: new Set(cols.filter((c) => !initialHidden.has(c))),
    refresh: null,
  });

  const histDates = payload.history?.dates || [];
  const useHist = histDates.slice(-histWindow);
  const cutIdx = useHist.length - 1;
  const allDates = [...useHist, ...(payload.futureDates || [])];

  const buildOption = () => {
    const series = [];
    cols.forEach((c, i) => {
      if (!rec.visible.has(c)) return;
      const color = PALETTE[i % PALETTE.length];
      const hist = (payload.history?.series?.[c] || []).slice(-histWindow);
      const proj = Object.values(payload.projections?.[c] || {});

      series.push({
        id: `${c}::hist`,
        name: c,
        type: "line",
        data: [...hist, ...new Array(proj.length).fill(null)],
        showSymbol: false,
        lineStyle: { width: 1.9, color },
        itemStyle: { color },
        emphasis: { focus: "series" },
        z: 3,
      });
      series.push({
        id: `${c}::proj`,
        name: `${c} (VAR)`,
        type: "line",
        // repeat the last observed point so the projection joins the history
        data: [...new Array(cutIdx).fill(null), hist[hist.length - 1], ...proj],
        showSymbol: false,
        lineStyle: { width: 1.9, color, type: "dashed" },
        itemStyle: { color },
        emphasis: { focus: "series" },
        z: 4,
      });
    });

    return {
      animation: false,
      backgroundColor: "transparent",
      grid: { left: 62, right: 22, top: 26, bottom: 54 },
      tooltip: {
        trigger: "axis",
        backgroundColor: cssVar("--bg-card"),
        borderColor: cssVar("--border"),
        textStyle: { color: cssVar("--text-main"), fontSize: 12 },
        extraCssText: "box-shadow:0 8px 28px -10px rgba(0,0,0,.4);border-radius:10px;",
        formatter: (params) => {
          const pts = params.filter((p) => p.value != null);
          if (!pts.length) return "";
          const d = pts[0].axisValue;
          const future = (payload.futureDates || []).includes(d);
          const rows = pts
            .map(
              (p) => `<tr><td style="color:${p.color};padding-right:12px">${esc(p.seriesName)}</td>
                 <td style="text-align:right;font-variant-numeric:tabular-nums">${Number(p.value).toFixed(1)} bps</td></tr>`
            )
            .join("");
          return `<div style="font-weight:640;margin-bottom:4px">${esc(d)}${future ? ` <span style="color:${cssVar("--amber")};font-size:11px">· VAR projection</span>` : ""}</div>
                  <table style="border-collapse:collapse;font-size:11.5px">${rows}</table>`;
        },
      },
      xAxis: {
        type: "category",
        data: allDates,
        boundaryGap: false,
        axisLine: { lineStyle: { color: cssVar("--border") } },
        axisLabel: { color: cssVar("--axis-text"), fontSize: 10.5, hideOverlap: true },
        splitLine: { show: false },
      },
      yAxis: {
        type: "value",
        name: "Spread − expected loss (bps)",
        nameLocation: "middle",
        nameGap: 46,
        nameTextStyle: { color: cssVar("--axis-text"), fontSize: 11 },
        axisLabel: { color: cssVar("--axis-text"), fontSize: 10.5 },
        splitLine: { lineStyle: { color: cssVar("--grid-line") } },
      },
      series: [
        ...series,
        {
          type: "line",
          data: [],
          markLine: {
            silent: true,
            symbol: "none",
            label: {
              formatter: "last observation",
              position: "insideEndTop",
              color: cssVar("--text-faint"),
              fontSize: 10,
            },
            lineStyle: { color: cssVar("--border-strong"), type: "dashed", width: 1 },
            data: [{ xAxis: cutIdx }],
          },
        },
      ],
      dataZoom: [
        { type: "inside", xAxisIndex: 0, zoomOnMouseWheel: true, moveOnMouseMove: true },
        {
          type: "slider", xAxisIndex: 0, height: 16, bottom: 8,
          borderColor: cssVar("--border"), backgroundColor: cssVar("--bg-sunken"),
          fillerColor: "rgba(31,94,255,.10)", handleStyle: { color: cssVar("--accent") },
          textStyle: { color: cssVar("--axis-text"), fontSize: 10 },
        },
      ],
    };
  };

  chart.setOption(buildOption());
  rec.refresh = () => chart.setOption(buildOption(), { notMerge: true });

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

/* ===================================================================== */
/* IRF contagion matrix                                                   */
/* ===================================================================== */

/**
 * @param matrix  { "Shock_to_X": { "Response_of_Y": { date: value } } }
 * @param cols    ordered series names
 */
export function buildIrfMatrix(container, matrix, cols, { unitLabel = "bps" } = {}) {
  container.innerHTML = "";
  const n = cols.length;
  const grid = document.createElement("div");
  grid.className = "pc-irf-grid";
  grid.style.gridTemplateColumns = `minmax(74px, 0.7fr) repeat(${n}, minmax(0, 1fr))`;
  container.appendChild(grid);

  const corner = document.createElement("div");
  corner.className = "pc-irf-corner pc-irf-axis";
  corner.innerHTML = `<span style="font-size:9.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-faint)">response ↓ / shock →</span>`;
  grid.appendChild(corner);
  for (const c of cols) {
    const h = document.createElement("div");
    h.className = "pc-irf-axis";
    h.textContent = c;
    grid.appendChild(h);
  }

  const charts = [];
  cols.forEach((resp) => {
    const rowLabel = document.createElement("div");
    rowLabel.className = "pc-irf-axis";
    rowLabel.textContent = resp;
    grid.appendChild(rowLabel);

    // one shared y-scale per response row so cross-shock magnitudes compare
    const rowVals = [];
    for (const shock of cols) {
      const tl = matrix?.[`Shock_to_${shock}`]?.[`Response_of_${resp}`];
      if (tl) rowVals.push(...Object.values(tl).filter(Number.isFinite));
    }
    const bound = Math.max(1e-6, ...rowVals.map((v) => Math.abs(v)));

    cols.forEach((shock, si) => {
      const cell = document.createElement("div");
      cell.className = "pc-irf-cell";
      grid.appendChild(cell);
      const tl = matrix?.[`Shock_to_${shock}`]?.[`Response_of_${resp}`];
      if (!tl) {
        cell.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-faint);font-size:11px">—</div>`;
        return;
      }
      const dates = Object.keys(tl);
      const values = Object.values(tl);
      const color = PALETTE[si % PALETTE.length];
      const c = echarts.init(cell, null, { renderer: "canvas", height: 96 });
      const opt = () => ({
        animation: false,
        backgroundColor: "transparent",
        grid: { left: 4, right: 4, top: 10, bottom: 6, containLabel: false },
        tooltip: {
          trigger: "axis",
          backgroundColor: cssVar("--bg-card"),
          borderColor: cssVar("--border"),
          textStyle: { color: cssVar("--text-main"), fontSize: 11.5 },
          extraCssText: "border-radius:9px;",
          formatter: (p) =>
            `<div style="font-weight:620">${esc(p[0].axisValue)}</div>
             <div style="font-size:11px;color:${cssVar("--text-secondary")}">shock to <b style="color:${cssVar("--text-main")}">${esc(shock)}</b></div>
             <div style="font-size:11px;color:${cssVar("--text-secondary")}">response of <b style="color:${cssVar("--text-main")}">${esc(resp)}</b></div>
             <div style="font-variant-numeric:tabular-nums;font-weight:640;margin-top:2px">${Number(p[0].value).toFixed(4)} ${unitLabel}</div>`,
        },
        xAxis: { type: "category", data: dates, show: false, boundaryGap: false },
        yAxis: { type: "value", show: false, min: -bound, max: bound },
        series: [
          {
            type: "line",
            data: values,
            showSymbol: false,
            lineStyle: { width: 1.6, color },
            // fill to the ZERO line, not the axis floor: the sign of an
            // impulse response is the whole point, so a positive and a
            // negative response must not read as the same filled block
            areaStyle: { color, opacity: 0.18, origin: 0 },
            markLine: {
              silent: true,
              symbol: "none",
              lineStyle: { color: cssVar("--border-strong"), width: 1, type: "solid" },
              label: { show: false },
              data: [{ yAxis: 0 }],
            },
            z: 3,
          },
        ],
      });
      c.setOption(opt());
      charts.push({ c, opt });
    });
  });

  const onResize = () => charts.forEach(({ c }) => c.resize());
  window.addEventListener("resize", onResize);
  const offTheme = onThemeChange(() => charts.forEach(({ c, opt }) => c.setOption(opt(), { notMerge: true })));

  return {
    dispose() {
      window.removeEventListener("resize", onResize);
      offTheme();
      charts.forEach(({ c }) => c.dispose());
    },
  };
}
