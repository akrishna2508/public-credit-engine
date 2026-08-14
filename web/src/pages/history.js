/**
 * History page: real 15y+ series (no extrapolation). Two sections — US credit
 * grade spreads + default rates, and a sovereign 10Y selector. Each chart has
 * its own period bar and full-name toggleable legend.
 */
import { loadHistory, loadAtlas, setSeriesVisible } from "../store.js";
import { buildHistoryChart, PALETTE } from "../charts/history.js";
import { buildLegend } from "../legend.js";
import { buildPeriodBar } from "../controls.js";

/** every market the live atlas reports a real 10Y series for, grouped by region */
async function sovereignOptions() {
  const atlas = await loadAtlas();
  const rows = Object.values(atlas?.countries || {})
    .filter((c) => !c.aggregate && c.instruments?.bonds?.status === "OK")
    .map((c) => ({ iso: c.iso, name: c.name, region: c.regionLabel || c.region || "Other" }))
    .sort((a, b) => a.region.localeCompare(b.region) || a.name.localeCompare(b.name));
  if (rows.length) return rows;
  // atlas unavailable: fall back to the euro-area set that works keyless via ECB
  return ["DE", "FR", "IT", "ES", "NL", "BE", "AT", "PT", "IE", "FI", "GR"].map((iso) => ({
    iso, name: iso, region: "Europe",
  }));
}

export async function render(root) {
  const SOVEREIGNS = await sovereignOptions();
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
        <div class="pc-card-sub">Monthly OECD long-term rates (FRED), or the ECB long-term rate for euro-area members — real monthly observations. ${SOVEREIGNS.length} markets have a free 10-year series; those that do not are scored on the map through their equity and credit legs instead.</div>
        <div class="pc-controls" style="margin-bottom:12px">
          <select id="sovereign-sel" class="pc-btn">
            ${(() => {
              const byRegion = {};
              for (const s of SOVEREIGNS) (byRegion[s.region] = byRegion[s.region] || []).push(s);
              return Object.entries(byRegion)
                .map(
                  ([region, items]) =>
                    `<optgroup label="${region}">${items
                      .map((s) => `<option value="${s.iso}">${s.name} (${s.iso})</option>`)
                      .join("")}</optgroup>`
                )
                .join("");
            })()}
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