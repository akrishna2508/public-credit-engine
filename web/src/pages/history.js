/**
 * History page: real 15y+ series (no extrapolation). Two sections — US credit
 * grade spreads + default rates, and a sovereign 10Y selector. Each chart has
 * its own period bar and full-name toggleable legend.
 */
import { loadHistory, setSeriesVisible } from "../store.js";
import { buildHistoryChart, PALETTE } from "../charts/history.js";
import { buildLegend } from "../legend.js";
import { buildPeriodBar } from "../controls.js";

const SOVEREIGNS = [
  { iso: "DE", name: "Germany" }, { iso: "FR", name: "France" }, { iso: "IT", name: "Italy" },
  { iso: "ES", name: "Spain" }, { iso: "NL", name: "Netherlands" }, { iso: "BE", name: "Belgium" },
  { iso: "AT", name: "Austria" }, { iso: "PT", name: "Portugal" }, { iso: "IE", name: "Ireland" },
  { iso: "FI", name: "Finland" }, { iso: "GR", name: "Greece" }, { iso: "GB", name: "United Kingdom" },
  { iso: "JP", name: "Japan" }, { iso: "CA", name: "Canada" }, { iso: "AU", name: "Australia" },
  { iso: "CH", name: "Switzerland" }, { iso: "US", name: "United States" }, { iso: "KR", name: "South Korea" },
  { iso: "MX", name: "Mexico" }, { iso: "ZA", name: "South Africa" },
];

export async function render(root) {
  root.innerHTML = `
  <div class="grid-12">
    <div class="col-12">
      <div class="pc-card pc-card-pad">
        <div class="pc-card-title">US credit spreads — actual history</div>
        <div class="pc-card-sub">ICE BofA option-adjusted spreads by grade + Moody's 12-month trailing default rates (FRED). Real data, no extrapolation.</div>
        <div class="pc-controls" style="margin-bottom:12px"><div id="us-periods"></div></div>
        <div class="grid-12">
          <div class="col-8"><div id="us-chart" style="height:460px"></div></div>
          <div class="col-4"><div id="us-legend"></div></div>
        </div>
      </div>
    </div>
    <div class="col-12">
      <div class="pc-card pc-card-pad">
        <div class="pc-card-title">Sovereign 10-year yields — actual history</div>
        <div class="pc-card-sub">Monthly OECD long-term rates (FRED) / ECB LTIR for euro-area members — 15+ years of real monthly data.</div>
        <div class="pc-controls" style="margin-bottom:12px">
          <select id="sovereign-sel" class="pc-btn" style="appearance:none">
            ${SOVEREIGNS.map((s) => `<option value="${s.iso}">${s.name} (${s.iso})</option>`).join("")}
          </select>
          <div id="sovereign-periods"></div>
        </div>
        <div class="grid-12">
          <div class="col-8"><div id="sovereign-chart" style="height:460px"></div></div>
          <div class="col-4"><div id="sovereign-legend"></div></div>
        </div>
      </div>
    </div>
  </div>`;

  /* -------- US section -------- */
  const usEl = root.querySelector("#us-chart");
  const usLegendEl = root.querySelector("#us-legend");
  const recs = [];
  const usPayload = await loadHistory({ market: "us", kind: "oas" });
  if (usPayload?.series && Object.keys(usPayload.series).length) {
    const names = Object.keys(usPayload.series);
    const usRec = buildHistoryChart(usEl, { series: usPayload.series, id: "history-us" });
    recs.push(usRec);
    buildLegend(
      usLegendEl,
      names.map((n, i) => ({
        id: n,
        name: n === "DR_HY" ? "Speculative-grade default rate" : n === "DR_IG" ? "IG default rate" : `${n} spread`,
        standsFor: usPayload.series[n].standsFor,
        color: PALETTE[i % PALETTE.length],
      })),
      { onToggle: (id, on) => setSeriesVisible("history-us", id, on) }
    );
    buildPeriodBar(root.querySelector("#us-periods"), {
      onSelect: (preset) => usRec.applyPreset(preset.months),
    });
  } else {
    usEl.innerHTML = `<div class="pc-empty">US grade history needs the FRED key on this deployment${usPayload?.why ? ` — ${usPayload.why}` : ""}.</div>`;
  }

  /* -------- sovereign section -------- */
  const sel = root.querySelector("#sovereign-sel");
  const sovEl = root.querySelector("#sovereign-chart");
  const sovLegendEl = root.querySelector("#sovereign-legend");
  let sovRec = null;
  let sovPb = null;

  async function drawSovereign(iso) {
    if (sovRec) {
      sovRec.dispose();
      sovRec = null;
    }
    sovLegendEl.innerHTML = "";
    const p = await loadHistory({ country: iso });
    if (!p?.series) {
      sovEl.innerHTML = `<div class="pc-empty">${p?.why || "No 10-year series for this country."}</div>`;
      return;
    }
    sovRec = buildHistoryChart(sovEl, {
      series: { [iso]: { standsFor: `${p.name} 10Y — ${p.source}`, points: p.series, unit: "pct" } },
      id: "history-sovereign",
    });
    buildLegend(
      sovLegendEl,
      [{ id: iso, name: `${p.name} 10Y`, standsFor: `${p.source} · ${p.start} → ${p.end}`, color: PALETTE[0] }],
      { onToggle: (id, on) => setSeriesVisible("history-sovereign", id, on) }
    );
    if (!sovPb) {
      sovPb = buildPeriodBar(root.querySelector("#sovereign-periods"), {
        onSelect: (preset) => sovRec && sovRec.applyPreset(preset.months),
      });
    }
  }

  sel.addEventListener("change", () => drawSovereign(sel.value));
  await drawSovereign(sel.value || "DE");

  return {
    dispose() {
      recs.forEach((r) => r.dispose());
      if (sovRec) sovRec.dispose();
    },
  };
}