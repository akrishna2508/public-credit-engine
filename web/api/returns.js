/**
 * GET /api/returns?market=us|eu|em|countries&mode=pure|spread
 *
 * Live hold-horizon return curves, ported from engine/volatility.py
 * return_curve(): gross = mean |T-day move| on shock days (rolling 21d RV >=
 * 90th percentile — the GARCH_SIGNAL_PERCENTILE approximation, labeled),
 * fee = empirical expected |T-day move| (rolling 90d mean, shifted by T —
 * no look-ahead), net = gross - fee*markup - friction. Edge = annualized net
 * at holdMax; the frontend compounds it out to 15 years with an explicit
 * "extrapolated, not a forecast" label.
 */
import {
  fredCsv,
  yahooChart,
  yahooAtmIv,
  ecbCsv,
  returnCurve,
  toBps,
  json,
} from "./_shared.js";

export const config = { runtime: "nodejs" };

const GRADES = {
  AAA: { id: "BAMLC0A1CAAA", standsFor: "Investment-grade AAA corporate bond option-adjusted spread (ICE BofA)" },
  AA: { id: "BAMLC0A2CAA", standsFor: "Investment-grade AA corporate bond option-adjusted spread (ICE BofA)" },
  A: { id: "BAMLC0A3CA", standsFor: "Investment-grade A corporate bond option-adjusted spread (ICE BofA)" },
  BBB: { id: "BAMLC0A4CBBB", standsFor: "Investment-grade BBB corporate bond option-adjusted spread (ICE BofA)" },
  BB: { id: "BAMLH0A0HYM2", standsFor: "High-yield BB corporate bond option-adjusted spread (ICE BofA)" },
  B: { id: "BAMLH0A2HYB", standsFor: "High-yield B corporate bond option-adjusted spread (ICE BofA)" },
  CCC: { id: "BAMLH0A3HYC", standsFor: "High-yield CCC corporate bond option-adjusted spread (ICE BofA)" },
};
const GRADES_ORDER = ["AAA", "AA", "A", "BBB", "BB", "B", "CCC"];
const US_PAIRS = [
  ["AA", "AAA", "AA − AAA — long high-grade AA vs short AAA spread"],
  ["A", "AA", "A − AA — long A vs short AA spread"],
  ["BBB", "A", "BBB − A — long BBB vs short A spread"],
  ["BB", "BBB", "BB − BBB — long high-yield BB vs short IG BBB spread"],
  ["B", "BB", "B − BB — long B vs short BB spread"],
  ["CCC", "B", "CCC − B — long CCC vs short B spread"],
  ["BB", "Fallen_Angel", "BB − Fallen_Angel — long BB vs short fallen-angel spread"],
];

const ETF_ASSETS = {
  ANGL: "Fallen Angel — bonds downgraded from investment grade to high yield (VanEck ANGL ETF)",
  IEACL: "Euro investment-grade corporate bonds (iShares Core EUR Corp Bond IEAC.L ETF)",
  IHYGL: "Euro high-yield corporate bonds (iShares EUR High Yield IHYG.L ETF)",
  EMB: "EM US-dollar sovereign bonds (iShares J.P. Morgan USD EM Bond EMB ETF)",
  CEMB: "EM US-dollar corporate bonds (iShares J.P. Morgan EM Corporate CEMB ETF)",
  EMHY: "EM high-yield bonds (iShares J.P. Morgan EM High Yield EMHY ETF)",
  LEMB: "EM local-currency bonds (iShares J.P. Morgan EM Local Currency LEMB ETF)",
};
const ETF_SYMBOLS = {
  ANGL: "ANGL", IEACL: "IEAC.L", IHYGL: "IHYG.L",
  EMB: "EMB", CEMB: "CEMB", EMHY: "EMHY", LEMB: "LEMB",
};

const EM_PAIRS = [
  ["CEMB", "EMB", "EM_Corporate − EM_USD_Sovereign — long EM corporate vs short EM sovereign"],
  ["EMHY", "CEMB", "EM_High_Yield − EM_Corporate — long EM high yield vs short EM corporate"],
  ["LEMB", "EMHY", "EM_Local_Currency − EM_High_Yield — long EM local currency vs short EM HY"],
];

const ECB_LTIR = {
  DE: "Germany — Bund long-term (10Y) interest rate (ECB LTIR)", FI: "Finland — 10Y rate (ECB LTIR)",
  FR: "France — 10Y OAT rate (ECB LTIR)", IT: "Italy — 10Y BTP rate (ECB LTIR)",
  ES: "Spain — 10Y Bonos rate (ECB LTIR)", NL: "Netherlands — 10Y DSL rate (ECB LTIR)",
  BE: "Belgium — 10Y OLO rate (ECB LTIR)", AT: "Austria — 10Y rate (ECB LTIR)",
  PT: "Portugal — 10Y rate (ECB LTIR)", IE: "Ireland — 10Y rate (ECB LTIR)",
  GR: "Greece — 10Y rate (ECB LTIR)",
};

async function seriesFromFred(seriesId) {
  const r = await fredCsv(seriesId, { start: "2010-01-01" });
  return r.rows || null;
}

async function etfSeries(symbol) {
  const r = await yahooChart(symbol, { range: "15y", interval: "1d" });
  return r.rows || null;
}

function diffBps(a, b) {
  // both percent -> bps; aligned by date
  const bm = new Map(b.map((x) => [x.date, x.v]));
  const out = [];
  for (const x of a) {
    const y = bm.get(x.date);
    if (y != null) out.push({ date: x.date, v: (x.v - y) * 100 });
  }
  return out;
}

async function buildAsset(name, seriesBps, { standsFor, unit = "days", holdMax = 21, atmIv = null }) {
  const curve = returnCurve(seriesBps, { holdMax, atmIv, name, unit });
  if (!curve) {
    return { id: name, name, standsFor, unit, unavailable: "insufficient history on this deployment", curves: [], edge: null };
  }
  return {
    id: name,
    name,
    standsFor,
    unit,
    holdMax,
    curves: curve.rows.map((r) => [r.T, r.gross, r.hf, r.ret]),
    edge: curve.edge,
    markupNote: curve.markupNote,
    asOf: null,
  };
}

export default async function handler(req, res) {
  const url = new URL(req.url, "http://x");
  const market = url.searchParams.get("market") || "us";
  const mode = url.searchParams.get("mode") || "pure";
  const out = {
    status: "OK",
    generated: new Date().toISOString(),
    label: "Extrapolated from live hold-horizon curves — not a forecast",
    approximations: [
      "Shock days = rolling 21-day realized vol at the 90th percentile (engine uses a GARCH fit at the same 90th percentile; the pure-vol mask is the site's documented approximation)",
      "Dealer markup: 30% share of the IV-RV premium over parity with a 1.05 floor, from live ATM IV where a listed options chain exists; otherwise the 1.05 floor",
      "Extrapolation compounds the net edge measured at the longest evaluated hold horizon (21 days / 12 months)",
    ],
    markets: {},
  };

  const markets = {};
  if (market === "us" || market === "all") {
    const gradeSeries = {};
    for (const g of GRADES_ORDER) {
      gradeSeries[g] = await seriesFromFred(GRADES[g].id);
    }
    let anglBps = null;
    let anglIv = null;
    const angRows = await etfSeries("ANGL");
    if (angRows && angRows.length) {
      anglBps = toBps(angRows);
      const iv = await yahooAtmIv("ANGL");
      anglIv = iv.atmIv || null;
    }
    const pure = [];
    const spread = [];
    for (const g of GRADES_ORDER) {
      const rows = gradeSeries[g];
      if (!rows) continue;
      pure.push(await buildAsset(g, toBps(rows), { standsFor: GRADES[g].standsFor }));
    }
    if (anglBps) {
      pure.push(await buildAsset("Fallen_Angel", anglBps, {
        standsFor: ETF_ASSETS.ANGL, atmIv: anglIv,
      }));
    }
    if (market === "us" || market === "all") {
      for (const [g, h, label] of US_PAIRS) {
        const a = gradeSeries[g];
        let pair = null;
        if (a && h === "Fallen_Angel" && anglBps) {
          pair = diffBps(a, angRows);
        } else if (a && gradeSeries[h]) {
          pair = diffBps(a, gradeSeries[h]);
        }
        if (!pair || !pair.length) continue;
        spread.push(await buildAsset(label.split(" — ")[0], pair.map((r) => r.v), {
          standsFor: label,
        }));
      }
    }
    markets.us = { pure, spread };
  }

  if (market === "eu" || market === "all") {
    const pure = [];
    const spread = [];
    const ieac = await etfSeries("IEAC.L");
    const ihyg = await etfSeries("IHYG.L");
    if (ieac) pure.push(await buildAsset("EUR_IG", toBps(ieac), { standsFor: ETF_ASSETS.IEACL }));
    if (ihyg) pure.push(await buildAsset("EUR_HY", toBps(ihyg), { standsFor: ETF_ASSETS.IHYGL }));
    if (ieac && ihyg) {
      const pair = diffBps(ihyg, ieac);
      spread.push(await buildAsset("EUR_HY − EUR_IG", pair.map((r) => r.v), {
        standsFor: "EUR_HY − EUR_IG — long euro high yield vs short euro IG spread",
      }));
    }
    markets.eu = { pure, spread };
  }

  if (market === "em" || market === "all") {
    const pure = [];
    const spread = [];
    const rows = {};
    for (const k of Object.keys(ETF_SYMBOLS)) {
      if (k === "ANGL") continue;
      const s = await etfSeries(ETF_SYMBOLS[k]);
      if (s) rows[k] = s;
    }
    const emOrder = ["EMB", "CEMB", "EMHY", "LEMB"];
    for (const k of emOrder) {
      if (!rows[k]) continue;
      pure.push(await buildAsset(k === "EMB" ? "EM_USD_Sovereign" : k === "CEMB" ? "EM_Corporate" : k === "EMHY" ? "EM_High_Yield" : "EM_Local_Currency", toBps(rows[k]), {
        standsFor: ETF_ASSETS[k],
      }));
    }
    for (const [a, b, label] of EM_PAIRS) {
      if (!rows[a] || !rows[b]) continue;
      const pair = diffBps(rows[a], rows[b]);
      spread.push(await buildAsset(label.split(" — ")[0], pair.map((r) => r.v), { standsFor: label }));
    }
    markets.em = { pure, spread };
  }

  if (market === "countries" || market === "all") {
    const pure = [];
    for (const [iso, standsFor] of Object.entries(ECB_LTIR)) {
      const r = await ecbCsv(`IRS/M.${iso}.L.L40.CI.0000.EUR.N.Z`, { start: "2010-01-01" });
      if (r.unavailable || !r.rows || r.rows.length < 120) continue;
      pure.push(await buildAsset(iso, r.rows.map((x) => x.v * 100), {
        standsFor, unit: "months", holdMax: 12,
      }));
    }
    markets.countries = { pure, spread: [] };
  }

  out.markets = markets;
  if (market !== "all" && !out.markets[market]) {
    out.status = "UNAVAILABLE";
    out.why = `unknown market '${market}'`;
  }
  json(res, out);
}