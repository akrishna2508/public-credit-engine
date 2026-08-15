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
 *   basis=vol   a straddle held to maturity m, priced off the VAR's own
 *               forecast-error volatility sigma_m, net of the dealer premium
 *               and execution friction measured from history
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
  buildForecast, monthlySamples, holdReturnPath, straddleReturnPath, timingEdge,
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
        const samples = monthlySamples(fc, k);
        const level0 = fc.last[k];
        const el = elBps[g];
        // expected loss is an annual charge, accrued along the path
        const rows = holdReturnPath(level0, samples, SPREAD_DURATION).map((r, i) => ({
          ...r,
          net: el == null ? r.ret : r.ret - (el * (i + 1)) / 12,
        }));
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
        const rows = holdReturnPath(fc.last[ki], monthlySamples(fc, ki), SPREAD_DURATION);
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
        const dSam = monthlySamples(efc, di);
        cc.forEach((iso, k) => {
          if (iso === "DE") return;
          const sam = monthlySamples(efc, k);
          const n = Math.min(sam.length, dSam.length);
          const diffSam = Array.from({ length: n }, (_, i) => ({
            date: sam[i].date,
            level: sam[i].level - dSam[i].level,
            sd: Math.hypot(sam[i].sd, dSam[i].sd),
          }));
          const rows = holdReturnPath(efc.last[k] - efc.last[di], diffSam, BOND_DURATION);
          spread.push(
            asset(`${iso} - DE`, `${iso} - DE`, `${ECB_LTIR[iso]} over Bund, ${BOND_DURATION}-year duration`, rows, {
              level0: r2(efc.last[k] - efc.last[di]),
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
      const samples = monthlySamples(fc, 0);
      const inf = inflLatest?.get(COUNTRIES[iso].iso3);
      const infBps = inf ? inf.v * 100 : null;
      const rows = holdReturnPath(fc.last[0], samples, BOND_DURATION).map((x, k) => ({
        ...x,
        net: infBps == null ? x.ret : x.ret - (infBps * (k + 1)) / 12,
      }));
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

/** fit one panel, then price a straddle along each column's sigma path */
function volAssets(fc, cols, rawByCol, { pnlScale, unit, name, standsFor, atmIvByCol = {} }) {
  const out = [];
  cols.forEach((c, k) => {
    const series = rawByCol[c];
    const costs = tradeCostBasis(series, { name: c, atmIv: atmIvByCol[c] || null, unit, pnlScale });
    const T = unit === "months" ? 12 : 21;
    const kappa = timingEdge(series, T, costs.shock);
    if (kappa == null) {
      out.push(asset(c, name(c), standsFor(c), null, { why: "too few high-volatility periods to measure a timing edge" }));
      return;
    }
    const rows = straddleReturnPath(monthlySamples(fc, k), {
      kappa,
      markup: costs.markup,
      hfMarkup: costs.hfMarkup,
      friction: costs.friction,
      pnlScale,
    });
    out.push(
      asset(c, name(c), standsFor(c), rows, {
        kappa: r2(kappa),
        markup: r2(costs.markup),
        hf_markup: r2(costs.hfMarkup),
        friction_bps: r2(costs.friction * pnlScale),
        peak: peakOf(rows, "ret"),
        peakHf: peakOf(rows, "hf"),
      })
    );
  });
  return out;
}

async function buildVolBook(market) {
  const markets = {};
  const models = {};

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
    const fc = buildForecast(cols, seriesMap, { freq: "days", scale: 100, floorAt: 0 });
    let pure = [];
    if (fc.ok) {
      models.us = { lag: fc.lag, nobs: fc.nobs, rho: r2(fc.rho), stable: fc.stable, horizonMonths: fc.horizonMonths, why: fc.why };
      pure = volAssets(fc, cols, raw, {
        pnlScale: SPREAD_DURATION,
        unit: "days",
        name: (c) => c,
        standsFor: (c) => `${US_GRADES[c].label} — straddle on the spread, ${SPREAD_DURATION}-year duration`,
      });
    } else {
      models.us = { why: fc.why };
    }
    markets.us = { pure, spread: [] };
  }

  for (const [tag, symbols] of [
    ["eu", { EUR_IG: "IEAC.L", EUR_HY: "IHYG.L" }],
    ["em", { EM_USD_Sovereign: "EMB", EM_Corporate: "CEMB", EM_High_Yield: "EMHY", EM_Local_Currency: "LEMB" }],
  ]) {
    if (market !== tag && market !== "all") continue;
    const names = Object.keys(symbols);
    const res = await pmap(names, 4, (n) => yahooChart(symbols[n].includes(".") ? symbols[n] : ETF_ASSETS[symbols[n]].symbol, { range: "15y", interval: "1d" }));
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
    let pure = [];
    if (fc.ok) {
      models[tag] = { lag: fc.lag, nobs: fc.nobs, rho: r2(fc.rho), stable: fc.stable, horizonMonths: fc.horizonMonths, why: fc.why };
      const key = tag === "eu" ? { EUR_IG: "IEACL", EUR_HY: "IHYGL" } : { EM_USD_Sovereign: "EMB", EM_Corporate: "CEMB", EM_High_Yield: "EMHY", EM_Local_Currency: "LEMB" };
      pure = volAssets(fc, cols, raw, {
        pnlScale: PRICE_SCALE,
        unit: "days",
        name: (c) => c.replace(/_/g, " "),
        standsFor: (c) => `${ETF_ASSETS[key[c]].label} — straddle on the price`,
      });
    } else {
      models[tag] = { why: fc.why };
    }
    markets[tag] = { pure, spread: [] };
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
    const fc = buildForecast(cols, seriesMap, { freq: "months", scale: 100, floorAt: -Infinity });
    let pure = [];
    if (fc.ok) {
      models.countries = { lag: fc.lag, nobs: fc.nobs, rho: r2(fc.rho), stable: fc.stable, horizonMonths: fc.horizonMonths, why: fc.why };
      pure = volAssets(fc, cols, raw, {
        pnlScale: BOND_DURATION,
        unit: "months",
        name: (c) => ECB_LTIR[c],
        standsFor: (c) => `Straddle on the ${ECB_LTIR[c]} yield, ${BOND_DURATION}-year duration`,
      });
    } else {
      models.countries = { why: fc.why };
    }
    markets.countries = { pure, spread: [] };
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
      : "Straddle held to maturity, priced off the VAR forecast-error volatility";
  payload.method =
    basis === "hold"
      ? [
          "return = accrued carry - duration x (forecast level - current level)",
          "expected loss, where a default-rate proxy maps to the grade, is accrued monthly; for sovereigns the deduction is the latest published inflation print",
          "band = duration x the model's forecast-error standard deviation",
        ]
      : [
          "expected move to maturity m = sigma_m x sqrt(2/pi), sigma_m from the VAR forecast-error covariance",
          "gross = timing edge x expected move; the timing edge is the measured ratio of moves on high-volatility periods to unconditional moves",
          "net = gross - premium x dealer markup - execution friction",
        ];

  return json(res, payload);
}
