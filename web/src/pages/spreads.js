/**
 * Spreads page — what you are paid for HOLDING credit, net of expected loss.
 *
 * The counterpart to Returns. Returns prices a long-volatility straddle and
 * therefore charges a dealer markup; this page charges nothing but the loss
 * you expect to suffer, because that is the only deduction a buy-and-hold
 * bond position actually faces.
 */
import { loadSpreads, setSeriesVisible } from "../store.js";
import { buildHistoryChart, PALETTE } from "../charts/history.js";
import { buildLegend } from "../legend.js";
import { buildPeriodBar } from "../controls.js";

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const n2 = (v) => (v == null ? "—" : Number(v).toFixed(2));
const n0 = (v) => (v == null ? "—" : Number(v).toFixed(0));
const bps = (v) => (v == null ? `<span style="color:var(--text-faint)">—</span>` : `${Number(v).toFixed(1)}`);
const netCell = (v) =>
  v == null
    ? `<span style="color:var(--text-faint)">—</span>`
    : `<b style="color:${v >= 0 ? "var(--green)" : "var(--red)"}">${v > 0 ? "+" : ""}${Number(v).toFixed(1)}</b>`;

export async function render(root) {
  root.innerHTML = `<div class="pc-spinner-wrap"><div class="pc-spinner"></div>
    <div>Loading spreads and expected-loss estimates…</div></div>`;

  const s = await loadSpreads();
  if (!s || s.status !== "OK") {
    root.innerHTML = `<div class="pc-empty">
      <div style="font-weight:620;color:var(--text-main);margin-bottom:6px">Spread book unavailable</div>
      ${esc(s?.why || "The endpoint did not return data.")}</div>`;
    return { dispose() {} };
  }

  const order = s.order.filter((g) => s.grades[g]?.status === "OK");
  const pairOrder = s.pairOrder.filter((p) => s.pairs[p]?.status === "OK");
  const best = order
    .filter((g) => s.grades[g].net_of_expected_loss_bps != null)
    .sort((a, b) => s.grades[b].cover_ratio - s.grades[a].cover_ratio)[0];
  const negative = order.filter((g) => (s.grades[g].net_of_expected_loss_bps ?? 0) < 0);

  root.innerHTML = `
  <div class="pc-hero">
    <h1>Spread minus expected loss</h1>
    <p>${esc(s.definition)}</p>
  </div>

  <div class="pc-kpis" style="margin-bottom:20px">
    <div class="pc-kpi-cell"><div class="pc-kpi">
      <div class="pc-kpi-label">Grades covered</div>
      <div class="pc-kpi-value">${s.coverage.gradesCovered}<span style="font-size:14px;color:var(--text-faint);font-weight:500"> / ${s.coverage.gradesTotal}</span></div>
      <div class="pc-kpi-extra">with a live spread and a loss estimate</div></div></div>
    <div class="pc-kpi-cell"><div class="pc-kpi">
      <div class="pc-kpi-label">Best paid vs its losses</div>
      <div class="pc-kpi-value" style="color:var(--green)">${best ? n2(s.grades[best].cover_ratio) + "×" : "—"}</div>
      <div class="pc-kpi-extra">${esc(best || "—")} — spread ÷ expected loss</div></div></div>
    <div class="pc-kpi-cell"><div class="pc-kpi">
      <div class="pc-kpi-label">Widest net compensation</div>
      <div class="pc-kpi-value">${best ? n0(Math.max(...order.map((g) => s.grades[g].net_of_expected_loss_bps ?? -1e9))) : "—"}<span style="font-size:13px;color:var(--text-faint);font-weight:500"> bps</span></div>
      <div class="pc-kpi-extra">after subtracting expected loss</div></div></div>
    <div class="pc-kpi-cell"><div class="pc-kpi">
      <div class="pc-kpi-label">Not covering losses</div>
      <div class="pc-kpi-value" style="color:${negative.length ? "var(--red)" : "var(--green)"}">${negative.length}</div>
      <div class="pc-kpi-extra">${negative.length ? esc(negative.join(", ")) : "every grade clears its expected loss"}</div></div></div>
    <div class="pc-kpi-cell"><div class="pc-kpi">
      <div class="pc-kpi-label">Rungs modelled</div>
      <div class="pc-kpi-value">${s.coverage.pairsCovered}</div>
      <div class="pc-kpi-extra">adjacent-grade pairs</div></div></div>
  </div>

  <div class="grid-12">
    <div class="col-12">
      <div class="pc-card pc-card-pad">
        <div class="pc-card-head">
          <div>
            <div class="pc-card-title">Compensation by grade, net of expected loss</div>
            <div class="pc-card-sub">Option-adjusted spread minus expected loss, in basis points a year. Above zero you are paid more than the losses the proxy implies.</div>
          </div>
          <div class="pc-seg" id="grade-mode">
            <button data-m="net" class="active">Net of expected loss</button>
            <button data-m="oas">Gross spread</button>
          </div>
        </div>
        <div class="pc-controls" style="margin-bottom:12px"><div id="grade-periods"></div></div>
        <div class="grid-12">
          <div class="col-8"><div id="grade-chart" style="height:420px"></div></div>
          <div class="col-4"><div id="grade-legend"></div></div>
        </div>
      </div>
    </div>

    <div class="col-12">
      <div class="pc-card pc-card-pad">
        <div class="pc-card-title">The decomposition</div>
        <div class="pc-card-sub">Every number below is live; nothing is a stored constant except the published loss-given-default.</div>
        <div class="pc-table-wrap">
          <table class="pc-table">
            <thead><tr>
              <th>Grade</th><th>Tier</th>
              <th class="num">Spread (OAS)</th>
              <th class="num">Default rate</th>
              <th class="num">LGD</th>
              <th class="num">Expected loss</th>
              <th class="num">Net compensation</th>
              <th class="num">Cover ratio</th>
              <th class="num">Spread z</th>
            </tr></thead>
            <tbody>${order
              .map((g) => {
                const x = s.grades[g];
                return `<tr>
                  <td><b>${esc(g)}</b></td>
                  <td><span class="pc-badge neutral">${esc(x.tier)}</span></td>
                  <td class="num">${bps(x.oas_bps)}</td>
                  <td class="num">${n2(x.default_rate_pct)}%</td>
                  <td class="num">${(x.lgd * 100).toFixed(1)}%</td>
                  <td class="num">${bps(x.expected_loss_bps)}</td>
                  <td class="num">${netCell(x.net_of_expected_loss_bps)}</td>
                  <td class="num">${x.cover_ratio == null ? "—" : `<span class="pc-badge ${x.cover_ratio >= 1 ? "pos" : "neg"}">${n2(x.cover_ratio)}×</span>`}</td>
                  <td class="num">${x.oas_z == null ? "—" : n2(x.oas_z)}</td>
                </tr>`;
              })
              .join("")}</tbody>
          </table>
        </div>
        <div class="pc-note">All figures in basis points a year unless marked. <b>Cover ratio</b> is spread ÷ expected loss: below 1.0 the market is paying you less than the modelled losses. ${esc(s.expectedLoss.note)}</div>
        <div class="pc-note" style="border-left-color:var(--amber)">${esc(s.caution)}</div>
      </div>
    </div>

    <div class="col-12">
      <div class="pc-card pc-card-pad">
        <div class="pc-card-head">
          <div>
            <div class="pc-card-title">Adjacent rungs — the relative-value ladder</div>
            <div class="pc-card-sub">What you are paid to step down one grade, net of the extra losses that step implies. These are the series the forecast page models.</div>
          </div>
        </div>
        <div class="pc-controls" style="margin-bottom:12px"><div id="pair-periods"></div></div>
        <div class="grid-12">
          <div class="col-8"><div id="pair-chart" style="height:400px"></div></div>
          <div class="col-4"><div id="pair-legend"></div></div>
        </div>
        <div class="pc-table-wrap" style="margin-top:14px">
          <table class="pc-table">
            <thead><tr><th>Rung</th><th class="num">Spread difference</th><th class="num">Expected-loss difference</th><th class="num">Net</th></tr></thead>
            <tbody>${pairOrder
              .map((p) => {
                const x = s.pairs[p];
                return `<tr>
                  <td><b>${esc(p)}</b><div style="font-size:10.5px;color:var(--text-faint);max-width:520px">${esc(x.standsFor)}</div></td>
                  <td class="num">${bps(x.spread_diff_bps)}</td>
                  <td class="num">${bps(x.el_diff_bps)}</td>
                  <td class="num">${netCell(x.net_of_expected_loss_bps)}</td>
                </tr>`;
              })
              .join("")}</tbody>
          </table>
        </div>
        <div class="pc-note">A <b>negative</b> rung means the extra spread does not compensate for the extra expected loss of dropping to that grade — the ladder is inverted there, and the step down is not paying for itself.</div>
      </div>
    </div>

    <div class="col-12">
      <div class="pc-card pc-card-pad">
        <div class="pc-card-title">Index book — spreads without a loss estimate</div>
        <div class="pc-card-sub">${s.indices.length} emerging-market and regional indices. No published default-rate proxy maps to these, so they are shown gross and are not netted.</div>
        <div class="pc-controls" style="margin-bottom:12px"><div id="index-periods"></div></div>
        <div class="grid-12">
          <div class="col-8"><div id="index-chart" style="height:400px"></div></div>
          <div class="col-4"><div id="index-legend"></div></div>
        </div>
      </div>
    </div>
  </div>`;

  const recs = [];

  /* ---------------- grade chart ---------------- */
  const gradeEl = root.querySelector("#grade-chart");
  const gradeLegendEl = root.querySelector("#grade-legend");
  let gradeRec = null;
  let gradeMode = "net";
  let gradePb = null;

  function drawGrades() {
    gradeRec?.dispose();
    gradeLegendEl.innerHTML = "";
    const series = {};
    for (const g of order) {
      const x = s.grades[g];
      const pts = gradeMode === "net" ? x.history.net : x.history.oas;
      if (!pts || !pts.length) continue;
      series[g] = {
        standsFor:
          gradeMode === "net"
            ? `${x.label} minus expected loss of ${n2(x.expected_loss_bps)} bps`
            : x.label,
        points: pts,
        unit: "bps",
      };
    }
    if (!Object.keys(series).length) {
      gradeEl.innerHTML = `<div class="pc-empty">No grade series available.</div>`;
      return;
    }
    gradeRec = buildHistoryChart(gradeEl, { series, id: "spreads-grade", initialMonths: 36 });
    recs.push(gradeRec);
    buildLegend(
      gradeLegendEl,
      Object.keys(series).map((g, i) => ({
        id: g,
        name: g,
        standsFor: series[g].standsFor,
        color: PALETTE[i % PALETTE.length],
      })),
      { onToggle: (id, on) => setSeriesVisible("spreads-grade", id, on) }
    );
    if (!gradePb) {
      gradePb = buildPeriodBar(root.querySelector("#grade-periods"), {
        initial: "3Y",
        periods: [
          { label: "6M", months: 6 }, { label: "1Y", months: 12 }, { label: "3Y", months: 36 },
          { label: "5Y", months: 60 }, { label: "All", months: 600 },
        ],
        onSelect: (p) => gradeRec && gradeRec.applyPreset(p.months),
      });
    } else {
      const a = gradePb.current();
      if (a) gradeRec.applyPreset(a.months);
    }
  }
  drawGrades();

  root.querySelector("#grade-mode").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    root.querySelectorAll("#grade-mode button").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    gradeMode = b.dataset.m;
    drawGrades();
  });

  /* ---------------- pair chart ---------------- */
  const pairEl = root.querySelector("#pair-chart");
  if (pairOrder.length) {
    const series = {};
    pairOrder.forEach((p) => {
      series[p] = { standsFor: s.pairs[p].standsFor, points: s.pairs[p].history, unit: "bps" };
    });
    const rec = buildHistoryChart(pairEl, { series, id: "spreads-pair", initialMonths: 36 });
    recs.push(rec);
    buildLegend(
      root.querySelector("#pair-legend"),
      pairOrder.map((p, i) => ({ id: p, name: p, standsFor: s.pairs[p].standsFor, color: PALETTE[i % PALETTE.length] })),
      { onToggle: (id, on) => setSeriesVisible("spreads-pair", id, on) }
    );
    buildPeriodBar(root.querySelector("#pair-periods"), {
      initial: "3Y",
      periods: [
        { label: "6M", months: 6 }, { label: "1Y", months: 12 }, { label: "3Y", months: 36 },
        { label: "5Y", months: 60 }, { label: "All", months: 600 },
      ],
      onSelect: (p) => rec.applyPreset(p.months),
    });
  } else {
    pairEl.innerHTML = `<div class="pc-empty">No adjacent rung could be built.</div>`;
  }

  /* ---------------- index chart ---------------- */
  const indexEl = root.querySelector("#index-chart");
  if (s.indices.length) {
    const series = {};
    s.indices.forEach((ix) => {
      series[ix.id] = { standsFor: `${ix.label} — ${ix.seriesId}`, points: ix.history, unit: "bps" };
    });
    const rec = buildHistoryChart(indexEl, { series, id: "spreads-index", initialMonths: 36 });
    recs.push(rec);
    buildLegend(
      root.querySelector("#index-legend"),
      s.indices.map((ix, i) => ({ id: ix.id, name: ix.label, standsFor: `${ix.seriesId} · ${ix.oas_bps} bps now`, color: PALETTE[i % PALETTE.length] })),
      { onToggle: (id, on) => setSeriesVisible("spreads-index", id, on) }
    );
    buildPeriodBar(root.querySelector("#index-periods"), {
      initial: "3Y",
      periods: [
        { label: "6M", months: 6 }, { label: "1Y", months: 12 }, { label: "3Y", months: 36 },
        { label: "5Y", months: 60 }, { label: "All", months: 600 },
      ],
      onSelect: (p) => rec.applyPreset(p.months),
    });
  } else {
    indexEl.innerHTML = `<div class="pc-empty">No index series available.</div>`;
  }

  return { dispose: () => recs.forEach((r) => r.dispose()) };
}
