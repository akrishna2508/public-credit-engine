/**
 * GET /api/returns?market=us|eu|em|countries&basis=hold|vol
 *
 * Both books are forecasts. A VAR is fitted to the observable panel — credit
 * spreads, government yields, log prices — and iterated forward; the payout
 * is then computed along that forecast path.
 *
 *   basis=hold  accrued carry, marked to the forecast level:
 *               return(m) = carry - duration x (level_m - level_0)
 *
 *   basis=vol   ONE at-the-money straddle opened now and marked to market
 *               monthly to expiry: Bachelier value against the VAR's forecast
 *               of the underlying, less the dealer premium, financing on that
 *               premium at the short rate, and a round trip of friction
 *
 * Nothing here compounds a constant. The previous projection took one
 * annualised edge and raised it to the power of the horizon, which is
 * monotone by construction and cannot bend, peak or disagree with itself.
 *
 * The horizon is derived per panel from the fitted model's stability, not
 * fixed at fifteen years — see _forecastpath.js for the measurements.
 */
import {
  fredCsv, yahooChart, yahooAtmIv, ecbCsv, json, pmap, worldBank,
  toBps, logPriceBps, tradeCostBasis, cachedJson, CACHE_TTL,
  SPREAD_DURATION, BOND_DURATION, PRICE_SCALE,
} from "./_shared.js";
import {
  buildForecast, combinationSamples, combinationLevel0, weightFor, stepSdFor,
  simulateCombination, summarisePaths, holdPathsFromSims, straddlePathsFromSims,
} from "./_forecastpath.js";
import {
  RATING_ORDER, US_GRADES, DR_SERIES, DR_MAPPING, ADJACENT_PAIRS,
  expectedLossByGrade, CREDIT_PANEL, COUNTRIES, WB_INDICATORS,
} from "./_universe.js";

export const config = { runtime: "nodejs" };

const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
const asMap = (rows) => Object.fromEntries(rows.map((r) => [r.date, r.v]));

const ETF_ASSETS = {
  ANGL: { symbol: "ANGL", label: "Fallen angels — VanEck ANGL" },
  IEACL: { symbol: "IEAC.L", label: "Euro investment-grade corporates — iShares IEAC.L" },
  IHYGL: { symbol: "IHYG.L", label: "Euro high yield — iShares IHYG.L" },
  EMB: { symbol: "EMB", label: "EM US-dollar sovereigns — iShares EMB" },
  CEMB: { symbol: "CEMB", label: "EM US-dollar corporates — iShares CEMB" },
  EMHY: { symbol: "EMHY", label: "EM high yield — iShares EMHY" },
  LEMB: { symbol: "LEMB", label: "EM local currency — iShares LEMB" },
  EM1ADE: { symbol: "EM1A.DE", label: "Fallen angels — VanEck EM1A.DE (EUR-quoted UCITS)" },
  GFA: { symbol: "GFA.L", label: "Fallen angels — VanEck GFA.L (GBP-quoted global UCITS)" },
};

const ECB_LTIR = {
  DE: "Germany 10Y Bund", FI: "Finland 10Y", FR: "France 10Y OAT", IT: "Italy 10Y BTP",
  ES: "Spain 10Y Bonos", NL: "Netherlands 10Y DSL", BE: "Belgium 10Y OLO", AT: "Austria 10Y",
  PT: "Portugal 10Y", IE: "Ireland 10Y", GR: "Greece 10Y",
};

/** an asset the projection chart can draw, or an honest gap */
function asset(id, name, standsFor, path, extra = {}) {
  if (!path || path.length < 2) {
    return { id, name, standsFor, unavailable: extra.why || "no forecast path", path: [] };
  }
  return { id, name, standsFor, path, ...extra };
}

/**
 * Where the forecast return peaks — the point past which holding costs more
 * than it earns. Only reported when the peak is strictly interior: a maximum
 * at the last sample means the path is still rising when the model runs out
 * of horizon, and one at the first means it only ever falls. Neither is a
 * turning point, and calling either one a sell date would be reading a
 * signal into the edge of the window.
 */
function peakOf(path, key) {
  let bi = -1;
  let bv = -Infinity;
  for (let i = 0; i < path.length; i++) {
    const v = path[i][key];
    if (Number.isFinite(v) && v > bv) { bv = v; bi = i; }
  }
  if (bi <= 0 || bi >= path.length - 1) return null;
  return { date: path[bi].date, months: bi + 1, value: r2(bv) };
}


/**
 * How many futures to simulate. Every book is cached for six hours, so the
 * cost is paid once. 1,500 paths keeps the MEDIAN clean — at 400 it wandered
 * with about 47 direction changes per sovereign over ten years, which is
 * sampling noise wearing the costume of signal. The fluctuation belongs in
 * the scenario line, which is one real future; the median should be a steady
 * central estimate and the band should be smooth enough to read.
 */
const NSIMS = 1500;
/** fixed so the same panel always returns the same futures — a chart that
 *  reshuffled on every reload would be unreadable, and the cache would lie */
const SIM_SEED = 20260815;

/**
 * Simulate once, then summarise several cost tiers off the SAME set of
 * futures. Sharing the paths matters: gross, HF and retail must differ only
 * by their costs, and drawing them separately would let the tiers cross for
 * no reason but sampling noise.
 *
 * Each tier gets its median, a 10-90 band, and one scenario path carried
 * through untouched — a single future with its month-to-month fluctuation
 * intact, which no percentile can show, because a pointwise quantile blends
 * paths that never coexisted.
 */
function simRows(fc, w, months, tiers) {
  const sims = simulateCombination(fc, w, { nSims: NSIMS, months, seed: SIM_SEED });
  if (!sims || !sims.length || !sims[0].length) return null;
  const n = sims[0].length;
  // one date per SIMULATED STEP — business days on a daily panel, months on a
  // monthly one — so the path carries every shock the VAR generated
  const dates = fc.stepDates.slice(0, n);
  if (dates.length < n) return null;
  const out = dates.map((d) => ({ date: d, level: null }));
  let first = true;
  for (const [key, build] of Object.entries(tiers)) {
    const sum = summarisePaths(build(sims), dates, sims, 0);
    sum.forEach((r, i) => {
      if (first) out[i].level = r.level;
      out[i][key] = r.ret;
      out[i][`${key}_lo`] = r.lo;
      out[i][`${key}_hi`] = r.hi;
      out[i][`${key}_scn`] = r.scenario;
    });
    first = false;
  }
  return out;
}

/* ==================================================================== */
/* buy and hold                                                          */
/* ==================================================================== */

async function buildHoldBook(market) {
  const markets = {};
  const models = {};

  if (market === "us" || market === "all") {
    const oasList = await pmap(RATING_ORDER, 4, (g) => fredCsv(US_GRADES[g].id, { start: "2010-01-01" }));
    const seriesMap = {};
    const cols = [];
    RATING_ORDER.forEach((g, i) => {
      const r = oasList[i];
      if (r && !r.unavailable && r.rows?.length) { seriesMap[g] = asMap(r.rows); cols.push(g); }
    });

    const drKeys = Object.keys(DR_SERIES);
    const drRes = await pmap(drKeys, 2, (k) => fredCsv(DR_SERIES[k], { start: "2010-01-01" }));
    const drLatest = {};
    drKeys.forEach((k, i) => {
      const rr = drRes[i];
      const rows = rr && !rr.unavailable ? rr.rows : null;
      drLatest[k] = rows?.length ? { v: rows[rows.length - 1].v / 100 } : null;
    });
    const elBps = expectedLossByGrade(drLatest, { asBps: true });

    const fc = buildForecast(cols, seriesMap, { freq: "days", scale: 100, floorAt: 0 });
    const pure = [];
    if (fc.ok) {
      models.us = { lag: fc.lag, nobs: fc.nobs, rho: r2(fc.rho), stable: fc.stable, horizonMonths: fc.horizonMonths, why: fc.why };
      cols.forEach((g, k) => {
        const level0 = fc.last[k];
        const el = elBps[g];
        const w = weightFor(fc.fit.K, k);
        // expected loss is an annual charge, accrued along each simulated path
        const rows = simRows(fc, w, null, {
          ret: (sims) => holdPathsFromSims(sims, level0, SPREAD_DURATION, null, FREQ_PER_YEAR[fc.freq]),
          net: (sims) => holdPathsFromSims(sims, level0, SPREAD_DURATION, el, FREQ_PER_YEAR[fc.freq]),
        });
        if (!rows) return;
        pure.push(
          asset(g, g, `${US_GRADES[g].label}, ${SPREAD_DURATION}-year spread duration`, rows, {
            level0: r2(level0),
            expected_loss_bps: el,
            peak: peakOf(rows, el == null ? "ret" : "net"),
          })
        );
      });
    }
    markets.us = { pure, spread: [] };
    if (!fc.ok) models.us = { why: fc.why };
  }

  if (market === "em" || market === "eu" || market === "all") {
    const wanted = market === "eu"
      ? ["EM_EUR"]
      : ["EM_CORP", "EM_ASIA", "EM_LATAM", "EM_EMEA", "EM_HG", "EM_HY", "EM_BBB", "EM_BB", "EM_B_LOWER", "EM_XOVER"];
    const keys = wanted.filter((k) => CREDIT_PANEL[k]);
    const res = await pmap(keys, 4, (k) => fredCsv(CREDIT_PANEL[k].id, { start: "2015-01-01" }));
    const seriesMap = {};
    const cols = [];
    keys.forEach((k, i) => {
      const r = res[i];
      if (r && !r.unavailable && r.rows?.length) { seriesMap[k] = asMap(r.rows); cols.push(k); }
    });
    const fc = buildForecast(cols, seriesMap, { freq: "days", scale: 100, floorAt: 0 });
    const pure = [];
    const tag = market === "eu" ? "eu" : "em";
    if (fc.ok) {
      models[tag] = { lag: fc.lag, nobs: fc.nobs, rho: r2(fc.rho), stable: fc.stable, horizonMonths: fc.horizonMonths, why: fc.why };
      cols.forEach((k, ki) => {
        const rows = simRows(fc, weightFor(fc.fit.K, ki), null, {
          ret: (sims) => holdPathsFromSims(sims, fc.last[ki], SPREAD_DURATION, null, FREQ_PER_YEAR[fc.freq]),
        });
        if (!rows) return;
        pure.push(
          asset(k, CREDIT_PANEL[k].label, `${CREDIT_PANEL[k].label}, ${SPREAD_DURATION}-year spread duration`, rows, {
            level0: r2(fc.last[ki]),
            expected_loss_bps: null,
            peak: peakOf(rows, "ret"),
          })
        );
      });
    } else {
      models[tag] = { why: fc.why };
    }

    const spread = [];
    if (market === "eu" || market === "all") {
      const isos = Object.keys(ECB_LTIR);
      const ltir = await pmap(isos, 5, (iso) => ecbCsv(`IRS/M.${iso}.L.L40.CI.0000.EUR.N.Z`, { start: "2005-01-01" }));
      const sm = {};
      const cc = [];
      isos.forEach((iso, i) => {
        const r = ltir[i];
        if (r && !r.unavailable && r.rows?.length) { sm[iso] = asMap(r.rows); cc.push(iso); }
      });
      const efc = buildForecast(cc, sm, { freq: "months", scale: 100, floorAt: -Infinity });
      if (efc.ok && cc.includes("DE")) {
        const di = cc.indexOf("DE");
        cc.forEach((iso, k) => {
          if (iso === "DE") return;
          const l0 = efc.last[k] - efc.last[di];
          const rows = simRows(efc, weightFor(efc.fit.K, k, di), null, {
            ret: (sims) => holdPathsFromSims(sims, l0, BOND_DURATION, null, FREQ_PER_YEAR[efc.freq]),
          });
          if (!rows) return;
          spread.push(
            asset(`${iso} - DE`, `${iso} - DE`, `${ECB_LTIR[iso]} over Bund, ${BOND_DURATION}-year duration`, rows, {
              level0: r2(l0),
              peak: peakOf(rows, "ret"),
            })
          );
        });
        models[`${tag}_sovereign`] = { lag: efc.lag, nobs: efc.nobs, rho: r2(efc.rho), stable: efc.stable, horizonMonths: efc.horizonMonths, why: efc.why };
      }
    }
    markets[tag] = { pure, spread };
  }

  if (market === "countries" || market === "all") {
    const isos = Object.keys(COUNTRIES).filter((i) => COUNTRIES[i].yield);
    const res = await pmap(isos, 6, (iso) => fredCsv(COUNTRIES[iso].yield, { start: "1990-01-01" }));
    const infl = await worldBank(WB_INDICATORS.inflation.id, isos.map((i) => COUNTRIES[i].iso3));
    const inflLatest = infl && !infl.unavailable ? infl.latest : null;

    // one VAR per sovereign against the US 10Y as the global factor: a joint
    // 34-variable panel would need far more history than any of them has,
    // and a univariate fit would miss the common rates cycle entirely
    const usRows = res[isos.indexOf("US")];
    const usMap = usRows && !usRows.unavailable ? asMap(usRows.rows) : null;

    const pure = [];
    let modelNote = null;
    for (let i = 0; i < isos.length; i++) {
      const iso = isos[i];
      const r = res[i];
      if (!r || r.unavailable || !r.rows?.length) continue;
      const cols = iso === "US" || !usMap ? [iso] : [iso, "US"];
      const sm = { [iso]: asMap(r.rows) };
      if (cols.length === 2) sm.US = usMap;
      const fc = buildForecast(cols, sm, { freq: "months", scale: 100, floorAt: -Infinity });
      if (!fc.ok) {
        pure.push(asset(iso, COUNTRIES[iso].name, `${COUNTRIES[iso].name} 10-year government bond`, null, { why: fc.why }));
        continue;
      }
      if (!modelNote) modelNote = fc.why;
      const inf = inflLatest?.get(COUNTRIES[iso].iso3);
      const infBps = inf ? inf.v * 100 : null;
      const rows = simRows(fc, weightFor(fc.fit.K, 0), null, {
        ret: (sims) => holdPathsFromSims(sims, fc.last[0], BOND_DURATION, null, FREQ_PER_YEAR[fc.freq]),
        net: (sims) => holdPathsFromSims(sims, fc.last[0], BOND_DURATION, infBps, FREQ_PER_YEAR[fc.freq]),
      });
      if (!rows) continue;
      pure.push(
        asset(iso, COUNTRIES[iso].name, `${COUNTRIES[iso].name} 10-year government bond, ${BOND_DURATION}-year duration`, rows, {
          level0: r2(fc.last[0]),
          inflation_bps: infBps == null ? null : r2(infBps),
          inflation_year: inf ? Number(inf.year) : null,
          lag: fc.lag,
          rho: r2(fc.rho),
          horizonMonths: fc.horizonMonths,
          peak: peakOf(rows, infBps == null ? "ret" : "net"),
        })
      );
    }
    markets.countries = { pure, spread: [] };
    models.countries = { why: modelNote || "no sovereign panel could be fitted", perSeries: true };
  }

  return { markets, models };
}

/* ==================================================================== */
/* volatility                                                            */
/* ==================================================================== */

/**
 * Price one straddle position and mark it to market along the VAR forecast.
 *
 * `w` selects the underlying: a unit vector trades the series itself, a
 * long/short pair trades the SPREAD between two of them. Both come off the
 * same fitted VAR, so a spread straddle is priced on the spread's own
 * variance — Var(a) + Var(b) - 2Cov(a,b) — and not on its legs' separately.
 *
 * Maturity is the model's usable horizon, capped at a year: a straddle whose
 * expiry sits beyond where the VAR is projectable would be priced off a
 * forecast the model cannot support.
 */
function straddleAsset(fc, { id, name, standsFor, w, costs, pnlScale, riskFree, extra = {} }) {
  const samples = combinationSamples(fc, w);
  if (samples.length < 2) {
    return asset(id, name, standsFor, null, { why: "forecast horizon too short to hold a straddle" });
  }
  const maturityMonths = Math.min(samples.length, 12);
  // the option's Bachelier vol: the one-step innovation sd of the traded
  // combination, annualised at the panel's own observation frequency
  const sigmaAnn = stepSdFor(fc.fit, w) * Math.sqrt(FREQ_PER_YEAR[fc.freq] || 12);
  const level0 = combinationLevel0(fc, w);
  const fair = sigmaAnn * Math.sqrt(maturityMonths / 12) * Math.sqrt(2 / Math.PI);
  if (!(fair > 0)) {
    return asset(id, name, standsFor, null, { why: "the fitted innovation variance is zero — no straddle to price" });
  }
  const premRet = fair * costs.markup;
  const premHf = fair * costs.hfMarkup;
  const roundTrip = 2 * costs.friction;
  const stepsPerYear = FREQ_PER_YEAR[fc.freq] || 12;
  const totalSteps = maturityMonths * fc.perMonth;
  const base = { level0, sigmaAnn, totalSteps, stepsPerYear, financeRate: riskFree, roundTrip, pnlScale };

  const rows = simRows(fc, w, maturityMonths, {
    gross: (sims) => straddlePathsFromSims(sims, { ...base, premium: fair, roundTrip: 0, key: "gross" }),
    hf: (sims) => straddlePathsFromSims(sims, { ...base, premium: premHf, key: "net" }),
    ret: (sims) => straddlePathsFromSims(sims, { ...base, premium: premRet, key: "net" }),
  });
  if (!rows) {
    return asset(id, name, standsFor, null, { why: "the simulation returned no usable paths" });
  }
  return asset(id, name, standsFor, rows, {
    level0: r2(level0),
    maturity_months: maturityMonths,
    premium_bps: r2(premRet * pnlScale),
    fair_premium_bps: r2(fair * pnlScale),
    markup: r2(costs.markup),
    hf_markup: r2(costs.hfMarkup),
    friction_bps: r2(costs.friction * pnlScale),
    financing_pct: r2(riskFree * 100),
    sims: NSIMS,
    peak: peakOf(rows, "ret"),
    ...extra,
  });
}

const FREQ_PER_YEAR = { days: 252, months: 12 };

async function buildVolBook(market) {
  const markets = {};
  const models = {};

  // financing cost of the premium. A long option is cash paid up front, so
  // carrying it costs the short rate — the leverage cost of the position,
  // which accrues whether or not the trade works. USD books are financed at
  // the 3-month bill, euro books at the ECB main refinancing rate.
  const [usdR, eurR] = await pmap(["DGS3MO", "ECBMRRFR"], 2, (id) => fredCsv(id, { start: "2024-01-01" }));
  const rateOf = (r, dflt) => (r && !r.unavailable && r.rows?.length ? r.rows[r.rows.length - 1].v / 100 : dflt);
  const USD_RF = rateOf(usdR, 0.04);
  const EUR_RF = rateOf(eurR, 0.025);

  if (market === "us" || market === "all") {
    const oasList = await pmap(RATING_ORDER, 4, (g) => fredCsv(US_GRADES[g].id, { start: "2010-01-01" }));
    const seriesMap = {};
    const raw = {};
    const cols = [];
    RATING_ORDER.forEach((g, i) => {
      const r = oasList[i];
      if (r && !r.unavailable && r.rows?.length) {
        seriesMap[g] = asMap(r.rows);
        raw[g] = toBps(r.rows);
        cols.push(g);
      }
    });
    // Fallen angel ETF for US
    const anglRes = await yahooChart(ETF_ASSETS.ANGL.symbol, { range: "15y", interval: "1d" });
    if (anglRes && !anglRes.unavailable && anglRes.rows?.length) {
      const lp = logPriceBps(anglRes.rows);
      seriesMap.ANGL = Object.fromEntries(anglRes.rows.map((x, j) => [x.date, lp[j] / 100]));
      raw.ANGL = lp;
      cols.push("ANGL");
    }
    const fc = buildForecast(cols, seriesMap, { freq: "days", scale: 100, floorAt: -Infinity });
    const pure = [];
    const spread = [];
    if (fc.ok) {
      models.us = { lag: fc.lag, nobs: fc.nobs, rho: r2(fc.rho), stable: fc.stable, horizonMonths: fc.horizonMonths, why: fc.why };
      cols.forEach((c, k) => {
        const costs = tradeCostBasis(raw[c], { name: c, unit: "days", pnlScale: PRICE_SCALE });
        pure.push(straddleAsset(fc, {
          id: c, name: c.replace(/_/g, " "),
          standsFor: `${ETF_ASSETS[c]?.label || US_GRADES[c]?.label || c} — straddle on the price`,
          w: weightFor(fc.fit.K, k), costs, pnlScale: PRICE_SCALE, riskFree: USD_RF,
        }));
      });
      // straddles ON THE SPREAD between adjacent grades: you trade the
      // difference, so the position is priced on the difference's own variance
      for (const [hi, lo] of ADJACENT_PAIRS) {
        const a = cols.indexOf(hi);
        const b = cols.indexOf(lo);
        if (a < 0 || b < 0) continue;
        const diff = raw[hi].map((v, i) => v - raw[lo][i]);
        const costs = tradeCostBasis(diff, { name: `${hi}-${lo}`, unit: "days", pnlScale: SPREAD_DURATION });
        spread.push(straddleAsset(fc, {
          id: `${hi} - ${lo}`, name: `${hi} - ${lo}`,
          standsFor: `Straddle on the ${hi} minus ${lo} spread, ${SPREAD_DURATION}-year duration`,
          w: weightFor(fc.fit.K, a, b), costs, pnlScale: SPREAD_DURATION, riskFree: USD_RF,
        }));
      }
    } else {
      models.us = { why: fc.why };
    }
    markets.us = { pure, spread };
  }

  for (const [tag, symbols] of [
    ["eu", { EUR_IG: "IEACL", EUR_HY: "IHYGL" }],
    ["em", { EM_USD_Sovereign: "EMB", EM_Corporate: "CEMB", EM_High_Yield: "EMHY", EM_Local_Currency: "LEMB" }],
  ]) {
    if (market !== tag && market !== "all") continue;
    const names = Object.keys(symbols);
    const res = await pmap(names, 4, (n) => yahooChart(ETF_ASSETS[symbols[n]].symbol, { range: "15y", interval: "1d" }));
    const seriesMap = {};
    const raw = {};
    const cols = [];
    names.forEach((n, i) => {
      const r = res[i];
      if (r && !r.unavailable && r.rows?.length) {
        // the log-price index IS the observable here: its differences are
        // already returns in bps, so the VAR is fitted on it directly
        const lp = logPriceBps(r.rows);
        seriesMap[n] = Object.fromEntries(r.rows.map((x, j) => [x.date, lp[j] / 100]));
        raw[n] = lp;
        cols.push(n);
      }
    });
    const fc = buildForecast(cols, seriesMap, { freq: "days", scale: 100, floorAt: -Infinity });
    const pure = [];
    const spread = [];
    const rf = tag === "eu" ? EUR_RF : USD_RF;
    if (fc.ok) {
      models[tag] = { lag: fc.lag, nobs: fc.nobs, rho: r2(fc.rho), stable: fc.stable, horizonMonths: fc.horizonMonths, why: fc.why };
      cols.forEach((c, k) => {
        const costs = tradeCostBasis(raw[c], { name: c, unit: "days", pnlScale: PRICE_SCALE });
        pure.push(straddleAsset(fc, {
          id: c, name: c.replace(/_/g, " "),
          standsFor: `${ETF_ASSETS[symbols[c]].label} — straddle on the price`,
          w: weightFor(fc.fit.K, k), costs, pnlScale: PRICE_SCALE, riskFree: rf,
        }));
      });
      for (let a = 0; a < cols.length; a++) {
        for (let b = a + 1; b < cols.length; b++) {
          const A = cols[a];
          const B = cols[b];
          const diff = raw[A].map((v, i) => v - raw[B][i]);
          const costs = tradeCostBasis(diff, { name: `${A}-${B}`, unit: "days", pnlScale: PRICE_SCALE });
          spread.push(straddleAsset(fc, {
            id: `${A} - ${B}`, name: `${A.replace(/_/g, " ")} - ${B.replace(/_/g, " ")}`,
            standsFor: `Straddle on the price difference between ${ETF_ASSETS[symbols[A]].label} and ${ETF_ASSETS[symbols[B]].label}`,
            w: weightFor(fc.fit.K, a, b), costs, pnlScale: PRICE_SCALE, riskFree: rf,
          }));
        }
      }
    } else {
      models[tag] = { why: fc.why };
    }
    markets[tag] = { pure, spread };
  }

  if (market === "countries" || market === "all") {
    const isos = Object.keys(ECB_LTIR);
    const res = await pmap(isos, 5, (iso) => ecbCsv(`IRS/M.${iso}.L.L40.CI.0000.EUR.N.Z`, { start: "2005-01-01" }));
    const seriesMap = {};
    const raw = {};
    const cols = [];
    isos.forEach((iso, i) => {
      const r = res[i];
      if (r && !r.unavailable && r.rows?.length >= 60) {
        seriesMap[iso] = asMap(r.rows);
        raw[iso] = toBps(r.rows);
        cols.push(iso);
      }
    });
    const pure = [];
    const spread = [];

    // 1. Joint VAR for sovereign yields (long history)
    const fc = buildForecast(cols, seriesMap, { freq: "months", scale: 100, floorAt: -Infinity });
    if (fc.ok) {
      models.countries = { lag: fc.lag, nobs: fc.nobs, rho: r2(fc.rho), stable: fc.stable, horizonMonths: fc.horizonMonths, why: fc.why };
      cols.forEach((c, k) => {
        const costs = tradeCostBasis(raw[c], { name: c, unit: "months", pnlScale: BOND_DURATION });
        pure.push(straddleAsset(fc, {
          id: c, name: ECB_LTIR[c],
          standsFor: `Straddle on the ${ECB_LTIR[c]} yield, ${BOND_DURATION}-year duration`,
          w: weightFor(fc.fit.K, k), costs, pnlScale: BOND_DURATION, riskFree: EUR_RF,
        }));
      });
      // sovereign spreads over Bund
      const de = cols.indexOf("DE");
      if (de >= 0) {
        cols.forEach((c, k) => {
          if (c === "DE") return;
          const diff = raw[c].map((v, i) => v - raw.DE[i]);
          const costs = tradeCostBasis(diff, { name: `${c}-DE`, unit: "months", pnlScale: BOND_DURATION });
          spread.push(straddleAsset(fc, {
            id: `${c} - DE`, name: `${ECB_LTIR[c]} - Bund`,
            standsFor: `Straddle on the ${ECB_LTIR[c]} spread over Bund, ${BOND_DURATION}-year duration`,
            w: weightFor(fc.fit.K, k, de), costs, pnlScale: BOND_DURATION, riskFree: EUR_RF,
          }));
        });
      }
    } else {
      models.countries = { why: fc.why };
    }

    // 2. Separate univariate VAR for fallen angel ETF (shorter history, EM1A.DE - use daily freq)
    const em1aRes = await yahooChart(ETF_ASSETS.EM1ADE.symbol, { range: "15y", interval: "1d" });
    if (em1aRes && !em1aRes.unavailable && em1aRes.rows?.length >= 100) {
      const lp = logPriceBps(em1aRes.rows);
      const em1aMap = Object.fromEntries(em1aRes.rows.map((x, j) => [x.date, lp[j] / 100]));
      const em1aRaw = lp;
      const em1aFc = buildForecast(["EM1ADE"], { EM1ADE: em1aMap }, { freq: "days", scale: 100, floorAt: -Infinity });
      if (em1aFc.ok) {
        const costs = tradeCostBasis(em1aRaw, { name: "EM1ADE", unit: "days", pnlScale: PRICE_SCALE });
        pure.push(straddleAsset(em1aFc, {
          id: "EM1ADE", name: ETF_ASSETS.EM1ADE.label,
          standsFor: `${ETF_ASSETS.EM1ADE.label} — straddle on the price (USD)`,
          w: weightFor(em1aFc.fit.K, 0), costs, pnlScale: PRICE_SCALE, riskFree: EUR_RF,
        }));
      }
    }

    markets.countries = { pure, spread };
  }

  return { markets, models };
}

/* ==================================================================== */

export default async function handler(req, res) {
  const url = new URL(req.url, "http://x");
  const market = url.searchParams.get("market") || "us";
  const basis = url.searchParams.get("basis") === "vol" ? "vol" : "hold";

  // fitting one VAR per sovereign is the slowest work on the site, and the
  // inputs move once a day at most — see cachedJson
  const cached = await cachedJson("returns", `${market}|${basis}`, CACHE_TTL.DERIVED, async () => {
    const built = basis === "hold" ? await buildHoldBook(market) : await buildVolBook(market);
    return { ...built, generated: new Date().toISOString() };
  });
  const { markets, models, generated } = cached.doc;

  const payload = {
    status: "OK",
    generated,
    basis,
    markets,
    models,
    cache: { hit: !!cached.fromCache, stale: !!cached.stale },
  };
  if (!markets[market] && market !== "all") {
    payload.status = "UNAVAILABLE";
    payload.why = `no ${basis} book for market '${market}'`;
  }

  payload.label =
    basis === "hold"
      ? "Carry accrued and marked to the VAR forecast of the spread or yield"
      : "One at-the-money straddle, opened now and marked to market monthly to expiry";
  payload.method =
    basis === "hold"
      ? [
          `${NSIMS} futures simulated from the fitted VAR by resampling its own residual rows, which keeps their fat tails, skew and cross-sectional dependence rather than assuming a Gaussian shock`,
          "per path: return = accrued carry - duration x (level on that path - level now), so the yield being earned fluctuates as the yield does",
          "expected loss, where a default-rate proxy maps to the grade, is accrued monthly; for sovereigns the deduction is the latest published inflation print",
          "the line is the median across paths, the shaded band the 10th to 90th percentile, the dashed line one simulated future with its fluctuation intact",
        ]
      : [
          "one straddle struck at the money now and marked to market monthly to expiry, not a new trade at every maturity",
          "premium is the Bachelier at-the-money value sigma x sqrt(2T/pi); the underlying is a spread or yield in basis points, which goes negative, so the normal model applies and not a lognormal one",
          "value at month m = the Bachelier straddle struck at the current level, with sigma x sqrt(time left) of value remaining",
          "net = value - premium x dealer markup - financing on the premium at the short rate - a round trip of execution friction",
          "spread straddles are priced on the spread's own variance, Var(a) + Var(b) - 2Cov(a,b), taken from the same fitted VAR as the legs",
          `${NSIMS} futures simulated by residual bootstrap; the straddle is marked against the level each path reaches, so a future that gaps away from the strike pays and one that sits still bleeds the premium`,
          "the line is the median across paths, the shaded band the 10th to 90th percentile, the dashed line one simulated future",
        ];

  return json(res, payload);
}
