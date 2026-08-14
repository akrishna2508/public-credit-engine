/**
 * Forecast page — hosts what used to exist only as local PNGs: the VAR
 * projections of the adjacent-grade spread-minus-expected-loss series, and
 * the impulse-response contagion matrix in both shock units.
 */
import { loadForecast, setSeriesVisible } from "../store.js";
import { buildVarChart, buildIrfMatrix, PALETTE } from "../charts/forecast.js";
import { buildLegend } from "../legend.js";

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const bps = (v, d = 1) => (v == null ? "—" : `${Number(v).toFixed(d)} bps`);

export async function render(root) {
  root.innerHTML = `<div class="pc-spinner-wrap"><div class="pc-spinner"></div>
    <div>Estimating the VAR and impulse responses from live FRED spreads…</div></div>`;

  const f = await loadForecast();
  if (!f || f.status !== "OK") {
    root.innerHTML = `<div class="pc-empty">
      <div style="font-weight:620;color:var(--text-main);margin-bottom:6px">Forecast unavailable</div>
      ${esc(f?.why || "The forecast endpoint did not return a model.")}</div>`;
    return { dispose() {} };
  }

  const cols = f.cols || [];
  const last = (name) => {
    const h = f.history?.series?.[name];
    return h?.length ? h[h.length - 1] : null;
  };
  const projEnd = (name) => {
    const p = Object.values(f.projections?.[name] || {});
    return p.length ? p[p.length - 1] : null;
  };

  root.innerHTML = `
  <div class="pc-hero">
    <h1>VAR forecast &amp; contagion</h1>
    <p>Adjacent credit-grade spreads net of their expected-loss difference, projected ${f.horizon} business days ahead by a vector autoregression, plus the full impulse-response matrix showing how a shock to one rung of the ladder propagates to the others.</p>
  </div>

  <div class="pc-kpis" style="margin-bottom:20px">
    <div class="pc-kpi-cell"><div class="pc-kpi">
      <div class="pc-kpi-label">Model</div>
      <div class="pc-kpi-value">VAR(${f.lagOrder})</div>
      <div class="pc-kpi-extra">lag order chosen by AIC</div></div></div>
    <div class="pc-kpi-cell"><div class="pc-kpi">
      <div class="pc-kpi-label">Observations</div>
      <div class="pc-kpi-value">${f.nobs}</div>
      <div class="pc-kpi-extra">${esc(f.panel?.start || "")} → ${esc(f.panel?.end || "")}</div></div></div>
    <div class="pc-kpi-cell"><div class="pc-kpi">
      <div class="pc-kpi-label">Series modelled</div>
      <div class="pc-kpi-value">${cols.length}</div>
      <div class="pc-kpi-extra">adjacent-grade pairs</div></div></div>
    <div class="pc-kpi-cell"><div class="pc-kpi">
      <div class="pc-kpi-label">Horizon</div>
      <div class="pc-kpi-value">${f.horizon}d</div>
      <div class="pc-kpi-extra">business days ahead</div></div></div>
    <div class="pc-kpi-cell"><div class="pc-kpi">
      <div class="pc-kpi-label">Model AIC</div>
      <div class="pc-kpi-value">${f.aic == null ? "—" : Number(f.aic).toFixed(3)}</div>
      <div class="pc-kpi-extra">BIC ${f.bic == null ? "—" : Number(f.bic).toFixed(3)}</div></div></div>
  </div>

  <div class="grid-12">
    <div class="col-8">
      <div class="pc-card pc-card-pad">
        <div class="pc-card-head">
          <div>
            <div class="pc-card-title">Spread minus expected loss — observed and projected</div>
            <div class="pc-card-sub">Solid is observed; dashed is the VAR projection past the last observation.</div>
          </div>
          <div class="pc-seg" id="hist-window">
            <button data-w="45">45d</button><button data-w="90" class="active">90d</button><button data-w="120">120d</button>
          </div>
        </div>
        <div id="var-chart" style="height:430px"></div>
      </div>
    </div>
    <div class="col-4">
      <div class="pc-card pc-card-pad">
        <div class="pc-card-title">Pairs</div>
        <div class="pc-card-sub">Click a name to toggle that line</div>
        <div id="var-legend"></div>
      </div>
    </div>

    <div class="col-12">
      <div class="pc-card pc-card-pad">
        <div class="pc-card-title">Where each pair is projected to land</div>
        <div class="pc-card-sub">Last observed level against the end of the ${f.horizon}-day projection.</div>
        <div class="pc-table-wrap">
          <table class="pc-table">
            <thead><tr>
              <th>Pair</th><th>What it is</th>
              <th class="num">Expected-loss offset</th>
              <th class="num">Last observed</th>
              <th class="num">Projected (${f.horizon}d)</th>
              <th class="num">Change</th>
              <th class="num">Shock size (1σ)</th>
            </tr></thead>
            <tbody>${cols
              .map((c) => {
                const l = last(c);
                const p = projEnd(c);
                const d = l != null && p != null ? p - l : null;
                return `<tr>
                  <td><b>${esc(c)}</b></td>
                  <td style="color:var(--text-secondary);font-size:11.5px;max-width:420px">${esc(f.pairs?.[c]?.standsFor || "")}</td>
                  <td class="num">${bps(f.pairs?.[c]?.elDiffBps, 2)}</td>
                  <td class="num">${bps(l)}</td>
                  <td class="num">${bps(p)}</td>
                  <td class="num" style="color:${d == null ? "var(--text-faint)" : d > 0 ? "var(--red)" : "var(--green)"}">${d == null ? "—" : `${d > 0 ? "+" : ""}${d.toFixed(1)} bps`}</td>
                  <td class="num">${bps(f.shockSizes?.[c], 2)}</td>
                </tr>`;
              })
              .join("")}</tbody>
          </table>
        </div>
        <div class="pc-note">A <b>widening</b> projected spread (positive change, shown red) means the market is expected to demand more compensation for that rung of the credit ladder; a tightening spread is a mark-to-market gain for anyone already holding it. The expected-loss offset is what has already been subtracted for the difference in modelled credit losses between the two grades, so what remains is compensation beyond expected loss.</div>
      </div>
    </div>

    <div class="col-12">
      <div class="pc-card pc-card-pad">
        <div class="pc-card-head">
          <div>
            <div class="pc-card-title">Contagion matrix — impulse responses</div>
            <div class="pc-card-sub">Each cell: how the row's spread responds over ${f.horizon} days to a shock in the column's spread.</div>
          </div>
          <div class="pc-seg" id="irf-unit">
            <button data-u="1bps" class="active">1 bps shock</button>
            <button data-u="stddev">1 std-dev shock</button>
          </div>
        </div>
        <div id="irf-matrix"></div>
        <div class="pc-note" id="irf-note"></div>
      </div>
    </div>

    <div class="col-12">
      <div class="pc-card pc-card-pad">
        <div class="pc-card-title">Method</div>
        <div class="pc-card-sub">Everything on this page is recomputed live from FRED on each request.</div>
        <div class="pc-note" style="border-left-color:var(--accent)">
          <ul>${(f.methodology || []).map((m) => `<li>${esc(m)}</li>`).join("")}</ul>
          <div style="margin-top:8px"><b>Cointegration:</b> ${esc(f.cointegration || "")}</div>
        </div>
        <div class="pc-table-wrap" style="margin-top:14px">
          <table class="pc-table">
            <thead><tr><th>Grade</th><th class="num">Default-rate proxy</th><th class="num">LGD</th><th class="num">Expected loss</th></tr></thead>
            <tbody>${Object.entries(f.expectedLoss?.byGrade || {})
              .map(
                ([g, el]) => `<tr><td><b>${esc(g)}</b></td>
                  <td class="num">${(() => {
                    const p = ["AAA", "AA", "A", "BBB"].includes(g) ? f.expectedLoss?.defaultRateProxies?.IG_proxy : f.expectedLoss?.defaultRateProxies?.HY_proxy;
                    return p?.rate == null ? "—" : `${(p.rate * 100).toFixed(3)}%`;
                  })()}</td>
                  <td class="num">${f.expectedLoss?.lgd?.[g] == null ? "—" : `${(f.expectedLoss.lgd[g] * 100).toFixed(1)}%`}</td>
                  <td class="num">${el == null ? "—" : `${(el * 100).toFixed(4)}%`}</td></tr>`
              )
              .join("")}</tbody>
          </table>
        </div>
        <div class="pc-note">${esc(f.expectedLoss?.note || "")}</div>
      </div>
    </div>
  </div>`;

  /* ---------------- VAR chart ---------------- */
  const hidden = new Set();
  let histWindow = 90;
  let varRec = null;
  const chartEl = root.querySelector("#var-chart");

  function rebuildVar() {
    varRec?.dispose();
    varRec = buildVarChart(chartEl, f, { id: "var-forecast", initialHidden: hidden, histWindow });
  }
  rebuildVar();

  buildLegend(
    root.querySelector("#var-legend"),
    cols.map((c, i) => ({
      id: c,
      name: c,
      standsFor: f.pairs?.[c]?.standsFor,
      color: PALETTE[i % PALETTE.length],
    })),
    {
      onToggle: (id, on) => {
        if (on) hidden.delete(id);
        else hidden.add(id);
        setSeriesVisible("var-forecast", id, on);
      },
    }
  );

  root.querySelector("#hist-window").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    root.querySelectorAll("#hist-window button").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    histWindow = Number(b.dataset.w);
    rebuildVar();
  });

  /* ---------------- IRF matrix ---------------- */
  const matrixEl = root.querySelector("#irf-matrix");
  const irfNote = root.querySelector("#irf-note");
  let irfRec = null;
  let unit = "1bps";

  function drawIrf() {
    irfRec?.dispose();
    const m = unit === "1bps" ? f.irf1bps : f.irfStdDev;
    if (!m) {
      matrixEl.innerHTML = `<div class="pc-empty">The orthogonalized responses need a positive-definite residual covariance; it was not available for this fit.</div>`;
      return;
    }
    irfRec = buildIrfMatrix(matrixEl, m, cols, { unitLabel: "bps" });
    irfNote.innerHTML =
      unit === "1bps"
        ? `Response in basis points to a <b>1 basis-point</b> shock in the column's spread — the raw moving-average coefficients, so the diagonal starts at exactly 1.0 and the off-diagonals start at 0. Each row shares one vertical scale, so you can compare which shock moves that row hardest.`
        : `Response in basis points to a <b>one standard-deviation</b> shock, orthogonalized by a Cholesky factorisation of the residual covariance. This accounts for the fact that the pairs move together: the ordering runs from the highest-grade pair down, so the assumption is that higher-grade spreads move first. Shock sizes: ${cols
            .map((c) => `${esc(c)} ${f.shockSizes?.[c] ?? "—"} bps`)
            .join(" · ")}.`;
  }
  drawIrf();

  root.querySelector("#irf-unit").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    root.querySelectorAll("#irf-unit button").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    unit = b.dataset.u;
    drawIrf();
  });

  return {
    dispose() {
      varRec?.dispose();
      irfRec?.dispose();
    },
  };
}
