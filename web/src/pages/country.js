/**
 * Country drill-down: instrument table + two mini charts — real 10Y history
 * and the 1M-15Y projected return curve (country legs, monthly units).
 */
import { loadAtlas, loadHistory, loadReturns, setSeriesVisible } from "../store.js";
import { buildHistoryChart } from "../charts/history.js";
import { buildProjectionChart, PALETTE } from "../charts/projection.js";
import { buildLegend } from "../legend.js";
import { buildPeriodBar } from "../controls.js";

const fmt = (v, d = 2) => (v == null ? "—" : Number(v).toFixed(d));
const bps = (v) => (v == null ? "—" : `${Number(v).toFixed(0)} bps`);

export async function render(root, { iso }) {
  const atlas = await loadAtlas();
  const c = atlas?.countries?.[iso];
  if (!c) {
    root.innerHTML = `<div class="pc-empty">Country "${iso}" is not in this atlas.</div>`;
    return { dispose() {} };
  }
  const b = c.instruments?.bonds || {};
  const e = c.instruments?.equity_etf || {};
  const cds = c.instruments?.cds || {};

  root.innerHTML = `
  <a href="#/map" class="pc-tag" style="margin-bottom:16px;display:inline-block">← Back to map</a>
  <div class="grid-12">
    <div class="col-8">
      <div class="pc-card pc-card-pad">
        <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:14px">
          <h1 style="font-size:22px;margin:0;font-weight:700;letter-spacing:-0.02em">${c.name}</h1>
          <span class="pc-tag">${c.region}</span>
          <span class="pc-badge ${(c.heat ?? 0) > 0.25 ? "heat-pos" : (c.heat ?? 0) < -0.25 ? "heat-neg" : "heat-zero"}">heat ${c.heat == null ? "n/a" : (c.heat > 0 ? "+" : "") + fmt(c.heat, 3)}</span>
        </div>
        <table class="pc-table">
          <tbody>
            <tr><td>10Y yield (latest)</td><td class="tabular"><b>${fmt(b.yield_pct)}%</b></td>
                <td>10Y yield Z (126m)</td><td class="tabular">${fmt(b.yield_z)}</td></tr>
            <tr><td>Δ yield 1M / 3M / 12M</td><td class="tabular">${bps(b.yield_chg_bps?.["1"])} / ${bps(b.yield_chg_bps?.["3"])} / ${bps(b.yield_chg_bps?.["12"])}</td>
                <td>1M bond price proxy</td><td class="tabular">${fmt(b.bond_price_1m_pct)}%</td></tr>
            <tr><td>vs US 10Y (CDS proxy)</td><td class="tabular">${bps(cds.sovereign_spread_bps)}</td>
                <td>CDS leg</td><td>${cds.status || "—"}</td></tr>
            <tr><td>Equity ETF (${e.label || "—"})</td><td class="tabular">1M ${fmt(e.ret_1m_pct)}%</td>
                <td>3M / 12M</td><td class="tabular">${fmt(e.ret_3m_pct)}% / ${fmt(e.ret_12m_pct)}%</td></tr>
          </tbody>
        </table>
        <div class="pc-note" style="margin-top:14px">${b.notes || "10Y OECD long-term rate (FRED)".replace(/\.$/, "")} ${
    cds.note || "No direct sovereign CDS data — the spread column is the 10Y yield difference vs the US."}</div>
      </div>
    </div>
    <div class="col-4">
      <div class="pc-card pc-card-pad">
        <div class="pc-card-title">Opportunity heat</div>
        <div class="pc-kpi" style="margin-top:10px">
          <div class="pc-kpi-value" style="color:${(c.heat ?? 0) >= 0 ? "var(--green)" : "var(--red)"}">${c.heat == null ? "n/a" : (c.heat > 0 ? "+" : "") + fmt(c.heat, 3)}</div>
          <div class="pc-kpi-label">Mean of 1-month price-return proxies (bond duration proxy + equity ETF)</div>
        </div>
      </div>
    </div>

    <div class="col-12">
      <div class="pc-card pc-card-pad">
        <div class="pc-card-title">Projected return curve — ${c.name} 10Y</div>
        <div class="pc-card-sub">Extrapolated from the live hold-horizon curves (monthly country panel, ECB LTIR) — not a forecast</div>
        <div class="pc-controls" style="margin-bottom:12px"><div id="proj-periods"></div></div>
        <div class="grid-12">
          <div class="col-8"><div id="proj-chart" style="height:400px"></div></div>
          <div class="col-4"><div id="proj-legend"></div></div>
        </div>
      </div>
    </div>

    <div class="col-12">
      <div class="pc-card pc-card-pad">
        <div class="pc-card-title">10-year yield — actual history</div>
        <div class="pc-card-sub">Real monthly observations (no extrapolation)</div>
        <div class="pc-controls" style="margin-bottom:12px"><div id="hist-periods"></div></div>
        <div class="grid-12">
          <div class="col-8"><div id="hist-chart" style="height:400px"></div></div>
          <div class="col-4"><div id="hist-legend"></div></div>
        </div>
      </div>
    </div>
  </div>`;

  /* ······ projected curve ······ */
  const projEl = root.querySelector("#proj-chart");
  const projLegendEl = root.querySelector("#proj-legend");
  const recs = [];
  const ret = await loadReturns("countries", "pure");
  const asset = (ret?.markets?.countries?.pure || []).find((a) => a.id === iso);
  if (asset && !asset.unavailable) {
    const rec = buildProjectionChart(projEl, [asset], { id: "country-proj", view: "ret" });
    recs.push(rec);
    buildLegend(projLegendEl, [{ id: asset.id, name: asset.name, standsFor: asset.standsFor, color: PALETTE[0] }], {
      onToggle: (id, on) => setSeriesVisible("country-proj", id, on),
    });
    buildPeriodBar(root.querySelector("#proj-periods"), {
      onSelect: (preset) => rec.applyPreset(preset),
    });
  } else {
    projEl.innerHTML = `<div class="pc-empty">No projected curve for ${iso} — the ECB LTIR country panel covers euro-area members.</div>`;
  }

  /* ······ real history ······ */
  const histEl = root.querySelector("#hist-chart");
  const histLegendEl = root.querySelector("#hist-legend");
  const hist = await loadHistory({ country: iso });
  if (hist?.series) {
    const rec = buildHistoryChart(histEl, {
      series: { [iso]: { standsFor: `${hist.name} 10Y — ${hist.source}`, points: hist.series, unit: "pct" } },
      id: "country-hist",
    });
    recs.push(rec);
    buildLegend(histLegendEl, [{ id: iso, name: `${hist.name} 10Y`, standsFor: `${hist.source} · ${hist.start} → ${hist.end}`, color: PALETTE[0] }], {
      onToggle: (id, on) => setSeriesVisible("country-hist", id, on),
    });
    buildPeriodBar(root.querySelector("#hist-periods"), {
      onSelect: (preset) => rec.applyPreset(preset.months),
    });
  } else {
    histEl.innerHTML = `<div class="pc-empty">${hist?.why || "No history for this country."}</div>`;
  }

  return {
    dispose() {
      recs.forEach((r) => r.dispose());
    },
  };
}