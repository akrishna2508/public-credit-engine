/**
 * Country drill-down: the full per-leg breakdown behind that country's heat,
 * its structural context, and — where the data exists — the real 10Y history
 * and the projected return curve.
 */
import { loadAtlas, loadHistory, loadReturns, setSeriesVisible } from "../store.js";
import { buildHistoryChart } from "../charts/history.js";
import { buildProjectionChart, PALETTE } from "../charts/projection.js";
import { buildLegend } from "../legend.js";
import { buildPeriodBar } from "../controls.js";

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const fmt = (v, d = 2) => (v == null ? "—" : Number(v).toFixed(d));
const pct = (v, d = 2) => (v == null ? "—" : `${v > 0 ? "+" : ""}${Number(v).toFixed(d)}%`);
const bps = (v) => (v == null ? "—" : `${v > 0 ? "+" : ""}${Number(v).toFixed(0)} bps`);
const cls = (v) => (v == null ? "heat-zero" : v > 0.05 ? "heat-pos" : v < -0.05 ? "heat-neg" : "heat-zero");
const colored = (v, d = 2, suffix = "%") =>
  v == null
    ? `<span style="color:var(--text-faint)">—</span>`
    : `<span style="color:${v > 0 ? "var(--green)" : v < 0 ? "var(--red)" : "var(--text-secondary)"}">${v > 0 ? "+" : ""}${Number(v).toFixed(d)}${suffix}</span>`;

const LEG_LABEL = {
  bond: "Sovereign bond price (USD)",
  equity: "Country equity ETF",
  credit: "Regional EM corporate credit",
};

/** an UNAVAILABLE leg is shown with its reason, never hidden */
function legCard(title, ok, body, why) {
  return `<div class="pc-card pc-card-pad" style="height:100%">
    <div class="pc-card-head" style="margin-bottom:10px">
      <div class="pc-card-title" style="margin:0">${esc(title)}</div>
      <span class="pc-badge ${ok ? "accent" : "neutral"}">${ok ? "live" : "unavailable"}</span>
    </div>
    ${ok ? body : `<div style="font-size:12px;color:var(--text-secondary);line-height:1.55">${esc(why || "No free live source covers this leg for this market.")}</div>`}
  </div>`;
}

export async function render(root, { iso }) {
  const atlas = await loadAtlas();
  const c = atlas?.countries?.[iso];
  if (!c) {
    root.innerHTML = `<div class="pc-empty">Country "${esc(iso)}" is not in this atlas.
      <div style="margin-top:10px"><a href="#/map" class="pc-tag">← Back to the map</a></div></div>`;
    return { dispose() {} };
  }

  const b = c.instruments?.bonds || {};
  const e = c.instruments?.equity_etf || {};
  const fx = c.instruments?.fx || {};
  const cr = c.instruments?.credit || {};
  const sp = c.instruments?.sovereign_spread || {};
  const st = c.instruments?.structural || {};

  const legRows = (c.heatLegs || [])
    .map(
      (l) => `<div style="display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid var(--border)">
        <span style="font-size:12.5px;color:var(--text-secondary)">${esc(LEG_LABEL[l.leg] || l.leg)}</span>
        <span style="font-weight:640;font-variant-numeric:tabular-nums;color:${l.value >= 0 ? "var(--green)" : "var(--red)"}">${pct(l.value)}</span>
      </div>`
    )
    .join("");

  const structRow = (k, label) => {
    const v = st[k];
    if (!v || v.status === "UNAVAILABLE" || v.value == null) return "";
    return `<tr><td>${esc(v.label || label)}</td>
      <td class="num"><b>${fmt(v.value)}</b>${k === "debtGdp" || k === "inflation" || k === "lendingRate" || k === "riskPremium" ? "%" : ""}</td>
      <td class="num" style="color:var(--text-faint)">${v.year}</td></tr>`;
  };

  root.innerHTML = `
  <a href="#/map" class="pc-tag" style="margin-bottom:16px">← Back to the map</a>
  <div class="pc-hero" style="margin-top:12px">
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <h1 style="margin:0">${esc(c.name)}</h1>
      <span class="pc-iso">${esc(c.iso)}</span>
      <span class="pc-tag">${esc(c.regionLabel || c.region || "")}</span>
      <span class="pc-badge ${cls(c.heat)}" style="font-size:13px;padding:3px 12px">${pct(c.heat)} · 1M USD</span>
    </div>
    <p style="margin-top:8px">${esc(c.heatBasis || "")}</p>
  </div>

  <div class="grid-12">
    <div class="col-4">
      <div class="pc-card pc-card-pad">
        <div class="pc-card-title">Heat breakdown</div>
        <div class="pc-card-sub">Each live leg, and the mean that becomes heat</div>
        ${legRows || `<div class="pc-empty" style="padding:20px">No live return leg for this market.</div>`}
        ${
          c.heat != null
            ? `<div style="display:flex;justify-content:space-between;align-items:center;padding:11px 0 0">
                 <span style="font-size:12.5px;font-weight:640">Heat (mean)</span>
                 <span style="font-size:19px;font-weight:700;font-variant-numeric:tabular-nums;color:${c.heat >= 0 ? "var(--green)" : "var(--red)"}">${pct(c.heat)}</span>
               </div>`
            : ""
        }
      </div>
    </div>

    <div class="col-4">
      ${legCard(
        "Sovereign bond",
        b.status === "OK",
        `<table class="pc-table"><tbody>
          <tr><td>10Y yield</td><td class="num"><b>${fmt(b.yield_pct)}%</b></td></tr>
          <tr><td>Yield z-score (126m)</td><td class="num">${fmt(b.yield_z)}</td></tr>
          <tr><td>Δ yield 1M / 3M / 12M</td><td class="num">${bps(b.yield_chg_bps?.["1"])} / ${bps(b.yield_chg_bps?.["3"])} / ${bps(b.yield_chg_bps?.["12"])}</td></tr>
          <tr><td>Price proxy — local</td><td class="num">${colored(b.bond_price_1m_pct)}</td></tr>
          <tr><td>Price proxy — USD</td><td class="num">${colored(b.bond_price_1m_usd_pct)}</td></tr>
          <tr><td>vs US 10Y</td><td class="num">${sp.vs_us_10y_bps == null ? "—" : bps(sp.vs_us_10y_bps)}</td></tr>
          <tr><td>As of</td><td class="num" style="color:var(--text-faint)">${esc(b.asOf || "—")}</td></tr>
        </tbody></table>
        <div class="pc-note">${esc(b.notes || "")} Price proxy assumes a duration of ${b.duration_assumed ?? 8.5}. ${esc(sp.note || "")}</div>`,
        b.why
      )}
    </div>

    <div class="col-4">
      ${legCard(
        "Currency",
        fx.status === "OK",
        `<table class="pc-table"><tbody>
          <tr><td>Pair</td><td class="num"><b>${esc(fx.symbol || "")}</b></td></tr>
          <tr><td>Quote</td><td class="num">${fmt(fx.quote, 4)}</td></tr>
          <tr><td>1M vs USD</td><td class="num">${colored(fx.ret_1m_pct)}</td></tr>
          <tr><td>3M vs USD</td><td class="num">${colored(fx.ret_3m_pct)}</td></tr>
          <tr><td>12M vs USD</td><td class="num">${colored(fx.ret_12m_pct)}</td></tr>
        </tbody></table>
        <div class="pc-note">${esc(fx.note || "")}</div>`,
        fx.status === "N/A" ? fx.note : fx.why
      )}
    </div>

    <div class="col-6">
      ${legCard(
        "Equity ETF",
        e.status === "OK",
        `<table class="pc-table"><tbody>
          <tr><td>Instrument</td><td class="num"><b>${esc(e.label || "")}</b></td></tr>
          <tr><td>Last close</td><td class="num">${fmt(e.last)}</td></tr>
          <tr><td>1M return</td><td class="num">${colored(e.ret_1m_pct)}</td></tr>
          <tr><td>3M return</td><td class="num">${colored(e.ret_3m_pct)}</td></tr>
          <tr><td>12M return</td><td class="num">${colored(e.ret_12m_pct)}</td></tr>
        </tbody></table>
        <div class="pc-note">${esc(e.note || "")}</div>`,
        e.why
      )}
    </div>

    <div class="col-6">
      ${legCard(
        "Regional corporate credit",
        cr.status === "OK",
        `<table class="pc-table"><tbody>
          <tr><td>Index</td><td class="num"><b>${esc(cr.label || "")}</b></td></tr>
          <tr><td>Option-adjusted spread</td><td class="num"><b>${fmt(cr.oas_bps, 0)} bps</b></td></tr>
          <tr><td>Δ1M spread</td><td class="num">${cr.oas_chg_1m_bps == null ? "—" : bps(cr.oas_chg_1m_bps)}</td></tr>
          <tr><td>Spread z-score</td><td class="num">${fmt(cr.oas_z)}</td></tr>
          <tr><td>1M carry proxy</td><td class="num">${colored(cr.credit_1m_pct)}</td></tr>
        </tbody></table>
        <div class="pc-note">${esc(cr.note || "")}</div>`,
        cr.why
      )}
    </div>

    <div class="col-12">
      <div class="pc-card pc-card-pad">
        <div class="pc-card-title">Structural context</div>
        <div class="pc-card-sub">World Bank annual indicators — slow-moving background, never part of heat</div>
        <div class="pc-table-wrap">
          <table class="pc-table">
            <thead><tr><th>Indicator</th><th class="num">Latest</th><th class="num">Year</th></tr></thead>
            <tbody>${
              ["debtGdp", "inflation", "lendingRate", "riskPremium"].map((k) => structRow(k)).join("") ||
              `<tr><td colspan="3" style="color:var(--text-secondary)">No World Bank rows for this market.</td></tr>`
            }</tbody>
          </table>
        </div>
        <div class="pc-note">${esc(st.note || "")}</div>
      </div>
    </div>

    <div class="col-12">
      <div class="pc-card pc-card-pad">
        <div class="pc-card-title">10-year yield — actual history</div>
        <div class="pc-card-sub">Real monthly observations, no extrapolation</div>
        <div class="pc-controls" style="margin-bottom:12px"><div id="hist-periods"></div></div>
        <div class="grid-12">
          <div class="col-8"><div id="hist-chart" style="height:380px"></div></div>
          <div class="col-4"><div id="hist-legend"></div></div>
        </div>
      </div>
    </div>

    <div class="col-12">
      <div class="pc-card pc-card-pad">
        <div class="pc-card-title">Projected return curve</div>
        <div class="pc-card-sub">Extrapolated from the live hold-horizon curves — not a forecast</div>
        <div class="pc-controls" style="margin-bottom:12px"><div id="proj-periods"></div></div>
        <div class="grid-12">
          <div class="col-8"><div id="proj-chart" style="height:380px"></div></div>
          <div class="col-4"><div id="proj-legend"></div></div>
        </div>
      </div>
    </div>
  </div>`;

  const recs = [];

  /* ---- real history ---- */
  const histEl = root.querySelector("#hist-chart");
  const hist = await loadHistory({ country: iso });
  if (hist?.series) {
    const rec = buildHistoryChart(histEl, {
      series: { [iso]: { standsFor: `${hist.name} 10Y — ${hist.source}`, points: hist.series, unit: "pct" } },
      id: "country-hist",
    });
    recs.push(rec);
    buildLegend(
      root.querySelector("#hist-legend"),
      [{ id: iso, name: `${hist.name} 10Y`, standsFor: `${hist.source} · ${hist.start} → ${hist.end}`, color: PALETTE[0] }],
      { onToggle: (id, on) => setSeriesVisible("country-hist", id, on) }
    );
    buildPeriodBar(root.querySelector("#hist-periods"), { onSelect: (p) => rec.applyPreset(p.months) });
  } else {
    histEl.innerHTML = `<div class="pc-empty">${esc(hist?.why || "No free 10-year series covers this market.")}</div>`;
  }

  /* ---- projected curve (euro-area country panel only) ---- */
  const projEl = root.querySelector("#proj-chart");
  const ret = await loadReturns("countries", "pure");
  const asset = (ret?.markets?.countries?.pure || []).find((a) => a.id === iso);
  if (asset && !asset.unavailable) {
    const rec = buildProjectionChart(projEl, [asset], { id: "country-proj", view: "ret" });
    recs.push(rec);
    buildLegend(
      root.querySelector("#proj-legend"),
      [{ id: asset.id, name: asset.name, standsFor: asset.standsFor, color: PALETTE[0] }],
      { onToggle: (id, on) => setSeriesVisible("country-proj", id, on) }
    );
    buildPeriodBar(root.querySelector("#proj-periods"), { onSelect: (p) => rec.applyPreset(p) });
  } else {
    projEl.innerHTML = `<div class="pc-empty">No projected curve for ${esc(iso)} — the hold-horizon country panel is built from the ECB long-term rate series, which covers euro-area members.</div>`;
  }

  return { dispose: () => recs.forEach((r) => r.dispose()) };
}
