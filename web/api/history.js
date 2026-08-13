/**
 * GET /api/history — real 15y+ history series (no extrapolation).
 *
 * Modes:
 *   /api/history?market=us            -> per-grade OAS (weekly) + defaults
 *   /api/history?country=DE           -> 20y monthly 10Y (OECD/ECB)
 *   /api/history?kind=curve           -> US nominal curve 2/5/10/30 (weekly)
 */
import { fredCsv, ecbCsv, json, unavailable } from "./_shared.js";

export const config = { runtime: "nodejs" };

const GRADES = {
  AAA: { id: "BAMLC0A1CAAA", standsFor: "Investment-grade AAA spread — ICE BofA US Corporate Index OAS" },
  AA: { id: "BAMLC0A2CAA", standsFor: "Investment-grade AA spread — ICE BofA US Corporate Index OAS" },
  A: { id: "BAMLC0A3CA", standsFor: "Investment-grade A spread — ICE BofA US Corporate Index OAS" },
  BBB: { id: "BAMLC0A4CBBB", standsFor: "Investment-grade BBB spread — ICE BofA US Corporate Index OAS" },
  BB: { id: "BAMLH0A0HYM2", standsFor: "High-yield BB spread — ICE BofA US High Yield Index OAS" },
  B: { id: "BAMLH0A2HYB", standsFor: "High-yield B spread — ICE BofA US High Yield Index OAS" },
  CCC: { id: "BAMLH0A3HYC", standsFor: "High-yield CCC spread — ICE BofA US High Yield Index OAS" },
};
const DEFAULTS = {
  DR_IG: { id: "DRBLACBS", standsFor: "12-month trailing default rate — investment grade (Moody's, quarterly)" },
  DR_HY: { id: "DRCCLACBS", standsFor: "12-month trailing default rate — speculative grade (Moody's, quarterly)" },
};
const CURVE = { DGS2: "US 2-year Treasury yield (FRED, daily)", DGS5: "US 5-year Treasury yield", DGS10: "US 10-year Treasury yield", DGS30: "US 30-year Treasury yield" };
const OECD_COUNTRIES = {
  US: "United States", GB: "United Kingdom", JP: "Japan", AU: "Australia",
  CA: "Canada", FR: "France", DE: "Germany", IT: "Italy", ES: "Spain",
  NL: "Netherlands", BE: "Belgium", AT: "Austria", PT: "Portugal",
  IE: "Ireland", CH: "Switzerland", SE: "Sweden", NO: "Norway", DK: "Denmark",
  FI: "Finland", GR: "Greece", IL: "Israel", KR: "South Korea", NZ: "New Zealand",
  MX: "Mexico", CL: "Chile", ZA: "South Africa", PL: "Poland", CZ: "Czechia",
  HU: "Hungary", SK: "Slovakia", SI: "Slovenia",
};

function weekly(rows) {
  // downsample daily -> weekly (last observation of each ISO week) to keep
  // the payload small; 15y weekly ~ 780 pts per series
  const byW = new Map();
  for (const r of rows) {
    const d = new Date(r.date + "T00:00:00Z");
    const week = d.toISOString().slice(0, 7) + "-" + Math.floor(d.getUTCDate() / 7);
    byW.set(week, r);
  }
  return [...byW.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export default async function handler(req, res) {
  const url = new URL(req.url, "http://x");
  const country = url.searchParams.get("country");
  const market = url.searchParams.get("market");
  const kind = url.searchParams.get("kind") || "oas";

  if (country) {
    const iso = country.toUpperCase();
    let rows = null;
    const fred = await fredCsv(`IRLTLT01${iso}M156N`, { start: "2005-01-01" });
    if (!fred.unavailable) rows = fred.rows;
    let source = `FRED IRLTLT01${iso}M156N (OECD long-term rate)`;
    if (!rows && ["DE", "FR", "IT", "ES", "NL", "BE", "AT", "PT", "IE", "FI", "GR"].includes(iso)) {
      const ecb = await ecbCsv(`IRS/M.${iso}.L.L40.CI.0000.EUR.N.Z`, { start: "2005-01-01" });
      if (!ecb.unavailable) {
        rows = ecb.rows;
        source = `ECB LTIR ${iso} (monthly, ~35y history)`;
      }
    }
    if (!rows || !rows.length) {
      return unavailable(res, `No 10-year series for ${iso} (FRED key unset or series unavailable) — try a euro-area country (DE FR IT ES NL BE AT PT IE FI GR) which also works keyless via ECB`);
    }
    return json(res, {
      status: "OK",
      name: OECD_COUNTRIES[iso] || iso,
      iso,
      source,
      start: rows[0].date,
      end: rows[rows.length - 1].date,
      frequency: "monthly",
      series: rows.map((r) => [r.date, r.v]),
    });
  }

  if (kind === "defaults") {
    const series = {};
    for (const [k, v] of Object.entries(DEFAULTS)) {
      const r = await fredCsv(v.id, { start: "2005-01-01" });
      if (r.rows) series[k] = { standsFor: v.standsFor, points: r.rows.map((x) => [x.date, x.v]) };
    }
    if (!Object.keys(series).length) return unavailable(res, "FRED_API_KEY not configured — default-rate history needs the FRED key");
    return json(res, { status: "OK", kind: "defaults", series });
  }

  if (kind === "curve") {
    const series = {};
    for (const [id, standsFor] of Object.entries(CURVE)) {
      const r = await fredCsv(id, { start: "2005-01-01" });
      if (r.rows) series[id] = { standsFor, points: weekly(r.rows).map((x) => [x.date, x.v]) };
    }
    if (!Object.keys(series).length) return unavailable(res, "FRED_API_KEY not configured — US curve needs the FRED key");
    return json(res, { status: "OK", kind: "curve", series });
  }

  // default: US per-grade OAS
  const series = {};
  for (const [g, v] of Object.entries(GRADES)) {
    const r = await fredCsv(v.id, { start: "2005-01-01" });
    if (r.rows) {
      series[g] = { standsFor: v.standsFor, points: weekly(r.rows).map((x) => [x.date, x.v * 100]), unit: "bps" };
    }
  }
  const d = await fredCsv("DRCCLACBS", { start: "2005-01-01" });
  if (d.rows) series.DR_HY = { standsFor: DEFAULTS.DR_HY.standsFor, points: d.rows.map((x) => [x.date, x.v]), unit: "pct" };
  if (!Object.keys(series).length) return unavailable(res, "FRED_API_KEY not configured — OAS history needs the FRED key");
  return json(res, { status: "OK", kind: "oas", series });
}