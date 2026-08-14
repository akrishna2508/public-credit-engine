/**
 * GET /api/forecast — VAR-predicted credit spreads + the IRF contagion matrix.
 *
 * This hosts what previously only existed as local PNG/JSON artifacts of the
 * Python pipeline (future_projections.json, irf_contagion_matrix_*.json).
 * Everything is recomputed live from FRED on each cold request:
 *
 *   spread_minus_EL[riskier - safer](t)
 *       = (OAS_riskier(t) - OAS_safer(t)) * 100          [bps]
 *         - (EL_riskier - EL_safer) * 10000              [bps]
 *   EL[grade] = latest default-rate proxy * published LGD
 *
 * The six adjacent-grade pairs then go through the VAR pipeline in _var.js,
 * which is a verified port of engine/forecast.py's rank-0 branch (panel
 * alignment, AIC lag order, OLS fit, differenced forecast cumulated back to
 * levels, 1-unit and orthogonalized impulse responses).
 *
 * Every constant below mirrors config.py — no new magic numbers.
 */
import { fredCsv, json, unavailable, pmap } from "./_shared.js";
import { alignPanel, runVarPipeline } from "./_var.js";
import {
  RATING_ORDER, US_GRADES as OAS, PUBLISHED_LGD as LGD, DR_SERIES, DR_MAPPING,
  ADJACENT_PAIRS as ADJACENT, FORECAST_HIERARCHY as HIERARCHY, expectedLossByGrade,
} from "./_universe.js";

export const config = { runtime: "nodejs" };

// The grade ladder, loss assumptions and adjacent rungs all come from
// _universe.js so this endpoint and /api/spreads can never disagree about
// what a grade is or what loss is subtracted from it.
// (BB - Fallen_Angel is an ETF price leg and never enters this panel — the
// Python pipeline drops it for the same reason.)
const HORIZON = 12; // config.DEFAULT_FORECAST_HORIZON
const MAX_LAGS = 12; // config.DEFAULT_MAX_LAGS

export default async function handler(req, res) {
  const url = new URL(req.url, "http://x");
  const horizon = Math.min(60, Math.max(1, Number(url.searchParams.get("horizon")) || HORIZON));

  // ---- OAS grade curves + default-rate proxies (parallel) ----
  const oasList = await pmap(RATING_ORDER, 4, (g) => fredCsv(OAS[g].id, { start: "2005-01-01" }));
  const oasRows = {};
  const missing = [];
  RATING_ORDER.forEach((g, i) => {
    const r = oasList[i];
    if (r && !r.unavailable && r.rows?.length) oasRows[g] = r.rows;
    else missing.push(`${g} (${OAS[g].id})`);
  });
  if (Object.keys(oasRows).length < 2) {
    return unavailable(res, `credit-grade OAS unavailable — needs FRED_API_KEY on this deployment. Missing: ${missing.join(", ")}`);
  }

  const drList = await pmap(Object.entries(DR_SERIES), 2, ([, id]) => fredCsv(id, { start: "2005-01-01" }));
  const drLatest = {};
  Object.keys(DR_SERIES).forEach((k, i) => {
    const r = drList[i];
    const rows = r && !r.unavailable ? r.rows : null;
    // audit gate (engine/default_rates.py): a missing DR is UNAVAILABLE, never 0
    drLatest[k] = rows?.length ? { v: rows[rows.length - 1].v / 100, date: rows[rows.length - 1].date } : null;
  });

  // ---- expected loss per grade, EL difference per adjacent pair ----
  const expectedLoss = expectedLossByGrade(drLatest);
  const elDiff = {};
  for (const [riskier, safer] of ADJACENT) {
    const a = expectedLoss[riskier];
    const b = expectedLoss[safer];
    elDiff[`${riskier} - ${safer}`] = a == null || b == null ? null : round8(a - b);
  }

  // ---- spread-minus-EL series per adjacent pair, in bps ----
  const seriesMap = {};
  const pairMeta = {};
  for (const [riskier, safer] of ADJACENT) {
    const name = `${riskier} - ${safer}`;
    const hi = oasRows[riskier];
    const lo = oasRows[safer];
    const ed = elDiff[name];
    if (!hi || !lo || ed == null) continue;
    const loMap = new Map(lo.map((r) => [r.date, r.v]));
    const out = {};
    for (const r of hi) {
      const other = loMap.get(r.date);
      if (other == null) continue;
      out[r.date] = round4((r.v - other) * 100 - ed * 10000);
    }
    if (Object.keys(out).length) {
      seriesMap[name] = out;
      pairMeta[name] = {
        riskier, safer,
        elDiffBps: round4(ed * 10000),
        standsFor: `${OAS[riskier].label} minus ${OAS[safer].label}, net of the expected-loss difference between the two grades`,
      };
    }
  }
  const cols = HIERARCHY.filter((c) => c in seriesMap);
  if (cols.length < 2) {
    return unavailable(res, "fewer than two adjacent-grade pairs could be built from the available OAS series");
  }

  // ---- align the panel exactly as pandas does, then run the VAR ----
  const { dates, levels } = alignPanel(cols, seriesMap);
  const result = runVarPipeline(cols, levels, dates, { horizon, maxLags: MAX_LAGS });
  if (result.status !== "OK") {
    return unavailable(res, result.why);
  }

  json(res, {
    status: "OK",
    generated: new Date().toISOString(),
    schema: "forecast.v1",
    ...result,
    panel: {
      start: dates[0],
      end: dates[dates.length - 1],
      observations: dates.length,
      frequency: "business daily (pandas resample('B').last().ffill())",
    },
    pairs: pairMeta,
    expectedLoss: {
      byGrade: expectedLoss,
      diffByPair: elDiff,
      lgd: LGD,
      defaultRateProxies: Object.fromEntries(
        Object.entries(DR_SERIES).map(([k, id]) => [
          k, drLatest[k] ? { seriesId: id, rate: round8(drLatest[k].v), asOf: drLatest[k].date } : { seriesId: id, status: "UNAVAILABLE" },
        ])
      ),
      note: "Expected loss = latest default-rate proxy x published LGD, per grade (config.PUBLISHED_LGD). A missing default-rate observation makes the grade UNAVAILABLE rather than zero.",
    },
    methodology: [
      "Panel: adjacent-grade OAS differences net of the expected-loss difference, in bps, aligned to business days (weekend index-publication dates fold onto the preceding Friday, matching pandas resample('B').last()).",
      `Model: VAR on first differences, lag order ${result.lagOrder} chosen by AIC over 0..${MAX_LAGS} on a common effective sample.`,
      "Forecast: the differenced forecast is cumulated back onto the last observed level. This is a model projection, not a promise — no confidence band is drawn because the engine does not estimate one.",
      "IRF: Psi_i for a 1 bps shock and Theta_i = Psi_i x chol(Sigma) for a 1 standard-deviation orthogonalized shock. Cholesky ordering follows the grade hierarchy, so the ordering assumption is that higher-grade spreads move first.",
      "Verified: this JavaScript pipeline reproduces engine/forecast.py's rank-0 branch to within JSON rounding on the same input panel.",
    ],
  });
}

function round4(v) {
  return Number.isFinite(v) ? Math.round(v * 10000) / 10000 : null;
}
function round8(v) {
  return Number.isFinite(v) ? Math.round(v * 1e8) / 1e8 : null;
}
