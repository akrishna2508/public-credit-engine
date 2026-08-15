/**
 * GET /api/drivers — what the fitted model found, and what is driving it.
 *
 * A NOTE ON WHAT THIS IS. There is no neural network anywhere in this
 * project. The model is a vector autoregression: every series in a panel is
 * regressed on the recent history of every series including itself, and the
 * result is used to forecast and to trace how a shock in one propagates to
 * the others. Calling that AI would be marketing; it is econometrics, and it
 * has the advantage that every number below can be traced to a coefficient
 * rather than to a weight nobody can read.
 *
 * THE DRIVING METRIC is the forecast-error variance decomposition. For each
 * series it answers: of everything the model cannot predict about this series
 * at a given horizon, how much traces back to shocks in each of the others?
 *
 *   theta_ij(h) = orthogonalised impulse response of i to a shock in j
 *   FEVD_ij(H)  = sum_h theta_ij(h)^2 / sum_j sum_h theta_ij(h)^2
 *
 * The decomposition is ORDER DEPENDENT. Orthogonalising by Cholesky assumes
 * a shock to an earlier series can hit a later one within the period but not
 * the reverse, so the ordering is a causal assumption and is reported with
 * the result rather than buried. Credit panels are ordered safest-first,
 * which is the conventional reading: a shock at the risky end does not move
 * AAA contemporaneously, but a shock to AAA moves everything.
 */
import {
  fredCsv, ecbCsv, json, pmap, cachedJson, CACHE_TTL,
} from "./_shared.js";
import { buildForecast, spectralRadius } from "./_forecastpath.js";
import { irfMa, irfOrth } from "./_var.js";
import { RATING_ORDER, US_GRADES, CREDIT_PANEL } from "./_universe.js";

export const config = { runtime: "nodejs" };

const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
const asMap = (rows) => Object.fromEntries(rows.map((r) => [r.date, r.v]));

const ECB_LTIR = {
  DE: "Germany 10Y Bund", FI: "Finland 10Y", FR: "France 10Y OAT", IT: "Italy 10Y BTP",
  ES: "Spain 10Y Bonos", NL: "Netherlands 10Y DSL", BE: "Belgium 10Y OLO", AT: "Austria 10Y",
  PT: "Portugal 10Y", IE: "Ireland 10Y", GR: "Greece 10Y",
};

/**
 * Forecast-error variance decomposition at horizon H.
 * @returns [i][j] share of series i's forecast variance owed to shocks in j
 */
function fevd(fit, H) {
  const psi = irfMa(fit, H);
  const theta = irfOrth(psi, fit.sigma);
  if (!theta) return null;
  const K = fit.K;
  const acc = Array.from({ length: K }, () => new Array(K).fill(0));
  for (let h = 0; h < H; h++) {
    for (let i = 0; i < K; i++) {
      for (let j = 0; j < K; j++) acc[i][j] += theta[h][i][j] * theta[h][i][j];
    }
  }
  return acc.map((row) => {
    const tot = row.reduce((a, b) => a + b, 0);
    return tot > 0 ? row.map((v) => v / tot) : row.map(() => NaN);
  });
}

/** largest absolute orthogonalised response of i to j, and when it peaks */
function peakResponse(fit, H, i, j) {
  const theta = irfOrth(irfMa(fit, H), fit.sigma);
  if (!theta) return null;
  let bi = 0;
  let bv = 0;
  for (let h = 0; h < H; h++) {
    const v = theta[h][i][j];
    if (Math.abs(v) > Math.abs(bv)) { bv = v; bi = h; }
  }
  return { step: bi, value: r2(bv) };
}

/** fit one panel and describe it */
function describePanel(id, label, cols, labels, seriesMap, opts) {
  const fc = buildForecast(cols, seriesMap, opts);
  if (!fc.ok) return { id, label, status: "UNAVAILABLE", why: fc.why };

  const H = Math.max(4, Math.min(opts.fevdSteps || 21, fc.steps.length));
  const dec = fevd(fc.fit, H);
  if (!dec) {
    return { id, label, status: "UNAVAILABLE", why: "residual covariance is not positive definite — cannot orthogonalise" };
  }
  const r2s = fc.r2ByEquation || [];

  const series = cols.map((c, i) => {
    const shares = dec[i].map((v, j) => ({ from: cols[j], label: labels[j], share: v }));
    const own = shares[i].share;
    const external = shares
      .filter((_, j) => j !== i)
      .sort((a, b) => b.share - a.share);
    const top = external[0];
    const pk = top ? peakResponse(fc.fit, H, i, cols.indexOf(top.from)) : null;
    return {
      id: c,
      label: labels[i],
      ownShare: r2(own * 100),
      driver: top ? { id: top.from, label: top.label, share: r2(top.share * 100) } : null,
      driverPeak: pk,
      shares: shares.map((s) => ({ from: s.from, label: s.label, share: r2(s.share * 100) })),
      r2: r2s[i] == null ? null : r2(r2s[i] * 100),
    };
  });

  // which series explains the most variance ACROSS the panel — the shock
  // everything else is listening to
  const outward = cols.map((c, j) => ({
    id: c,
    label: labels[j],
    share: r2((series.reduce((a, s, i) => a + (i === j ? 0 : dec[i][j]), 0) / Math.max(1, cols.length - 1)) * 100),
  })).sort((a, b) => b.share - a.share);

  return {
    id,
    label,
    status: "OK",
    model: {
      kind: "vector autoregression",
      lag: fc.lag,
      variables: cols.length,
      observations: fc.nobs,
      spectralRadius: r2(fc.rho),
      stable: fc.stable,
      aic: r2(fc.fit.aic),
      bic: r2(fc.fit.bic),
      frequency: fc.freq,
      horizonMonths: fc.horizonMonths,
      note: fc.why,
    },
    fevdSteps: H,
    ordering: cols.slice(),
    orderingNote:
      "Shocks are orthogonalised by Cholesky in the order listed, which assumes an earlier series can move a later one within the period but not the reverse. The decomposition changes if the order changes; this ordering is safest-first for credit and core-first for sovereigns.",
    series,
    mostInfluential: outward.slice(0, 3),
  };
}

async function build() {
  const panels = [];

  // --- US credit grades, ordered safest first ---
  {
    const res = await pmap(RATING_ORDER, 4, (g) => fredCsv(US_GRADES[g].id, { start: "2010-01-01" }));
    const sm = {};
    const cols = [];
    const labels = [];
    RATING_ORDER.forEach((g, i) => {
      const r = res[i];
      if (r && !r.unavailable && r.rows?.length) {
        sm[g] = asMap(r.rows);
        cols.push(g);
        labels.push(US_GRADES[g].label);
      }
    });
    if (cols.length >= 2) {
      panels.push(describePanel("us_credit", "US credit grade ladder", cols, labels, sm, {
        freq: "days", scale: 100, floorAt: 0, fevdSteps: 21,
      }));
    }
  }

  // --- EM credit indices by region and quality ---
  {
    const keys = ["EM_CORP", "EM_ASIA", "EM_LATAM", "EM_EMEA", "EM_HG", "EM_HY"].filter((k) => CREDIT_PANEL[k]);
    const res = await pmap(keys, 4, (k) => fredCsv(CREDIT_PANEL[k].id, { start: "2015-01-01" }));
    const sm = {};
    const cols = [];
    const labels = [];
    keys.forEach((k, i) => {
      const r = res[i];
      if (r && !r.unavailable && r.rows?.length) {
        sm[k] = asMap(r.rows);
        cols.push(k);
        labels.push(CREDIT_PANEL[k].label);
      }
    });
    if (cols.length >= 2) {
      panels.push(describePanel("em_credit", "Emerging-market corporate credit", cols, labels, sm, {
        freq: "days", scale: 100, floorAt: 0, fevdSteps: 21,
      }));
    }
  }

  // --- euro sovereigns, core first ---
  {
    const order = ["DE", "NL", "AT", "FI", "BE", "FR", "IE", "PT", "ES", "IT", "GR"];
    const res = await pmap(order, 5, (iso) => ecbCsv(`IRS/M.${iso}.L.L40.CI.0000.EUR.N.Z`, { start: "2005-01-01" }));
    const sm = {};
    const cols = [];
    const labels = [];
    order.forEach((iso, i) => {
      const r = res[i];
      if (r && !r.unavailable && r.rows?.length >= 60) {
        sm[iso] = asMap(r.rows);
        cols.push(iso);
        labels.push(ECB_LTIR[iso]);
      }
    });
    if (cols.length >= 2) {
      panels.push(describePanel("eur_sovereign", "Euro-area sovereign yields", cols, labels, sm, {
        freq: "months", scale: 100, floorAt: -Infinity, fevdSteps: 12,
      }));
    }
  }

  return {
    status: "OK",
    generated: new Date().toISOString(),
    panels,
    method: [
      "Model: a vector autoregression per panel — every series regressed on the recent history of every series including itself. Lag order by AIC, capped so parameters stay under a fifth of the sample.",
      "Driving metric: forecast-error variance decomposition. Of everything the model cannot predict about a series at the stated horizon, the share traceable to shocks in each other series.",
      "FEVD_ij = sum_h theta_ij(h)^2 / sum_j sum_h theta_ij(h)^2, with theta the Cholesky-orthogonalised impulse response.",
      "R-squared is per equation on the fitted residuals; spectral radius is the companion matrix's largest eigenvalue, and below 1 means shocks decay.",
      "No neural network is involved. Every number here traces to an estimated coefficient.",
    ],
  };
}

export default async function handler(req, res) {
  const cached = await cachedJson("drivers", "v1", CACHE_TTL.DERIVED, () => build());
  return json(res, { ...cached.doc, cache: { hit: !!cached.fromCache, stale: !!cached.stale } });
}
