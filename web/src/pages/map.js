/**
 * Map page — the landing view. World heat map of the 1-month USD return proxy,
 * a KPI strip, region rail, top/bottom movers, and a sortable table of every
 * covered market with its per-leg breakdown.
 */
import { loadAtlas } from "../store.js";
import { buildMapChart } from "../charts/map.js";

const fmt = (v, d = 2) => (v == null ? "—" : Number(v).toFixed(d));
const signed = (v, d = 2) => (v == null ? "—" : `${v > 0 ? "+" : ""}${Number(v).toFixed(d)}`);
const pct = (v, d = 2) => (v == null ? "—" : `${v > 0 ? "+" : ""}${Number(v).toFixed(d)}%`);
const cls = (v) => (v == null ? "heat-zero" : v > 0.05 ? "heat-pos" : v < -0.05 ? "heat-neg" : "heat-zero");
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** small inline diverging bar so the table reads like a chart */
function heatBar(v, span) {
  if (v == null) return `<span style="color:var(--text-faint)">—</span>`;
  const t = Math.max(-1, Math.min(1, v / span));
  const w = Math.abs(t) * 50;
  const color = v >= 0 ? "var(--green)" : "var(--red)";
  const style = v >= 0 ? `left:50%;width:${w}%` : `right:50%;width:${w}%`;
  return `<div class="pc-bar"><div class="pc-bar-track"></div><div class="pc-bar-mid"></div>
            <div class="pc-bar-fill" style="${style};background:${color}"></div></div>`;
}

export async function render(root) {
  root.innerHTML = `<div class="pc-spinner-wrap"><div class="pc-spinner"></div><div>Loading the global opportunity atlas…</div></div>`;
  const atlas = await loadAtlas();

  if (!atlas?.countries || !Object.keys(atlas.countries).length) {
    root.innerHTML = `<div class="pc-empty">
      <div style="font-weight:620;color:var(--text-main);margin-bottom:6px">No atlas data available</div>
      The live endpoint and the committed fallback bundle both failed to load.</div>`;
    return { dispose() {} };
  }

  const list = Object.values(atlas.countries)
    .filter((c) => !c.aggregate)
    .sort((a, b) => (b.heat ?? -999) - (a.heat ?? -999));
  const scored = list.filter((c) => c.heat != null);
  const heats = scored.map((c) => c.heat);
  const span = Math.max(1, ...heats.map((h) => Math.abs(h)));
  const positive = heats.filter((h) => h > 0).length;
  const median = heats.length ? [...heats].sort((a, b) => a - b)[Math.floor(heats.length / 2)] : null;
  const cov = atlas.coverage || {};
  const regions = Object.entries(atlas.regions || {}).sort((a, b) => b[1].heat - a[1].heat);

  root.innerHTML = `
  <div class="pc-hero">
    <h1>Global opportunity map</h1>
    <p>${esc(atlas.heatDefinition || "")}</p>
  </div>

  <div class="pc-kpis" style="margin-bottom:20px">
    <div class="pc-kpi-cell"><div class="pc-kpi">
      <div class="pc-kpi-label">Markets covered</div>
      <div class="pc-kpi-value">${cov.total ?? list.length}</div>
      <div class="pc-kpi-extra">${cov.scored ?? scored.length} with a live return leg</div>
    </div></div>
    <div class="pc-kpi-cell"><div class="pc-kpi">
      <div class="pc-kpi-label">Paying positively</div>
      <div class="pc-kpi-value" style="color:var(--green)">${positive}<span style="font-size:14px;color:var(--text-faint);font-weight:500"> / ${scored.length}</span></div>
      <div class="pc-kpi-extra">over the last month, in USD</div>
    </div></div>
    <div class="pc-kpi-cell"><div class="pc-kpi">
      <div class="pc-kpi-label">Median market</div>
      <div class="pc-kpi-value" style="color:${median >= 0 ? "var(--green)" : "var(--red)"}">${pct(median)}</div>
      <div class="pc-kpi-extra">1-month USD return proxy</div>
    </div></div>
    <div class="pc-kpi-cell"><div class="pc-kpi">
      <div class="pc-kpi-label">Best market</div>
      <div class="pc-kpi-value" style="color:var(--green)">${pct(list[0]?.heat)}</div>
      <div class="pc-kpi-extra">${esc(list[0]?.name ?? "—")}</div>
    </div></div>
    <div class="pc-kpi-cell"><div class="pc-kpi">
      <div class="pc-kpi-label">Data legs live</div>
      <div class="pc-kpi-value">${(cov.withSovereignYield ?? 0) + (cov.withEquityEtf ?? 0) + (cov.withCreditLeg ?? 0)}</div>
      <div class="pc-kpi-extra">${cov.withSovereignYield ?? 0} bond · ${cov.withEquityEtf ?? 0} equity · ${cov.withCreditLeg ?? 0} credit</div>
    </div></div>
  </div>

  <div class="grid-12">
    <div class="col-8">
      <div class="pc-card pc-card-pad">
        <div class="pc-card-head">
          <div>
            <div class="pc-eyebrow">Opportunity heat · by country</div>
            <div class="pc-card-sub">Green pays, red costs. Grey means the country is outside the atlas — never "zero".</div>
          </div>
          <div class="pc-scale" style="min-width:190px">
            <span>−${span.toFixed(1)}%</span><div class="pc-scale-bar"></div><span>+${span.toFixed(1)}%</span>
          </div>
        </div>
        <div id="map-el" style="height:540px"></div>
        <div id="map-note" class="pc-note"></div>
      </div>
    </div>

    <div class="col-4">
      <div class="pc-card pc-card-pad">
        <div class="pc-card-title">Region heat</div>
        <div class="pc-card-sub">Unweighted mean of member markets</div>
        <div id="region-list"></div>
      </div>
      <div class="pc-card pc-card-pad" style="margin-top:20px">
        <div class="pc-card-title">Best paid right now</div>
        <div class="pc-card-sub">Highest 1-month USD return proxy</div>
        <div id="top-list"></div>
      </div>
      <div class="pc-card pc-card-pad" style="margin-top:20px">
        <div class="pc-card-title">Costing the most</div>
        <div class="pc-card-sub">Lowest 1-month USD return proxy</div>
        <div id="bottom-list"></div>
      </div>
    </div>

    <div class="col-12">
      <div class="pc-card pc-card-pad">
        <div class="pc-card-head">
          <div>
            <div class="pc-card-title">All markets</div>
            <div class="pc-card-sub">Click any row for the full country view. Columns sort — click a header.</div>
          </div>
          <div class="pc-controls">
            <input id="mkt-search" class="pc-search" placeholder="Filter countries…" />
            <div class="pc-chips" id="region-chips"></div>
          </div>
        </div>
        <div class="pc-table-wrap">
          <table class="pc-table">
            <thead><tr>
              <th class="pc-rank"></th>
              <th class="sortable" data-k="name">Market</th>
              <th class="sortable" data-k="region">Region</th>
              <th class="sortable num" data-k="heat">Heat (1M USD)</th>
              <th></th>
              <th class="sortable num" data-k="bond">Bond leg</th>
              <th class="sortable num" data-k="equity">Equity leg</th>
              <th class="sortable num" data-k="credit">Credit leg</th>
              <th class="sortable num" data-k="yield">10Y yield</th>
              <th class="sortable num" data-k="chg1">Δ1M yield</th>
              <th class="sortable num" data-k="spread">vs US 10Y</th>
              <th class="sortable num" data-k="fx">FX 1M</th>
            </tr></thead>
            <tbody id="atlas-body"></tbody>
          </table>
        </div>
        <div class="pc-note" id="table-note"></div>
      </div>
    </div>
  </div>`;

  const go = (iso) => (location.hash = `#/country/${iso}`);

  /* ---------------- map ---------------- */
  let mapRec = null;
  const mapNote = root.querySelector("#map-note");
  try {
    mapRec = await buildMapChart(root.querySelector("#map-el"), atlas, { onSelect: go });
    mapNote.innerHTML = `Heat is the unweighted mean of the available live legs per country — sovereign bond price proxy in USD, country equity ETF return, and regional emerging-market corporate credit carry. ${mapRec.matched} of ${list.length} markets are drawn on the basemap${mapRec.unmatched.length ? `; ${esc(mapRec.unmatched.join(", "))} ${mapRec.unmatched.length === 1 ? "has" : "have"} no matching map feature and appear${mapRec.unmatched.length === 1 ? "s" : ""} in the table only` : ""}.`;
  } catch (e) {
    root.querySelector("#map-el").innerHTML =
      `<div class="pc-empty">The world basemap could not be loaded, so the map is unavailable. Every number below is still live.<div style="font-size:11.5px;color:var(--text-faint);margin-top:8px">${esc(e.message)}</div></div>`;
    mapNote.textContent = "The table and rankings below are unaffected — they read the same atlas payload the map would have used.";
  }

  /* ---------------- region rail ---------------- */
  const regionList = root.querySelector("#region-list");
  regionList.innerHTML = regions.length
    ? regions
        .map(
          ([key, r]) => `<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border)">
            <div><div style="font-weight:600;font-size:12.5px">${esc(r.label || key)}</div>
                 <div style="font-size:11px;color:var(--text-faint)">${r.countries} market${r.countries === 1 ? "" : "s"}</div></div>
            <span class="pc-badge ${cls(r.heat)}">${pct(r.heat)}</span></div>`
        )
        .join("")
    : `<div class="pc-empty">No region data</div>`;

  const miniRow = (c, i) => `
    <div class="pc-rank-row" data-iso="${c.iso}">
      <div class="pc-rank-num">${i + 1}</div>
      <div class="pc-rank-body">
        <div class="pc-rank-name">${esc(c.name)}</div>
        <div class="pc-rank-meta">${c.instruments?.bonds?.yield_pct != null ? `${fmt(c.instruments.bonds.yield_pct)}% 10Y · ` : ""}${(c.heatLegs || []).length} leg${(c.heatLegs || []).length === 1 ? "" : "s"}</div>
      </div>
      <span class="pc-badge ${cls(c.heat)}">${pct(c.heat)}</span>
    </div>`;
  root.querySelector("#top-list").innerHTML = scored.slice(0, 5).map(miniRow).join("");
  root.querySelector("#bottom-list").innerHTML = scored.slice(-5).reverse().map(miniRow).join("");

  /* ---------------- table ---------------- */
  const legOf = (c, leg) => (c.heatLegs || []).find((l) => l.leg === leg)?.value ?? null;
  const rowsData = list.map((c) => ({
    c,
    name: c.name,
    region: c.regionLabel || c.region,
    heat: c.heat,
    bond: legOf(c, "bond"),
    equity: legOf(c, "equity"),
    credit: legOf(c, "credit"),
    yield: c.instruments?.bonds?.yield_pct ?? null,
    chg1: c.instruments?.bonds?.yield_chg_bps?.["1"] ?? null,
    spread: c.instruments?.sovereign_spread?.vs_us_10y_bps ?? null,
    fx: c.instruments?.fx?.ret_1m_pct ?? null,
  }));

  const body = root.querySelector("#atlas-body");
  const tableNote = root.querySelector("#table-note");
  let sortKey = "heat";
  let sortDir = 1; // 1 = descending for numbers / A-Z for text
  let query = "";
  let regionFilter = null;

  const num = (v) => (v == null ? "—" : v);
  const colored = (v, suffix = "%") =>
    v == null
      ? `<span style="color:var(--text-faint)">—</span>`
      : `<span style="color:${v > 0 ? "var(--green)" : v < 0 ? "var(--red)" : "var(--text-secondary)"}">${v > 0 ? "+" : ""}${Number(v).toFixed(2)}${suffix}</span>`;

  function draw() {
    let rows = rowsData;
    if (query) rows = rows.filter((r) => r.name.toLowerCase().includes(query) || r.c.iso.toLowerCase() === query);
    if (regionFilter) rows = rows.filter((r) => r.c.region === regionFilter);
    rows = [...rows].sort((a, b) => {
      const x = a[sortKey];
      const y = b[sortKey];
      if (typeof x === "string" || typeof y === "string") {
        return sortDir * String(x ?? "").localeCompare(String(y ?? ""));
      }
      // nulls always sink, whichever way the column is sorted
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      return sortDir * (y - x);
    });

    body.innerHTML = rows.length
      ? rows
          .map(
            (r, i) => `<tr class="country-row" data-iso="${r.c.iso}">
        <td class="pc-rank">${i + 1}</td>
        <td><div class="pc-flagname"><span class="pc-iso">${r.c.iso}</span><b>${esc(r.name)}</b></div></td>
        <td style="color:var(--text-secondary)">${esc(r.region)}</td>
        <td class="num"><span class="pc-badge ${cls(r.heat)}">${pct(r.heat)}</span></td>
        <td style="width:96px">${heatBar(r.heat, span)}</td>
        <td class="num">${colored(r.bond)}</td>
        <td class="num">${colored(r.equity)}</td>
        <td class="num">${colored(r.credit)}</td>
        <td class="num">${r.yield == null ? `<span style="color:var(--text-faint)">—</span>` : fmt(r.yield) + "%"}</td>
        <td class="num">${r.chg1 == null ? `<span style="color:var(--text-faint)">—</span>` : signed(r.chg1, 0)}</td>
        <td class="num">${r.spread == null ? `<span style="color:var(--text-faint)">—</span>` : signed(r.spread, 0)}</td>
        <td class="num">${colored(r.fx)}</td>
      </tr>`
          )
          .join("")
      : `<tr><td colspan="12"><div class="pc-empty">No market matches that filter.</div></td></tr>`;

    tableNote.innerHTML = `Showing <b>${rows.length}</b> of ${rowsData.length} markets. Bond, equity and credit are the individual 1-month USD return legs that make up heat; a dash means that leg has no free live source for the market and is excluded from its average rather than counted as zero. Δ1M yield and vs US 10Y are in basis points.`;

    body.querySelectorAll(".country-row").forEach((el) =>
      el.addEventListener("click", () => go(el.dataset.iso))
    );
  }

  root.querySelectorAll("th.sortable").forEach((th) =>
    th.addEventListener("click", () => {
      const k = th.dataset.k;
      if (sortKey === k) sortDir *= -1;
      else {
        sortKey = k;
        sortDir = 1;
      }
      draw();
    })
  );
  root.querySelector("#mkt-search").addEventListener("input", (e) => {
    query = e.target.value.trim().toLowerCase();
    draw();
  });

  const chips = root.querySelector("#region-chips");
  chips.innerHTML =
    `<button class="pc-chip active" data-r="">All</button>` +
    regions.map(([k, r]) => `<button class="pc-chip" data-r="${k}">${esc(r.label || k)}</button>`).join("");
  chips.querySelectorAll(".pc-chip").forEach((b) =>
    b.addEventListener("click", () => {
      chips.querySelectorAll(".pc-chip").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      regionFilter = b.dataset.r || null;
      draw();
    })
  );

  root.querySelectorAll(".pc-rank-row").forEach((el) =>
    el.addEventListener("click", () => go(el.dataset.iso))
  );

  draw();
  return { dispose: () => mapRec?.dispose() };
}
