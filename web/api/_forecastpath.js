/**
 * Forecast paths for the projection charts.
 *
 * WHAT THIS REPLACES. The projection used to take a single annualised edge
 * and compound it: (1+r1)*(1+edge/12)^(h-1). That is monotone by
 * construction, so it could never bend, never peak, and never disagree with
 * itself — it was a straight line drawn out to fifteen years and labelled
 * "not a forecast" to excuse the fact that nothing forecast it. Every path
 * here is instead the fitted VAR's own forward iteration of the observable,
 * with the forecast-error band the same model implies.
 *
 * WHY THE HORIZON IS NOT FIFTEEN YEARS. A VAR is only projectable while its
 * companion matrix is stable. Measured on the live panels:
 *
 *   sovereign 10Y yields   258 monthly obs from 2005, rho 0.95-0.99,
 *                          reversion half-life 16-40 months — projectable
 *   ICE BofA credit OAS    787 daily obs (FRED serves 3 years of ICE data),
 *                          rho 1.0014 — NOT stationary. Iterated out, the
 *                          level-space fit drives A, BBB and BB through zero
 *                          by month 26-34 and the log-space fit sends CCC to
 *                          2620 bps. A negative credit spread is not a
 *                          forecast, it is the model leaving its support.
 *
 * So the horizon is derived per panel rather than fixed, and the reason is
 * carried in the payload instead of being hidden.
 */
import { zeros } from "./_var.js";
import { alignPanel, selectLag, fitVar, forecast, irfMa } from "./_var.js";

/** hard ceiling for a panel whose companion matrix is not stable */
const UNSTABLE_CAP_MONTHS = 12;
/** ceiling for a stable panel — beyond this the band swamps the signal */
const STABLE_CAP_MONTHS = 120;
/** stop once the 1-sd forecast band is this multiple of the forecast level */
const BAND_LIMIT = 1.0;

/**
 * Spectral radius of the VAR companion matrix by power iteration.
 * < 1 means shocks die out and the process has a long-run mean to revert to;
 * >= 1 means it does not, and iterating it forward is extrapolation.
 */
export function spectralRadius(fit) {
  const { A, K, p } = fit;
  if (!p || !A.length) return 0;
  const n = K * p;
  let v = new Array(n).fill(0).map((_, i) => Math.sin(i + 1));
  let lam = 0;
  for (let it = 0; it < 2000; it++) {
    const w = new Array(n).fill(0);
    for (let k = 0; k < K; k++) {
      let s = 0;
      for (let j = 0; j < p; j++) for (let m = 0; m < K; m++) s += A[j][k][m] * v[j * K + m];
      w[k] = s;
    }
    for (let j = 1; j < p; j++) for (let m = 0; m < K; m++) w[j * K + m] = v[(j - 1) * K + m];
    let nrm = 0;
    for (const x of w) nrm += x * x;
    nrm = Math.sqrt(nrm);
    if (!nrm || !Number.isFinite(nrm)) return NaN;
    for (let i = 0; i < n; i++) v[i] = w[i] / nrm;
    lam = nrm;
  }
  return lam;
}

/**
 * Forecast-error standard deviation term structure.
 * Sigma(h) = sum_{i=0}^{h-1} Psi_i Sigma_u Psi_i' ; returns sqrt of its
 * diagonal per step. For a mean-reverting panel this SATURATES rather than
 * growing with sqrt(h) — which is exactly what caps the value of a longer
 * straddle, and is the whole reason the volatility path has an optimum.
 */
export function forecastErrorSd(fit, H) {
  const psi = irfMa(fit, H);
  const Su = fit.sigma;
  const K = fit.K;
  const acc = zeros(K, K);
  const out = [];
  for (let h = 1; h <= H; h++) {
    const P = psi[h - 1];
    for (let a = 0; a < K; a++) {
      for (let b = 0; b < K; b++) {
        let s = 0;
        for (let m = 0; m < K; m++) for (let n = 0; n < K; n++) s += P[a][m] * Su[m][n] * P[b][n];
        acc[a][b] += s;
      }
    }
    const row = new Array(K);
    for (let k = 0; k < K; k++) row[k] = Math.sqrt(Math.max(0, acc[k][k]));
    out.push(row);
  }
  return out;
}

/**
 * Align a MONTHLY panel: last observation in each calendar month, kept only
 * where every column has one.
 *
 * alignPanel is deliberately not used here. It ports pandas resample("B") —
 * it expands to a business-day grid and forward-fills, which is right for the
 * daily credit panel and destroys a monthly one: 258 monthly observations
 * become 5,586 daily rows of a step function whose lag-1 autocorrelation is
 * ~1 by construction. Fitted on that, the VAR reported a spectral radius of
 * 0.9993 with lag 1 and a "ten year" horizon that was really 120 business
 * days. Monthly series are binned at their own frequency instead.
 */
function alignMonthly(cols, seriesMap) {
  const binned = cols.map((c) => {
    const m = new Map();
    for (const d of Object.keys(seriesMap[c] || {}).sort()) {
      const v = seriesMap[c][d];
      if (v != null && Number.isFinite(v)) m.set(d.slice(0, 7), v); // later date wins
    }
    return m;
  });
  const keys = [...binned[0].keys()].filter((k) => binned.every((m) => m.has(k))).sort();
  return {
    dates: keys.map((k) => k + "-01"),
    levels: keys.map((k) => binned.map((m) => m.get(k))),
  };
}

/** month-end dates after `from`, `n` of them */
function monthlyDates(from, n) {
  const d = new Date(from + "T00:00:00Z");
  const out = [];
  for (let i = 1; i <= n; i++) {
    const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + i + 1, 0));
    out.push(x.toISOString().slice(0, 10));
  }
  return out;
}

/** business days after `from`, `n` of them */
function businessDates(from, n) {
  const d = new Date(from + "T00:00:00Z");
  const out = [];
  while (out.length < n) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/**
 * Fit a VAR to a panel and iterate it forward.
 *
 * @param cols      column names
 * @param seriesMap name -> { "YYYY-MM-DD": value } in the OBSERVABLE unit
 * @param freq      "months" | "days" (the panel's own observation frequency)
 * @param scale     multiplier applied to the observable before fitting
 *                  (percent -> bps is 100)
 * @param floorAt   a level at or below which the forecast has left its
 *                  support (0 for a spread or a yield); the path is truncated
 *                  there rather than being drawn through it
 */
export function buildForecast(cols, seriesMap, { freq = "months", scale = 100, floorAt = 0, maxLags = 12 } = {}) {
  const { dates, levels } = freq === "months" ? alignMonthly(cols, seriesMap) : alignPanel(cols, seriesMap);
  if (levels.length < 40) {
    return { ok: false, why: `only ${levels.length} aligned observations — too few to fit a VAR` };
  }
  const Y = levels.map((r) => r.map((v) => v * scale));
  const K = cols.length;
  // Each equation estimates K*p+1 coefficients. Left at 12, an 11-variable
  // monthly panel with 246 observations selected lag 12 — 133 parameters per
  // equation — and the overfit returned a spurious spectral radius of 1.0123.
  // Holding parameters to a fifth of the sample keeps the fit identified.
  const lagCap = Math.max(1, Math.min(maxLags, Math.floor((Y.length / 5 - 1) / K)));
  const p = selectLag(Y, lagCap);
  const fit = fitVar(Y, p);
  if (!fit) return { ok: false, why: "VAR fit failed (singular design matrix)" };

  const rho = spectralRadius(fit);
  const stable = Number.isFinite(rho) && rho < 1;
  const perMonth = freq === "months" ? 1 : 21;
  // Stability says the model has a long-run mean; it does not say the sample
  // is long enough to have located it. Projecting a three-year daily panel
  // ten years forward is extrapolation whatever the spectral radius reads,
  // so the horizon never exceeds half the observed sample.
  const sampleMonths = Math.floor(fit.nobs / perMonth);
  const capMonths = Math.max(
    1,
    Math.min(stable ? STABLE_CAP_MONTHS : UNSTABLE_CAP_MONTHS, Math.floor(sampleMonths / 2))
  );
  const H = capMonths * perMonth;

  const f = forecast(fit, Y, H);
  const sd = forecastErrorSd(fit, H);
  const lastDate = dates[dates.length - 1];
  const stepDates = freq === "months" ? monthlyDates(lastDate, H) : businessDates(lastDate, H);

  // truncate where the model leaves its support: any column at or below the
  // floor, or a band wider than the level it is a band around
  let usable = H;
  for (let h = 1; h <= H; h++) {
    const row = f[h - 1];
    const s = sd[h - 1];
    let bad = false;
    for (let k = 0; k < fit.K; k++) {
      if (!Number.isFinite(row[k]) || row[k] <= floorAt) bad = true;
      else if (s[k] > BAND_LIMIT * Math.abs(row[k])) bad = true;
    }
    if (bad) {
      usable = h - 1;
      break;
    }
  }
  if (usable < perMonth) {
    return {
      ok: false,
      why: `the fitted VAR leaves its support within one month (spectral radius ${rho.toFixed(4)})`,
    };
  }

  const horizonMonths = Math.floor(usable / perMonth);
  const limit =
    !stable
      ? `not stationary, so the horizon is held to ${UNSTABLE_CAP_MONTHS} months`
      : capMonths < STABLE_CAP_MONTHS && capMonths === Math.floor(sampleMonths / 2)
        ? `stationary; the horizon is half the ${sampleMonths}-month sample`
        : `stationary; the horizon ends where the 1-sd forecast band reaches the forecast level`;
  const why = `VAR(${p}) on ${fit.nobs} observations, spectral radius ${rho.toFixed(4)} — ${limit}`;

  return {
    ok: true,
    cols,
    fit,
    rho,
    stable,
    lag: p,
    nobs: fit.nobs,
    freq,
    perMonth,
    lastDate,
    last: Y[Y.length - 1],
    steps: f.slice(0, usable),
    sd: sd.slice(0, usable),
    stepDates: stepDates.slice(0, usable),
    horizonMonths,
    why,
  };
}

/**
 * Monthly samples of a forecast, for one column.
 * @returns [{ date, level, sd }] at 1..horizonMonths months ahead
 */
export function monthlySamples(fc, k) {
  const out = [];
  for (let m = 1; m <= fc.horizonMonths; m++) {
    const i = m * fc.perMonth - 1;
    if (i >= fc.steps.length) break;
    out.push({ date: fc.stepDates[i], level: fc.steps[i][k], sd: fc.sd[i][k] });
  }
  return out;
}

const SQRT_2_OVER_PI = Math.sqrt(2 / Math.PI);

/**
 * Buy-and-hold total return along a forecast path, in bps.
 *
 *   return(m) = accrued carry  -  duration x (level_m - level_0)
 *
 * the standard first-order decomposition: you collect the spread or yield
 * while you hold, and you mark the position to the forecast level. It is the
 * second term that makes the path bend. A forecast of falling yields adds a
 * capital gain on top of carry; a forecast of rising yields subtracts one,
 * and where the rise outruns the carry the cumulative return turns over.
 * That turning point is a real sell signal rather than a drawn assumption.
 *
 * The band is duration x the forecast-error sd of the level, which is the
 * dominant term; the carry leg's own uncertainty is an order smaller because
 * it averages over the path rather than depending on its endpoint.
 */
export function holdReturnPath(level0, samples, duration) {
  const rows = [];
  let carry = 0;
  let prev = level0;
  for (const s of samples) {
    carry += prev / 12;
    const ret = carry - duration * (s.level - level0);
    const band = duration * s.sd;
    rows.push({ date: s.date, level: s.level, ret, lo: ret - band, hi: ret + band });
    prev = s.level;
  }
  return rows;
}

/**
 * Straddle payout to maturity m, in bps, from the model's own volatility.
 *
 *   E|move to m| = sigma_m x sqrt(2/pi)      (Gaussian forecast error)
 *   gross        = kappa x E|move| x pnlScale
 *   premium      = E|move| x pnlScale        (fair value at that maturity)
 *   net          = gross - premium x markup - friction
 *
 * sigma_m is the VAR's forecast-error sd, which SATURATES for a mean-
 * reverting panel instead of growing with sqrt(m). The premium and the
 * friction do not saturate, so the net payout has an interior optimum — the
 * maturity past which more time buys less move than it costs. That is the
 * volatility book's sell point, and it falls out of the model rather than
 * being asserted.
 *
 * `kappa` is the timing edge: how much larger the move actually is on the
 * high-volatility days the strategy trades than an unconditional Gaussian
 * would predict. Measured from history, not assumed.
 */
export function straddleReturnPath(samples, { kappa, markup, hfMarkup, friction, pnlScale }) {
  return samples.map((s) => {
    const move = s.sd * SQRT_2_OVER_PI * pnlScale;
    const gross = kappa * move;
    const pen = friction * pnlScale;
    return {
      date: s.date,
      level: s.level,
      gross,
      hf: gross - move * hfMarkup - pen,
      ret: gross - move * markup - pen,
    };
  });
}

/**
 * Timing edge kappa: mean |T-step move| on the highest-volatility days,
 * divided by what an unconditional Gaussian of the same sample sd predicts.
 * kappa > 1 means selecting on volatility genuinely finds bigger moves.
 */
export function timingEdge(series, T, shockMask) {
  const sel = [];
  const all = [];
  for (let i = 0; i + T < series.length; i++) {
    const d = Math.abs(series[i + T] - series[i]);
    if (!Number.isFinite(d)) continue;
    all.push(d);
    if (shockMask[i]) sel.push(d);
  }
  if (sel.length < 10 || all.length < 30) return null;
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const uncond = mean(all);
  if (!(uncond > 0)) return null;
  return mean(sel) / uncond;
}
