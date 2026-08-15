/**
 * Opportunities page — the ranked board. Two books (credit indices and
 * sovereign bonds) sorted by `cheapZ`: how wide the current spread or yield is
 * against that instrument's own trailing history.
 */
import { loadOpportunities, loadDrivers, loadSpreads } from "../store.js";

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const n2 = (v) => (v == null ? "—" : Number(v).toFixed(2));
const n3 = (v) => (v == null ? "—" : Number(v).toFixed(3));
const signed = (v, d = 0) => (v == null ? "—" : `${v > 0 ? "+" : ""}${Number(v).toFixed(d)}`);

const FAMILY = {
  region: "EM by region",
  quality: "EM by quality",
  sector: "EM by sector",
  us: "US grade ladder",
};

/** z-score -> a badge that says what it means rather than just the number */
function zBadge(z) {
  if (z == null) return `<span class="pc-badge neutral">n/a</span>`;
  const c = z > 1 ? "pos" : z < -1 ? "neg" : "neutral";
  return `<span class="pc-badge ${c}">${z > 0 ? "+" : ""}${z.toFixed(2)}σ</span>`;
}

/** a −3σ..+3σ position bar */
function zBar(z) {
  if (z == null) return "";
  const t = Math.max(-1, Math.min(1, z / 3));
  const left = 50 + t * 50;
  const color = z > 1 ? "var(--green)" : z < -1 ? "var(--red)" : "var(--text-faint)";
  return `<div class="pc-bar" style="min-width:70px">
      <div class="pc-bar-track"></div><div class="pc-bar-mid"></div>
      <div style="position:absolute;top:2px;bottom:2px;width:3px;border-radius:2px;background:${color};left:calc(${left}% - 1.5px)"></div>
    </div>`;
}

export async function render(root) {
  root.innerHTML = `<div class="pc-spinner-wrap"><div class="pc-spinner"></div>
    <div>Screening credit indices and sovereign curves…</div></div>`;

  // the screen joins three cached endpoints: the ranking itself, what the
  // fitted VAR says is driving each index, and the expected loss a US grade
  // has to cover before its spread is compensation for anything
  const [o, drv, spr] = await Promise.all([loadOpportunities(), loadDrivers(), loadSpreads()]);

  /** id -> { id, share } from the variance decomposition, across all panels */
  const driverBy = new Map();
  for (const panel of drv?.panels || []) {
    if (panel.status !== "OK") continue;
    for (const srs of panel.series) {
      if (!srs.driver) continue;
      const rec = { ...srs.driver, own: srs.ownShare, r2: srs.r2 };
      driverBy.set(srs.id, rec);
      // the drivers panel names US grades AAA…CCC; the opportunity screen
      // names the same series US_AAA…US_CCC
      driverBy.set(`US_${srs.id}`, rec);
    }
  }
  /** the opportunities ids for US grades are US_AAA…; the spreads book keys on AAA */
  const elBy = new Map();
  for (const g of Object.values(spr?.grades || {})) {
    if (!g || g.status !== "OK") continue;
    elBy.set(g.grade, g);
    elBy.set(`US_${g.grade}`, g);
  }
  if (!o || o.status !== "OK") {
    root.innerHTML = `<div class="pc-empty">
      <div style="font-weight:620;color:var(--text-main);margin-bottom:6px">Opportunity screen unavailable</div>
      ${esc(o?.why || "The endpoint did not return a ranking.")}</div>`;
    return { dispose() {} };
  }

  const credit = o.credit || [];
  const sovereign = o.sovereign || [];
  const wide = credit.filter((c) => (c.cheapZ ?? 0) > 1).length;
  const topCredit = credit[0];
  const topSov = sovereign[0];

  root.innerHTML = `
  <div class="pc-hero">
    <h1>Opportunity board</h1>
    <p>Every public-credit instrument the free data tier covers, ranked by how much you are being paid relative to that instrument's own history. ${credit.length} credit indices and ${sovereign.length} sovereign curves, all live.</p>
  </div>

  <div class="pc-kpis" style="margin-bottom:20px">
    <div class="pc-kpi-cell"><div class="pc-kpi">
      <div class="pc-kpi-label">Credit indices</div>
      <div class="pc-kpi-value">${credit.length}</div>
      <div class="pc-kpi-extra">EM by region, quality, sector + US ladder</div></div></div>
    <div class="pc-kpi-cell"><div class="pc-kpi">
      <div class="pc-kpi-label">Wide vs own history</div>
      <div class="pc-kpi-value" style="color:var(--green)">${wide}</div>
      <div class="pc-kpi-extra">above +1σ — paid more than usual</div></div></div>
    <div class="pc-kpi-cell"><div class="pc-kpi">
      <div class="pc-kpi-label">Widest credit</div>
      <div class="pc-kpi-value">${topCredit ? `${topCredit.oas_bps}` : "—"}<span style="font-size:13px;color:var(--text-faint);font-weight:500"> bps</span></div>
      <div class="pc-kpi-extra">${esc(topCredit?.label ?? "—")}</div></div></div>
    <div class="pc-kpi-cell"><div class="pc-kpi">
      <div class="pc-kpi-label">Sovereign top of book</div>
      <div class="pc-kpi-value">${topSov?.cheapZ == null ? "—" : `${topSov.cheapZ > 0 ? "+" : ""}${n2(topSov.cheapZ)}σ`}</div>
      <div class="pc-kpi-extra">${esc(topSov?.name ?? "—")} · ${topSov ? n2(topSov.yield_pct) + "% 10Y" : "—"}</div></div></div>
    <div class="pc-kpi-cell"><div class="pc-kpi">
      <div class="pc-kpi-label">Sovereign curves</div>
      <div class="pc-kpi-value">${sovereign.length}</div>
      <div class="pc-kpi-extra">with a live 10Y yield</div></div></div>
  </div>

  <div class="grid-12">
    <div class="col-12">
      <div class="pc-card pc-card-pad">
        <div class="pc-card-head">
          <div>
            <div class="pc-card-title">Credit book</div>
            <div class="pc-card-sub">${esc(o.ranking?.definition || "")}</div>
          </div>
          <div class="pc-chips" id="fam-chips"></div>
        </div>
        <div class="pc-table-wrap">
          <table class="pc-table">
            <thead><tr>
              <th class="pc-rank"></th>
              <th class="sortable" data-k="label">Index</th>
              <th class="sortable num" data-k="oas_bps">OAS</th>
              <th class="sortable num" data-k="cheapZ">vs own history</th>
              <th></th>
              <th class="sortable num" data-k="spread_vol_bps">Spread vol</th>
              <th class="sortable num" data-k="carry_to_vol">Carry / vol</th>
              <th class="sortable num" data-k="chg_1m_bps">Δ1M</th>
              <th class="sortable num" data-k="chg_3m_bps">Δ3M</th>
              <th class="sortable num" data-k="chg_12m_bps">Δ12M</th>
              <th class="sortable num" data-k="carry_1m_pct">1M carry</th>
              <th class="num">Spread − EL</th>
              <th class="num">Driven by</th>
            </tr></thead>
            <tbody id="credit-body"></tbody>
          </table>
        </div>
        <div class="pc-note"><b>OAS</b> is the option-adjusted spread in basis points over governments — what the index pays you above the risk-free curve. <b>Carry / vol</b> divides that spread by the annualised volatility of the spread itself, so a higher number means more compensation per unit of the risk that the spread moves against you. <b>1M carry</b> is the mark-to-market return proxy from the spread's own move, −(Δ OAS ÷ 100) × spread duration 4.5. ${esc(o.ranking?.caution || "")}</div>
      </div>
    </div>

    <div class="col-12">
      <div class="pc-card pc-card-pad">
        <div class="pc-card-head">
          <div>
            <div class="pc-card-title">Sovereign book</div>
            <div class="pc-card-sub">10-year government yields ranked by how high the yield is against its own 126-month history.</div>
          </div>
          <input id="sov-search" class="pc-search" placeholder="Filter countries…" />
        </div>
        <div class="pc-table-wrap">
          <table class="pc-table">
            <thead><tr>
              <th class="pc-rank"></th>
              <th class="sortable" data-k="name">Country</th>
              <th class="sortable" data-k="region">Region</th>
              <th class="sortable num" data-k="yield_pct">10Y yield</th>
              <th class="sortable num" data-k="vs_us_10y_bps">vs US 10Y</th>
              <th class="sortable num" data-k="cheapZ">vs own history</th>
              <th></th>
              <th class="sortable num" data-k="real_yield_pct">Real yield</th>
              <th class="sortable num" data-k="inflation_pct">Inflation</th>
            </tr></thead>
            <tbody id="sov-body"></tbody>
          </table>
        </div>
        <div class="pc-note"><b>Real yield</b> subtracts the latest published World Bank consumer-price inflation from the nominal 10-year yield. That inflation print is annual and lags by one to two years, so the real-yield column is a slow structural read, not a live one — the year it comes from is shown next to it. Countries with no free 10-year series (China, Brazil, Indonesia, Turkey and others) are absent here by necessity and are scored on the map through their equity and credit legs instead.</div>
        ${o.unavailable?.length ? `<div class="pc-note" style="border-left-color:var(--amber)"><b>${o.unavailable.length} index${o.unavailable.length === 1 ? "" : "es"} unavailable right now:</b> ${o.unavailable.map((u) => esc(u.label)).join(", ")}.</div>` : ""}
      </div>
    </div>
  </div>`;

  /* ---------------- credit table ---------------- */
  const creditBody = root.querySelector("#credit-body");
  let famFilter = null;
  let cSort = { k: "cheapZ", dir: 1 };

  const sortRows = (rows, s) =>
    [...rows].sort((a, b) => {
      const x = a[s.k];
      const y = b[s.k];
      if (typeof x === "string" || typeof y === "string") return s.dir * String(x ?? "").localeCompare(String(y ?? ""));
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      return s.dir * (y - x);
    });

  const col = (v, d = 0, suffix = "") =>
    v == null
      ? `<span style="color:var(--text-faint)">—</span>`
      : `<span style="color:${v > 0 ? "var(--red)" : v < 0 ? "var(--green)" : "var(--text-secondary)"}">${v > 0 ? "+" : ""}${Number(v).toFixed(d)}${suffix}</span>`;

  /** expected loss and what the spread pays over it, where a grade maps */
  function elCell(id) {
    const g = elBy.get(id);
    if (!g || g.expected_loss_bps == null) return `<span style="color:var(--text-faint)">—</span>`;
    const net = g.net_of_expected_loss_bps;
    const c = net == null ? "var(--text-secondary)" : net >= 0 ? "var(--green)" : "var(--red)";
    return `<span style="color:${c}"><b>${net == null ? "—" : (net > 0 ? "+" : "") + net.toFixed(0)}</b></span>
      <div style="font-size:10.5px;color:var(--text-faint)">EL ${g.expected_loss_bps.toFixed(0)}${g.cover_ratio != null ? ` · ${g.cover_ratio.toFixed(2)}x` : ""}</div>`;
  }

  /** the largest external source of this series' forecast error */
  function driverCell(id) {
    const d = driverBy.get(id);
    if (!d) return `<span style="color:var(--text-faint)">—</span>`;
    return `<b>${esc(d.id)}</b> ${d.share == null ? "" : d.share.toFixed(0) + "%"}
      <div style="font-size:10.5px;color:var(--text-faint)">own ${d.own == null ? "—" : d.own.toFixed(0) + "%"}${d.r2 == null ? "" : ` · R² ${d.r2.toFixed(0)}%`}</div>`;
  }

  function drawCredit() {
    let rows = famFilter ? credit.filter((c) => c.family === famFilter) : credit;
    rows = sortRows(rows, cSort);
    creditBody.innerHTML = rows
      .map(
        (c, i) => `<tr>
        <td class="pc-rank">${i + 1}</td>
        <td><div style="font-weight:600">${esc(c.label)}</div>
            <div style="font-size:10.5px;color:var(--text-faint)">${esc(c.seriesId)} · ${esc(c.asOf)} · ${c.observations} obs</div></td>
        <td class="num"><b>${n2(c.oas_bps)}</b></td>
        <td class="num">${zBadge(c.cheapZ)}</td>
        <td style="width:74px">${zBar(c.cheapZ)}</td>
        <td class="num">${n2(c.spread_vol_bps)}</td>
        <td class="num"><b>${n3(c.carry_to_vol)}</b></td>
        <td class="num">${col(c.chg_1m_bps)}</td>
        <td class="num">${col(c.chg_3m_bps)}</td>
        <td class="num">${col(c.chg_12m_bps)}</td>
        <td class="num">${c.carry_1m_pct == null ? `<span style="color:var(--text-faint)">—</span>` : `<span style="color:${c.carry_1m_pct >= 0 ? "var(--green)" : "var(--red)"}">${c.carry_1m_pct > 0 ? "+" : ""}${c.carry_1m_pct.toFixed(2)}%</span>`}</td>
        <td class="num">${elCell(c.id)}</td>
        <td class="num">${driverCell(c.id)}</td>
      </tr>`
      )
      .join("");
  }

  const fams = [...new Set(credit.map((c) => c.family))];
  const famChips = root.querySelector("#fam-chips");
  famChips.innerHTML =
    `<button class="pc-chip active" data-f="">All</button>` +
    fams.map((f) => `<button class="pc-chip" data-f="${f}">${esc(FAMILY[f] || f)}</button>`).join("");
  famChips.querySelectorAll(".pc-chip").forEach((b) =>
    b.addEventListener("click", () => {
      famChips.querySelectorAll(".pc-chip").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      famFilter = b.dataset.f || null;
      drawCredit();
    })
  );

  /* ---------------- sovereign table ---------------- */
  const sovBody = root.querySelector("#sov-body");
  let sSort = { k: "cheapZ", dir: 1 };
  let sQuery = "";

  function drawSov() {
    let rows = sQuery
      ? sovereign.filter((s) => s.name.toLowerCase().includes(sQuery) || s.iso.toLowerCase() === sQuery)
      : sovereign;
    rows = sortRows(rows, sSort);
    sovBody.innerHTML = rows.length
      ? rows
          .map(
            (s, i) => `<tr class="country-row" data-iso="${s.iso}">
        <td class="pc-rank">${i + 1}</td>
        <td><div class="pc-flagname"><span class="pc-iso">${s.iso}</span><b>${esc(s.name)}</b></div></td>
        <td style="color:var(--text-secondary)">${esc(s.region)}</td>
        <td class="num"><b>${n3(s.yield_pct)}%</b></td>
        <td class="num">${signed(s.vs_us_10y_bps)}</td>
        <td class="num">${zBadge(s.cheapZ)}</td>
        <td style="width:74px">${zBar(s.cheapZ)}</td>
        <td class="num">${s.real_yield_pct == null ? `<span style="color:var(--text-faint)">—</span>` : `<span style="color:${s.real_yield_pct >= 0 ? "var(--green)" : "var(--red)"}">${n2(s.real_yield_pct)}%</span>`}</td>
        <td class="num">${s.inflation_pct == null ? `<span style="color:var(--text-faint)">—</span>` : `${n2(s.inflation_pct)}% <span style="color:var(--text-faint);font-size:10.5px">'${String(s.inflation_year).slice(2)}</span>`}</td>
      </tr>`
          )
          .join("")
      : `<tr><td colspan="9"><div class="pc-empty">No country matches that filter.</div></td></tr>`;
    sovBody.querySelectorAll(".country-row").forEach((el) =>
      el.addEventListener("click", () => (location.hash = `#/country/${el.dataset.iso}`))
    );
  }

  root.querySelector("#sov-search").addEventListener("input", (e) => {
    sQuery = e.target.value.trim().toLowerCase();
    drawSov();
  });

  root.querySelectorAll("#credit-body").forEach(() => {});
  root.querySelectorAll("th.sortable").forEach((th) => {
    const inCredit = th.closest("table").querySelector("tbody").id === "credit-body";
    th.addEventListener("click", () => {
      const s = inCredit ? cSort : sSort;
      if (s.k === th.dataset.k) s.dir *= -1;
      else {
        s.k = th.dataset.k;
        s.dir = 1;
      }
      inCredit ? drawCredit() : drawSov();
    });
  });

  drawCredit();
  drawSov();
  return { dispose() {} };
}
