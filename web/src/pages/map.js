/**
 * Map page: heat map of the 15-survey atlas (green = attractive opportunity,
 * red = unattractive, beige = neutral/n-a), region heat rail, top-3 list and
 * a full table. Every country row opens the drill-down page.
 */
import { loadAtlas } from "../store.js";
import { buildMapChart } from "../charts/map.js";

const fmt = (v, d = 2) => (v == null ? "—" : Number(v).toFixed(d));

export async function render(root) {
  const atlas = await loadAtlas();
  if (!atlas?.countries) {
    root.innerHTML = `<div class="pc-empty">No atlas data available right now — check back shortly.</div>`;
    return { dispose() {} };
  }

  root.innerHTML = `
  <div class="grid-12">
    <div class="col-8">
      <div class="pc-card pc-card-pad">
        <div class="pc-external-label">Opportunity heat — 1-month return proxies · by country</div>
        <div id="map-el" style="height:520px"></div>
        <div class="pc-note">Heat = unweighted mean of available 1-month price-return proxies
        (bond price proxy, equity ETF return) per country. Green = positive compensation,
        red = negative, beige = neutral or no data. Click a country to drill down.</div>
      </div>
    </div>
    <div class="col-4">
      <div class="pc-card pc-card-pad">
        <div class="pc-card-title">Region heat</div>
        <div class="pc-card-sub">Unweighted mean of member-country heat</div>
        <div id="region-list"></div>
      </div>
      <div class="pc-card pc-card-pad" style="margin-top:20px">
        <div class="pc-card-title">Top opportunities</div>
        <div class="pc-card-sub">Highest 1-month heat</div>
        <div id="top-list"></div>
      </div>
    </div>
    <div class="col-12">
      <div class="pc-card pc-card-pad">
        <div class="pc-card-title">All markets</div>
        <div class="pc-card-sub">Click any row for the full country view</div>
        <table class="pc-table">
          <thead><tr>
            <th>Country</th><th>Region</th><th>Heat</th><th>10Y yield</th>
            <th>1M Δ (bps)</th><th>3M Δ (bps)</th><th>12M Δ (bps)</th>
            <th>1M price proxy</th><th>vs US 10Y (bps)</th><th>Equity ETF 1M</th>
          </tr></thead>
          <tbody id="atlas-body"></tbody>
        </table>
      </div>
    </div>
  </div>`;

  const countries = Object.entries(atlas.countries)
    .map(([iso, c]) => ({ iso, ...c }))
    .sort((a, b) => (b.heat ?? -99) - (a.heat ?? -99));

  const go = (iso) => (location.hash = `#/country/${iso}`);

  const mapRec = await buildMapChart(root.querySelector("#map-el"), atlas, { onSelect: go });

  const regions = Object.entries(atlas.regions || {}).sort((a, b) => b[1] - a[1]);
  const regionList = root.querySelector("#region-list");
  if (!regions.length) {
    regionList.innerHTML = `<div class="pc-empty">No region data</div>`;
  } else {
    regionList.innerHTML = regions
      .map(
        ([r, v]) => `<div style="display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid var(--border)">
          <span style="font-weight:600;font-size:13px">${r[0].toUpperCase() + r.slice(1)}</span>
          <span class="pc-badge ${v > 0 ? "heat-pos" : v < 0 ? "heat-neg" : "heat-zero"}">${v > 0 ? "+" : ""}${fmt(v, 3)}</span>
        </div>`
      )
      .join("");
  }

  const topList = root.querySelector("#top-list");
  topList.innerHTML = countries
    .slice(0, 3)
    .map(
      (c) => `<div class="country-row" data-iso="${c.iso}" style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border)">
        <div>
          <div style="font-weight:600;font-size:13.5px">${c.name}</div>
          <div style="font-size:11.5px;color:var(--text-secondary)">${fmt(c.instruments?.bonds?.yield_pct)}% yield · ${fmt(c.instruments?.bonds?.yield_chg_bps?.["1"], 0)} bps 1M</div>
        </div>
        <span class="pc-badge ${(c.heat ?? 0) > 0 ? "heat-pos" : "heat-neg"}">${c.heat > 0 ? "+" : ""}${fmt(c.heat, 3)}</span>
      </div>`
    )
    .join("");

  const body = root.querySelector("#atlas-body");
  body.innerHTML = countries
    .map((c) => {
      const b = c.instruments?.bonds || {};
      const e = c.instruments?.equity_etf || {};
      const spread = c.instruments?.cds?.sovereign_spread_bps;
      return `<tr class="country-row" data-iso="${c.iso}">
        <td><b>${c.name}</b></td>
        <td>${c.region}</td>
        <td><span class="pc-badge ${(c.heat ?? 0) > 0 ? "heat-pos" : (c.heat ?? 0) < 0 ? "heat-neg" : "heat-zero"}">${c.heat == null ? "n/a" : (c.heat > 0 ? "+" : "") + fmt(c.heat, 3)}</span></td>
        <td class="tabular">${fmt(b.yield_pct)}%</td>
        <td class="tabular">${fmt(b.yield_chg_bps?.["1"], 0)}</td>
        <td class="tabular">${fmt(b.yield_chg_bps?.["3"], 0)}</td>
        <td class="tabular">${fmt(b.yield_chg_bps?.["12"], 0)}</td>
        <td class="tabular">${fmt(b.bond_price_1m_pct)}%</td>
        <td class="tabular">${fmt(spread, 0)}</td>
        <td class="tabular">${fmt(e.ret_1m_pct)}%</td>
      </tr>`;
    })
    .join("");

  root.querySelectorAll(".country-row").forEach((el) =>
    el.addEventListener("click", () => go(el.dataset.iso))
  );

  return { dispose: () => mapRec.dispose() };
}