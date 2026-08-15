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
    // last p observations, in fitted units — the seed a simulation needs to
    // iterate the VAR forward from the same state the point forecast used
    histTail: Y.slice(-Math.max(1, p)).map((r) => r.slice()),
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
 * Monthly forecast of a linear combination w'y — one column when w is a unit
 * vector, a spread when it is the difference of two. The spread is read off
 * the SAME fitted VAR as its legs, so the covariance between them is carried
 * through rather than assumed away.
 */
export function combinationSamples(fc, w) {
  const sd = forecastErrorSdFor(fc.fit, fc.steps.length, w);
  const out = [];
  for (let m = 1; m <= fc.horizonMonths; m++) {
    const i = m * fc.perMonth - 1;
    if (i >= fc.steps.length) break;
    let lvl = 0;
    for (let k = 0; k < w.length; k++) lvl += w[k] * fc.steps[i][k];
    out.push({ date: fc.stepDates[i], level: lvl, sd: sd[i] });
  }
  return out;
}

/** current level of w'y */
export function combinationLevel0(fc, w) {
  let v = 0;
  for (let k = 0; k < w.length; k++) v += w[k] * fc.last[k];
  return v;
}

/** unit vector for column k, or a long/short pair */
export function weightFor(K, a, b = null) {
  const w = new Array(K).fill(0);
  w[a] = 1;
  if (b != null) w[b] = -1;
  return w;
}

/**
 * Buy-and-hold P&L along EVERY simulated path.
 *
 * Carry accrues off the level the path is actually sitting at, so the yield
 * being earned fluctuates month to month exactly as the yield does — which
 * is the fluctuation that averaging into a single expected path erased. The
 * deduction (expected loss for a grade, the inflation print for a sovereign)
 * accrues monthly on top.
 */
export function holdPathsFromSims(sims, level0, duration, deductAnnualBps = null) {
  return sims.map((path) => {
    const out = [];
    let carry = 0;
    let prev = level0;
    for (let m = 0; m < path.length; m++) {
      carry += prev / 12;
      const gross = carry - duration * (path[m] - level0);
      out.push(deductAnnualBps == null ? gross : gross - (deductAnnualBps * (m + 1)) / 12);
      prev = path[m];
    }
    return out;
  });
}

/** the gross (pre-deduction) leg of the same simulation */
export function holdGrossFromSims(sims, level0, duration) {
  return holdPathsFromSims(sims, level0, duration, null);
}

/**
 * Straddle P&L along EVERY simulated path: the option is marked against the
 * level that path reached, so a future where the underlying gaps away from
 * the strike pays and one where it sits still bleeds the premium.
 */
export function straddlePathsFromSims(sims, {
  level0, sigmaAnn, maturityMonths, premium, financeRate, roundTrip, pnlScale = 1, key = "net",
}) {
  return sims.map((path) => {
    const out = [];
    for (let m = 1; m <= path.length; m++) {
      const tau = Math.max(0, (maturityMonths - m) / 12);
      const v = sigmaAnn * Math.sqrt(tau);
      const V = bachelierStraddle(path[m - 1] - level0, v);
      if (key === "gross") out.push((V - premium) * pnlScale);
      else {
        const fin = premium * (Math.pow(1 + financeRate, m / 12) - 1);
        out.push((V - premium - fin - roundTrip) * pnlScale);
      }
    }
    return out;
  });
}

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

/* ------------------------------------------------------------------ */
/* normal distribution helpers                                         */
/* ------------------------------------------------------------------ */

const normPdf = (x) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);

/** complementary error function, Numerical Recipes Chebyshev fit */
function erfc(x) {
  const z = Math.abs(x);
  const t = 2 / (2 + z);
  const ty = 4 * t - 2;
  const cof = [
    -1.3026537197817094, 6.4196979235649026e-1, 1.9476473204185836e-2,
    -9.561514786808631e-3, -9.46595344482036e-4, 3.66839497852761e-4,
    4.2523324806907e-5, -2.0278578112534e-5, -1.624290004647e-6,
    1.30365583558e-6, 1.5626441722e-8, -8.5238095915e-8, 6.529054439e-9,
    5.059343495e-9, -9.91364156e-10, -2.27365122e-10, 9.6467911e-11,
    2.394038e-12, -6.886027e-12, 8.94487e-13, 3.13092e-13, -1.12708e-13,
    3.81e-16, 7.106e-15,
  ];
  let d = 0;
  let dd = 0;
  for (let j = cof.length - 1; j > 0; j--) {
    const tmp = d;
    d = ty * d - dd + cof[j];
    dd = tmp;
  }
  const ans = t * Math.exp(-z * z + 0.5 * (cof[0] + ty * d) - dd);
  return x >= 0 ? ans : 2 - ans;
}

const normCdf = (x) => 0.5 * erfc(-x / Math.SQRT2);

/** inverse standard normal cdf, Acklam's rational approximation */
function normInv(p) {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  let q;
  let r;
  if (p < pl) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - pl) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  q = p - 0.5;
  r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/**
 * Bachelier (normal-model) straddle value at moneyness x with remaining
 * volatility v = sigma*sqrt(tau).
 *
 * Bachelier rather than Black-Scholes because the underlying is a spread or a
 * yield in basis points, which goes negative and is quoted additively; a
 * lognormal model is the wrong process for it. The value is exactly
 * E|x + v*Z| for a standard normal Z, so at the money it collapses to
 * v*sqrt(2/pi) and at expiry (v=0) to |x|.
 */
export function bachelierStraddle(x, v) {
  if (!(v > 0)) return Math.abs(x);
  const d = x / v;
  return x * (2 * normCdf(d) - 1) + 2 * v * normPdf(d);
}

/** E|mu + s*Z| — the expected absolute value of a normal */
const psi = (z) => 2 * normPdf(z) + z * (2 * normCdf(z) - 1);

/**
 * Forecast-error standard deviation of a LINEAR COMBINATION w'y.
 *
 * The diagonal of Sigma(h) is enough for a single series but not for a
 * spread, whose variance is Var(a) + Var(b) - 2Cov(a,b). Trading the spread
 * between two credit grades that move together is far less volatile than
 * either leg, and using the legs' own variances would overstate a spread
 * straddle's value by a wide margin.
 */
export function forecastErrorSdFor(fit, H, w) {
  const psiM = irfMa(fit, H);
  const Su = fit.sigma;
  const K = fit.K;
  let acc = 0;
  const out = [];
  for (let h = 1; h <= H; h++) {
    const P = psiM[h - 1];
    const a = new Array(K).fill(0);
    for (let m = 0; m < K; m++) {
      let sm = 0;
      for (let r = 0; r < K; r++) sm += w[r] * P[r][m];
      a[m] = sm;
    }
    let q = 0;
    for (let m = 0; m < K; m++) for (let n = 0; n < K; n++) q += a[m] * Su[m][n] * a[n];
    acc += q;
    out.push(Math.sqrt(Math.max(0, acc)));
  }
  return out;
}

/** one-step innovation sd of w'y — the option's Bachelier vol per period */
export function stepSdFor(fit, w) {
  const Su = fit.sigma;
  let q = 0;
  for (let m = 0; m < fit.K; m++) for (let n = 0; n < fit.K; n++) q += w[m] * Su[m][n] * w[n];
  return Math.sqrt(Math.max(0, q));
}

/* ------------------------------------------------------------------ */
/* simulation                                                          */
/* ------------------------------------------------------------------ */

/** mulberry32 — seeded so a given panel always simulates the same futures */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Simulate the fitted VAR forward by RESIDUAL BOOTSTRAP.
 *
 * Every path is a genuine future: the VAR is iterated step by step and at
 * each step a whole residual row, drawn at random from the fit's own
 * residuals, is added. Resampling rows rather than drawing from a Gaussian
 * keeps three things a normal draw destroys — the fat tails credit spreads
 * actually have, the skew (spreads gap wider far more violently than they
 * grind tighter), and the exact cross-sectional dependence between grades,
 * since a row moves every series together the way that day did.
 *
 * This is what makes the output stop looking uniform. The analytic
 * expectation it replaces is smooth by construction: averaging over all
 * futures averages the fluctuation away, which is precisely why the chart
 * looked flat. A path keeps its shocks.
 *
 * @returns [nSims][months] values of w'y at each monthly sampling point
 */
export function simulateCombination(fc, w, { nSims = 500, months = null, seed = 20260815 } = {}) {
  const { A, c, K, p, U } = fc.fit;
  if (!U || !U.length) return null;
  const perMonth = fc.perMonth;
  const M = Math.min(months || fc.horizonMonths, fc.horizonMonths);
  const steps = M * perMonth;
  const rand = rng(seed);
  const nU = U.length;

  const out = [];
  for (let s = 0; s < nSims; s++) {
    const hist = fc.histTail.map((r) => r.slice());
    const row = [];
    for (let t = 1; t <= steps; t++) {
      const y = c.slice();
      for (let j = 1; j <= p; j++) {
        const prev = hist[hist.length - j];
        const Aj = A[j - 1];
        for (let k = 0; k < K; k++) {
          let acc = 0;
          for (let m = 0; m < K; m++) acc += Aj[k][m] * prev[m];
          y[k] += acc;
        }
      }
      const e = U[(rand() * nU) | 0];
      for (let k = 0; k < K; k++) y[k] += e[k];
      hist.push(y);
      if (hist.length > p + 1) hist.shift();
      if (t % perMonth === 0) {
        let v = 0;
        for (let k = 0; k < K; k++) v += w[k] * y[k];
        row.push(v);
      }
    }
    out.push(row);
  }
  return out;
}

/** pointwise percentile across simulated paths */
function pct(sorted, q) {
  if (!sorted.length) return NaN;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/**
 * Collapse simulated P&L paths into the fan the chart draws.
 * `scenarioIdx` picks ONE path to carry through untouched — a single future
 * with its fluctuation intact, which no percentile can show because a
 * pointwise quantile smooths across paths that never coexisted.
 */
export function summarisePaths(pnl, dates, levels, scenarioIdx = 0) {
  const M = pnl[0].length;
  const rows = [];
  for (let m = 0; m < M; m++) {
    const col = pnl.map((p) => p[m]).filter(Number.isFinite).sort((a, b) => a - b);
    const lvl = levels.map((p) => p[m]).filter(Number.isFinite).sort((a, b) => a - b);
    rows.push({
      date: dates[m],
      level: pct(lvl, 0.5),
      ret: pct(col, 0.5),
      mean: col.reduce((a, b) => a + b, 0) / col.length,
      lo: pct(col, 0.1),
      p25: pct(col, 0.25),
      p75: pct(col, 0.75),
      hi: pct(col, 0.9),
      scenario: pnl[scenarioIdx][m],
    });
  }
  return rows;
}

/**
 * Mark-to-market P&L of ONE straddle position, month by month to expiry.
 *
 * WHAT THIS REPLACES, AND WHY IT WAS WRONG. The previous version computed
 * kappa*sigma_m*sqrt(2/pi) - sigma_m*sqrt(2/pi)*markup - friction, which
 * collapses to sigma_m*(kappa - markup) - friction. sigma_m rises with the
 * horizon and the other three are constants, so the result was a monotone
 * function of sigma_m and could never change direction: measured on the live
 * book, all twelve series were monotone with zero sign changes. It also was
 * not a position at all. Evaluating a NEW straddle at every maturity is a
 * term structure of separate trades, not the life of one trade, so it had no
 * strike, no time decay and no financing.
 *
 * A real position has all three:
 *
 *   strike     struck at the money at inception, K = level now. Its value
 *              afterwards depends on how far the underlying has travelled
 *              FROM THERE, not on the absolute size of the forecast band.
 *   theta      remaining time value is sigma*sqrt(tau), and tau runs down.
 *              What the position gains from the underlying drifting away
 *              from the strike, it loses from the clock.
 *   financing  the premium is cash paid up front. Carrying it costs the
 *              short rate, which is the leverage cost of the option and
 *              accrues whether or not the trade works.
 *
 * The expectation is exact, not sampled. Simulating VAR paths and marking the
 * straddle on each converges to
 *
 *   E[V(m)] = sqrt(s_m^2 + v_m^2) * psi( mu_m / sqrt(s_m^2 + v_m^2) )
 *
 * because V(m) = E_Z|X + v_m Z| with X ~ N(mu_m, s_m^2), and two independent
 * normals combine in quadrature. Evaluating that closed form gives the mean
 * of the simulation with no sampling noise, and the band below is the
 * quantile map of the same distribution rather than a scatter of draws.
 *
 * The shape this produces is the one a straddle actually has. For a random
 * walk s_m^2 + v_m^2 is constant, so a fairly-priced straddle is a martingale
 * and expected P&L is exactly minus its costs — it bleeds. It only turns
 * positive if the VAR's drift carries the underlying away from the strike
 * faster than the clock runs down, and where mean reversion pulls it back the
 * position goes positive early and negative later. Nothing here is monotone
 * by construction.
 */
export function straddlePnlPath(samples, {
  level0,
  sigmaAnn,
  maturityMonths,
  markup,
  hfMarkup,
  friction,
  pnlScale = 1,
  riskFreeRate = 0,
}) {
  const Tyr = maturityMonths / 12;
  const v0 = sigmaAnn * Math.sqrt(Tyr);
  const fair = v0 * SQRT_2_OVER_PI; // ATM Bachelier premium at inception
  if (!(fair > 0)) return null;

  const premRet = fair * markup;
  const premHf = fair * hfMarkup;
  // entry and exit are both charged; the round trip is paid whatever happens
  const roundTrip = 2 * friction;

  // quantile grid for the band — a deterministic map of the forecast
  // distribution through the option's payoff, not a scatter of draws
  const GRID = 199;
  const zGrid = [];
  for (let i = 1; i <= GRID; i++) zGrid.push(normInv(i / (GRID + 1)));

  const rows = [];
  for (let m = 1; m <= Math.min(maturityMonths, samples.length); m++) {
    const s = samples[m - 1];
    const tau = (maturityMonths - m) / 12;
    const v = sigmaAnn * Math.sqrt(Math.max(0, tau));
    const mu = s.level - level0;
    const sd = s.sd;
    const comb = Math.hypot(sd, v);
    const ev = comb > 0 ? comb * psi(mu / comb) : Math.abs(mu);

    const carry = (p) => p * (Math.pow(1 + riskFreeRate, m / 12) - 1);
    const gross = (ev - fair) * pnlScale;
    const hf = (ev - premHf - carry(premHf) - roundTrip) * pnlScale;
    const ret = (ev - premRet - carry(premRet) - roundTrip) * pnlScale;

    // band on the retail line: push the forecast quantiles through the
    // straddle's value and read the 10th and 90th off the result
    const vals = zGrid.map((z) => bachelierStraddle(mu + sd * z, v)).sort((a, b) => a - b);
    const q = (p) => vals[Math.min(vals.length - 1, Math.max(0, Math.round(p * (vals.length - 1))))];
    const costs = premRet + carry(premRet) + roundTrip;

    rows.push({
      date: s.date,
      level: s.level,
      gross,
      hf,
      ret,
      lo: (q(0.1) - costs) * pnlScale,
      hi: (q(0.9) - costs) * pnlScale,
    });
  }
  return rows;
}
