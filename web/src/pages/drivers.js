/**
 * Drivers page: what the fitted model found, and what is moving what.
 *
 * The model is a vector autoregression, not a neural network — every number
 * on this page traces to an estimated coefficient. The centrepiece is the
 * forecast-error variance decomposition: for each series, the share of what
 * the model cannot predict about it that traces back to shocks in each other
 * series. That is the driving metric.
 */
import { loadDrivers } from "../store.js";
import * as echarts from "echarts";
import { cssVar, onThemeChange } from "../theme.js";

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const pc = (v) => (v == null ? "—" : `${Number(v).toFixed(1)}%`);

function seg(container, options, { onChange, active } = {}) {
  container.classList.add("pc-seg");
  container.innerHTML = "";
  for (const o of options) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = o.label;
    if (o.value === active) b.classList.add("active");
    b.addEventListener("click", () => {
      container.querySelectorAll("button").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      onChange(o.value);
    });
    container.appendChild(b);
  }
}

/** FEVD matrix as a heatmap: rows are responders, columns are shock sources */
function buildHeatmap(el, panel) {
  const chart = echarts.init(el);
  const ids = panel.series.map((s) => s.id);
  const data = [];
  panel.series.forEach((s, i) => {
    s.shares.forEach((sh, j) => {
      data.push([j, i, sh.share == null ? "-" : sh.share]);
    });
  });
  chart.setOption({
    animation: false,
    backgroundColor: "transparent",
    grid: { left: 92, right: 20, top: 46, bottom: 64 },
    tooltip: {
      backgroundColor: cssVar("--bg-card"),
      borderColor: cssVar("--border"),
      textStyle: { color: cssVar("--text-main"), fontSize: 12 },
      formatter: (p) =>
        `<b>${esc(ids[p.value[1]])}</b> — ${p.value[2]}% of its forecast error<br>` +
        `traces to shocks in <b>${esc(ids[p.value[0]])}</b>`,
    },
    xAxis: {
      type: "category", data: ids, name: "shock in", nameLocation: "middle", nameGap: 34,
      nameTextStyle: { color: cssVar("--axis-text"), fontSize: 11 },
      axisLabel: { color: cssVar("--axis-text"), fontSize: 10.5, rotate: ids.length > 8 ? 40 : 0 },
      splitArea: { show: true },
    },
    yAxis: {
      type: "category", data: ids, name: "variance of", nameLocation: "middle", nameGap: 74,
      nameTextStyle: { color: cssVar("--axis-text"), fontSize: 11 },
      axisLabel: { color: cssVar("--axis-text"), fontSize: 10.5 },
      splitArea: { show: true },
    },
    visualMap: {
      min: 0, max: 100, calculable: true, orient: "horizontal", left: "center", bottom: 6,
      textStyle: { color: cssVar("--axis-text"), fontSize: 10 },
      inRange: { color: [cssVar("--bg-sunken"), "#93c5fd", "#2563eb", "#1e3a8a"] },
    },
    series: [{
      type: "heatmap", data,
      label: { show: ids.length <= 8, fontSize: 10, formatter: (p) => (p.value[2] >= 1 ? p.value[2].toFixed(0) : "") },
      itemStyle: { borderColor: cssVar("--bg-card"), borderWidth: 1 },
    }],
  });
  const onResize = () => chart.resize();
  window.addEventListener("resize", onResize);
  const off = onThemeChange(() => buildHeatmap(el, panel));
  return { dispose() { window.removeEventListener("resize", onResize); off(); chart.dispose(); } };
}

export async function render(root) {
  const payload = await loadDrivers();
  const panels = (payload?.panels || []).filter((p) => p.status === "OK");

  root.innerHTML = `
  <div class="pc-hero">
    <h1>Model drivers</h1>
    <p>A vector autoregression is fitted to each panel — every series regressed on the recent history of every series including itself. The driving metric is the forecast-error variance decomposition: of everything the model cannot predict about a series, the share that traces back to shocks in each of the others. <b>No neural network is involved</b>; every number here comes from an estimated coefficient.</p>
  </div>
  <div class="pc-card pc-card-pad">
    <div class="pc-controls"><div id="panel-seg"></div></div>
    <div id="body" style="margin-top:16px"></div>
  </div>`;

  if (!panels.length) {
    root.querySelector("#body").innerHTML = `<div class="pc-empty">${esc(payload?.panels?.[0]?.why || "No panel could be fitted right now.")}</div>`;
    return { dispose() {} };
  }

  let active = panels[0].id;
  let heat = null;
  const body = root.querySelector("#body");

  function draw() {
    if (heat) { heat.dispose(); heat = null; }
    const p = panels.find((x) => x.id === active);
    const m = p.model;
    const top = p.mostInfluential[0];

    body.innerHTML = `
      <div class="pc-kpis" style="margin-bottom:20px">
        <div class="pc-kpi-cell"><div class="pc-kpi">
          <div class="pc-kpi-label">Model</div>
          <div class="pc-kpi-value">VAR(${m.lag})</div>
          <div class="pc-kpi-extra">${m.variables} series · ${m.observations} observations · ${esc(m.frequency === "months" ? "monthly" : "daily")}</div></div></div>
        <div class="pc-kpi-cell"><div class="pc-kpi">
          <div class="pc-kpi-label">Drives the panel</div>
          <div class="pc-kpi-value" style="color:var(--accent)">${esc(top ? top.id : "—")}</div>
          <div class="pc-kpi-extra">${top ? pc(top.share) : ""} of the others' forecast error, on average</div></div></div>
        <div class="pc-kpi-cell"><div class="pc-kpi">
          <div class="pc-kpi-label">Spectral radius</div>
          <div class="pc-kpi-value" style="color:${m.stable ? "var(--green)" : "var(--red)"}">${m.spectralRadius}</div>
          <div class="pc-kpi-extra">${m.stable ? "below 1 — shocks decay" : "at or above 1 — shocks do not decay"}</div></div></div>
        <div class="pc-kpi-cell"><div class="pc-kpi">
          <div class="pc-kpi-label">Decomposed over</div>
          <div class="pc-kpi-value">${p.fevdSteps}</div>
          <div class="pc-kpi-extra">${esc(m.frequency === "months" ? "months" : "business days")} ahead</div></div></div>
        <div class="pc-kpi-cell"><div class="pc-kpi">
          <div class="pc-kpi-label">Information criteria</div>
          <div class="pc-kpi-value">${m.aic}</div>
          <div class="pc-kpi-extra">AIC · BIC ${m.bic}</div></div></div>
      </div>

      <div class="grid-12">
        <div class="col-7">
          <div class="pc-card-title">Where each series' uncertainty comes from</div>
          <div class="pc-card-sub">Row = the series being explained, column = the shock. Values are per cent of forecast-error variance.</div>
          <div id="heat" style="height:420px;margin-top:8px"></div>
        </div>
        <div class="col-5">
          <div class="pc-card-title">Driving metric by series</div>
          <div class="pc-card-sub">Own share is how self-driven a series is; the driver is the largest external source.</div>
          <table class="pc-table" style="margin-top:8px">
            <thead><tr><th>Series</th><th class="num">Own</th><th>Driven by</th><th class="num">Share</th><th class="num">R²</th></tr></thead>
            <tbody>
              ${p.series.map((s) => `<tr>
                <td><b>${esc(s.id)}</b><div style="font-size:11px;color:var(--text-faint)">${esc(s.label)}</div></td>
                <td class="num">${pc(s.ownShare)}</td>
                <td>${s.driver ? esc(s.driver.id) : "—"}${s.driverPeak ? `<div style="font-size:11px;color:var(--text-faint)">peak at +${s.driverPeak.step}</div>` : ""}</td>
                <td class="num"><b>${s.driver ? pc(s.driver.share) : "—"}</b></td>
                <td class="num">${pc(s.r2)}</td>
              </tr>`).join("")}
            </tbody>
          </table>
        </div>
      </div>

      <div class="pc-note" style="margin-top:16px">
        ${esc(m.note)}<br>
        <b>Ordering:</b> ${p.ordering.join(" → ")}. ${esc(p.orderingNote)}<br>
        ${(payload.method || []).map(esc).join("<br>")}
      </div>`;

    heat = buildHeatmap(body.querySelector("#heat"), p);
  }

  seg(root.querySelector("#panel-seg"), panels.map((p) => ({ value: p.id, label: p.label })), {
    active,
    onChange: (v) => { active = v; draw(); },
  });
  draw();

  return { dispose() { if (heat) heat.dispose(); } };
}
