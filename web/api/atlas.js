/**
 * GET /api/atlas — live opportunity map (mirrors data/atlas.json schema).
 * All formulas ported from engine/atlas.py: yield changes, z (126m window,
 * 24m min), bond price proxy (duration 8.5), CDS proxy (vs US 10Y), equity
 * ETF leg (per-country symbols), heat = mean of available 1m price-return
 * proxies, region rollup = unweighted mean. Honest UNAVAILABLE legs.
 */
import {
  fredCsv,
  ecbCsv,
  yahooChart,
  json,
  unavailable,
  UA,
} from "./_shared.js";

export const config = {
  runtime: "nodejs",
};

const ATLAS_COUNTRY_YIELDS = {
  US: "IRLTLT01USM156N", DE: "IRLTLT01DEM156N", FR: "IRLTLT01FRM156N",
  IT: "IRLTLT01ITM156N", ES: "IRLTLT01ESM156N", GB: "IRLTLT01GBM156N",
  JP: "IRLTLT01JPM156N", CA: "IRLTLT01CAM156N", CH: "IRLTLT01CHM156N",
  AU: "IRLTLT01AUM156N", NL: "IRLTLT01NLM156N", KR: "IRLTLT01KRM156N",
  MX: "IRLTLT01MXM156N", ZA: "IRLTLT01ZAM156N",
};
const ATLAS_REGIONS = {
  US: "americas", CA: "americas", MX: "americas",
  GB: "europe", DE: "europe", FR: "europe", IT: "europe", ES: "europe",
  NL: "europe", CH: "europe", EZ: "europe",
  JP: "asia", KR: "asia", AU: "apac", ZA: "africa",
};
const ATLAS_COUNTRY_ETFS = {
  DE: "EWG", FR: "EWQ", IT: "EWI", ES: "EWP", NL: "EWN", GB: "EWU",
  JP: "EWJ", KR: "EWY", AU: "EWA", CA: "EWC", MX: "EWW", ZA: "EZA",
  US: "SPY", CH: "EWL", EZ: "EZU",
};
const COUNTRY_NAMES = {
  US: "United States", DE: "Germany", FR: "France", IT: "Italy",
  ES: "Spain", GB: "United Kingdom", JP: "Japan", CA: "Canada",
  CH: "Switzerland", AU: "Australia", NL: "Netherlands", KR: "South Korea",
  MX: "Mexico", ZA: "South Africa", EZ: "Euro Area",
};
const DURATION = 8.5; // DEFAULT_DURATION (engine/atlas.py:21)
const Z_WINDOW = 126; // ~10 years of monthly observations
const Z_MIN = 24; // >= 2 years before a z-score is reported

const rowsOf = (r) => (r.rows ? r.rows : []);
const lastOf = (rows) => (rows.length ? rows[rows.length - 1].v : null);
const pctToBps = (v) => (v == null ? null : Math.round(v * 100 * 100) / 100);

function yieldChangesBps(rows, horizons = [1, 3, 12]) {
  if (!rows.length) return { status: "UNAVAILABLE" };
  const last = rows[rows.length - 1];
  const byDate = new Map(rows.map((r) => [r.date, r.v]));
  const out = {};
  let ok = false;
  for (const h of horizons) {
    const i = rows.length - 1 - h;
    if (i >= 0 && rows[i]) {
      out[h] = pctToBps(last.v - rows[i].v);
      ok = true;
    }
  }
  return ok ? out : { status: "UNAVAILABLE" };
}

function rollingZLast(rows) {
  if (rows.length < Z_MIN) return null;
  const clean = rows.slice(-Z_WINDOW);
  const vals = clean.map((r) => r.v);
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
  if (!Number.isFinite(sd) || sd <= 0) return null;
  const last = vals[vals.length - 1];
  return Math.round(((last - mean) / sd) * 1000) / 1000;
}

async function equityLeg(symbol) {
  if (!symbol) return { status: "UNAVAILABLE" };
  const r = await yahooChart(symbol, { range: "1y", interval: "1d" });
  if (r.unavailable) return { status: "UNAVAILABLE" };
  const rows = r.rows;
  const closes = rows.map((x) => x.v);
  const oneMonth = closes.length - 21;
  const threeMonth = closes.length - 63;
  const twelveMonth = closes.length - 252;
  const pct = (a, b) =>
    a >= 0 && Number.isFinite(closes[a]) && Number.isFinite(closes[b]) && closes[a] > 0
      ? Math.round((closes[b] / closes[a] - 1) * 10000) / 100
      : null;
  return {
    status: "OK",
    label: symbol,
    ret_1m_pct: pct(oneMonth, closes.length - 1),
    ret_3m_pct: pct(threeMonth, closes.length - 1),
    ret_12m_pct: pct(twelveMonth, closes.length - 1),
  };
}

export default async function handler(req, res) {
  const out = { status: "OK", generated: new Date().toISOString(), schema: "atlas.v1", countries: {}, regions: {} };
  const us10 = await fredCsv("DGS10", { start: "2023-01-01" });
  const usRows = rowsOf(us10); // daily; last value = US 10Y
  let us10Pct = lastOf(usRows);

  for (const [iso, seriesId] of Object.entries(ATLAS_COUNTRY_YIELDS)) {
    let rows = [];
    if (seriesId === "DGS10") {
      rows = usRows;
    } else {
      const r = await fredCsv(seriesId, { start: "2005-01-01" });
      rows = rowsOf(r);
    }
    if (!rows.length) {
      out.countries[iso] = {
        name: COUNTRY_NAMES[iso], iso, region: ATLAS_REGIONS[iso],
        heat: null,
        instruments: { bonds: { status: "UNAVAILABLE" } },
        note: "FRED long-term rate unavailable (API key missing or series error)",
      };
      continue;
    }
    // de-dup + monthly alignment (FRED OECD is monthly already; DGS10 daily)
    if (seriesId === "DGS10") {
      const byM = new Map();
      for (const r of rows) {
        const m = r.date.slice(0, 7);
        byM.set(m, r); // last of month wins
      }
      rows = [...byM.values()].sort((a, b) => a.date.localeCompare(b.date));
      us10Pct = us10Pct ?? lastOf(rows);
    }
    const yieldPct = lastOf(rows);
    const changes = yieldChangesBps(rows);
    const yieldZ = rollingZLast(rows);
    const bond1m = changes[1] != null ? Math.round(-(changes[1] / 100) * DURATION * 1000) / 1000 : null;
    const etf = await equityLeg(ATLAS_COUNTRY_ETFS[iso]);
    const cds = us10Pct != null && yieldPct != null
      ? { status: "proxy", note: "10Y yield minus US 10Y (no free CDS source)", sovereign_spread_bps: Math.round((yieldPct - us10Pct) * 10000) / 100 }
      : { status: "UNAVAILABLE" };
    const heatVals = [bond1m, etf.ret_1m_pct].filter((v) => v != null);
    const heat = heatVals.length ? Math.round((heatVals.reduce((a, b) => a + b, 0) / heatVals.length) * 1000) / 1000 : null;

    out.countries[iso] = {
      name: COUNTRY_NAMES[iso],
      iso,
      region: ATLAS_REGIONS[iso],
      heat,
      instruments: {
        bonds: {
          notes: "10Y OECD long-term government yield (FRED, monthly)",
          yield_pct: yieldPct,
          yield_chg_bps: changes[1] != null ? changes : { status: "UNAVAILABLE" },
          yield_z: yieldZ,
          bond_price_1m_pct: bond1m,
        },
        cds,
        equity_etf: etf,
        yield_spreads: cds.status === "proxy"
          ? { vs_us_10y_bps: cds.sovereign_spread_bps, vs_us_10y_z: null }
          : { status: "UNAVAILABLE" },
      },
    };
  }

  // EZ via ECB (keyless): euro-area AAA 10Y curve
  const ez = await ecbCsv("YC/B.U2.EUR.4F.G_N_A.SV_C_YM.SR_10Y", { start: "2005-01-01" });
  if (!ez.unavailable) {
    const rows = ez.rows;
    const yieldPct = lastOf(rows);
    const changes = yieldChangesBps(rows);
    const bond1m = changes[1] != null ? Math.round(-(changes[1] / 100) * DURATION * 1000) / 1000 : null;
    const etf = await equityLeg("EZU");
    const heatVals = [bond1m, etf.ret_1m_pct].filter((v) => v != null);
    out.countries.EZ = {
      name: "Euro Area",
      iso: "EZ",
      region: "europe",
      heat: heatVals.length ? Math.round((heatVals.reduce((a, b) => a + b, 0) / heatVals.length) * 1000) / 1000 : null,
      instruments: {
        bonds: {
          notes: "ECB euro-area AAA 10Y government curve (SDW, monthly)",
          yield_pct: yieldPct,
          yield_chg_bps: changes[1] != null ? changes : { status: "UNAVAILABLE" },
          yield_z: rollingZLast(rows),
          bond_price_1m_pct: bond1m,
        },
        cds: us10Pct != null && yieldPct != null
          ? { status: "proxy", note: "10Y yield minus US 10Y (no free CDS source)", sovereign_spread_bps: Math.round((yieldPct - us10Pct) * 10000) / 100 }
          : { status: "UNAVAILABLE" },
        equity_etf: etf,
        yield_spreads: { status: "UNAVAILABLE" },
      },
    };
  }

  // region rollup: unweighted mean of member-country heats that exist
  const buckets = {};
  for (const [iso, node] of Object.entries(out.countries)) {
    const region = node.region;
    if (region == null || node.heat == null) continue;
    (buckets[region] = buckets[region] || []).push(node.heat);
  }
  for (const [region, vals] of Object.entries(buckets)) {
    out.regions[region] = Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 1000) / 1000;
  }

  json(res, out);
}