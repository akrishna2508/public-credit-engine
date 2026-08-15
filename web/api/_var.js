/**
 * VAR(p) estimation, forecasting and impulse-response analysis in plain JS.
 *
 * This is a port of the rank-0 branch of engine/forecast.py — the branch the
 * Python pipeline actually takes on this data (the committed
 * future_projections.json / irf_contagion_matrix_*.json were produced by it):
 *
 *   1. difference every series once            (diff_df = original_df.diff())
 *   2. select the lag order by AIC             (VAR.select_order -> 'aic')
 *   3. fit the VAR by OLS                      (VAR(...).fit(p))
 *   4. forecast `horizon` steps, then cumulate
 *      the differences back onto the last level (was_differenced=True path)
 *   5. impulse responses: Psi_i for a 1-unit (1 bps) shock, and
 *      Theta_i = Psi_i · chol(Sigma) for a 1-std-dev orthogonalized shock
 *
 * Deliberately NOT ported: the Johansen cointegration test and the VECM
 * branch. `coint_johansen` needs a generalized eigenvalue solve that has no
 * honest short implementation here, so this module reports
 * `cointegration: "not tested"` rather than pretending a rank was estimated.
 * The API labels the method it actually used on every payload it returns.
 */

/* ------------------------------------------------------------------ */
/* dense linear algebra                                                */
/* ------------------------------------------------------------------ */

export const zeros = (r, c) => Array.from({ length: r }, () => new Array(c).fill(0));

export function eye(n) {
  const m = zeros(n, n);
  for (let i = 0; i < n; i++) m[i][i] = 1;
  return m;
}

export function transpose(a) {
  const r = a.length;
  const c = a[0].length;
  const out = zeros(c, r);
  for (let i = 0; i < r; i++) for (let j = 0; j < c; j++) out[j][i] = a[i][j];
  return out;
}

export function mmul(a, b) {
  const n = a.length;
  const k = b.length;
  const m = b[0].length;
  const out = zeros(n, m);
  for (let i = 0; i < n; i++) {
    const ai = a[i];
    const oi = out[i];
    for (let t = 0; t < k; t++) {
      const v = ai[t];
      if (v === 0) continue;
      const bt = b[t];
      for (let j = 0; j < m; j++) oi[j] += v * bt[j];
    }
  }
  return out;
}

/** Gauss-Jordan inverse with partial pivoting; null if singular */
export function inv(a) {
  const n = a.length;
  const m = a.map((row, i) => [...row, ...eye(n)[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r][col]) > Math.abs(m[piv][col])) piv = r;
    if (!Number.isFinite(m[piv][col]) || Math.abs(m[piv][col]) < 1e-12) return null;
    [m[col], m[piv]] = [m[piv], m[col]];
    const d = m[col][col];
    for (let j = 0; j < 2 * n; j++) m[col][j] /= d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r][col];
      if (f === 0) continue;
      for (let j = 0; j < 2 * n; j++) m[r][j] -= f * m[col][j];
    }
  }
  return m.map((row) => row.slice(n));
}

/** lower-triangular Cholesky factor; null if not positive definite */
export function chol(a) {
  const n = a.length;
  const L = zeros(n, n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = a[i][j];
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
      if (i === j) {
        if (!(s > 0)) return null;
        L[i][j] = Math.sqrt(s);
      } else {
        L[i][j] = s / L[j][j];
      }
    }
  }
  return L;
}

/** log|A| via LU with partial pivoting (A assumed positive definite here) */
export function logDet(a) {
  const n = a.length;
  const m = a.map((r) => [...r]);
  let ld = 0;
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r][col]) > Math.abs(m[piv][col])) piv = r;
    if (Math.abs(m[piv][col]) < 1e-300) return -Infinity;
    if (piv !== col) [m[col], m[piv]] = [m[piv], m[col]];
    ld += Math.log(Math.abs(m[col][col]));
    for (let r = col + 1; r < n; r++) {
      const f = m[r][col] / m[col][col];
      for (let j = col; j < n; j++) m[r][j] -= f * m[col][j];
    }
  }
  return ld;
}

/* ------------------------------------------------------------------ */
/* VAR(p) by OLS                                                       */
/* ------------------------------------------------------------------ */

/**
 * @param Y  T x K matrix of observations (already stationary/differenced)
 * @param p  lag order
 * @returns  { A: p x (K x K), c: K, sigma: K x K, nobs, K, p } or null
 */
export function fitVar(Y, p) {
  const T = Y.length;
  const K = Y[0].length;
  const nobs = T - p;
  const nparam = 1 + K * p;
  if (nobs <= nparam + 2) return null;
  if (p === 0) {
    // intercept-only candidate (statsmodels scores lag 0 in select_order)
    const mean = new Array(K).fill(0);
    for (const row of Y) for (let k = 0; k < K; k++) mean[k] += row[k] / T;
    const sigmaMle = zeros(K, K);
    for (const row of Y) {
      for (let a = 0; a < K; a++) {
        for (let b = 0; b < K; b++) sigmaMle[a][b] += ((row[a] - mean[a]) * (row[b] - mean[b])) / T;
      }
    }
    const ld0 = logDet(sigmaMle);
    return {
      A: [], c: mean, sigma: sigmaMle, sigmaMle, nobs: T, K, p: 0,
      aic: ld0 + (2 / T) * K, bic: ld0 + (Math.log(T) / T) * K, logDet: ld0,
    };
  }

  const X = zeros(nobs, nparam);
  const Z = zeros(nobs, K);
  for (let t = p; t < T; t++) {
    const row = X[t - p];
    row[0] = 1;
    for (let j = 1; j <= p; j++) {
      const src = Y[t - j];
      const off = 1 + (j - 1) * K;
      for (let m = 0; m < K; m++) row[off + m] = src[m];
    }
    Z[t - p] = Y[t].slice();
  }

  const Xt = transpose(X);
  const XtXi = inv(mmul(Xt, X));
  if (!XtXi) return null;
  const B = mmul(mmul(XtXi, Xt), Z); // nparam x K

  // residuals + covariance (df correction matches statsmodels VAR.fit)
  const U = zeros(nobs, K);
  for (let i = 0; i < nobs; i++) {
    for (let k = 0; k < K; k++) {
      let fit = 0;
      for (let r = 0; r < nparam; r++) fit += X[i][r] * B[r][k];
      U[i][k] = Z[i][k] - fit;
    }
  }
  const dfSigma = Math.max(1, nobs - nparam);
  const sigma = zeros(K, K);
  const sigmaMle = zeros(K, K);
  for (let a = 0; a < K; a++) {
    for (let b = 0; b < K; b++) {
      let s = 0;
      for (let i = 0; i < nobs; i++) s += U[i][a] * U[i][b];
      sigma[a][b] = s / dfSigma;
      sigmaMle[a][b] = s / nobs;
    }
  }

  const A = [];
  for (let j = 1; j <= p; j++) {
    const Aj = zeros(K, K);
    const off = 1 + (j - 1) * K;
    for (let k = 0; k < K; k++) for (let m = 0; m < K; m++) Aj[k][m] = B[off + m][k];
    A.push(Aj);
  }
  const c = new Array(K).fill(0).map((_, k) => B[0][k]);

  // statsmodels information criteria on the MLE covariance
  const ld = logDet(sigmaMle);
  const freeParams = p * K * K + K;
  return {
    A, c, sigma, sigmaMle, nobs, K, p,
    // the fitted residuals themselves. A Gaussian draw from sigma throws away
    // everything about the shocks except their covariance; resampling the
    // actual residual ROWS keeps their fat tails, their skew and their exact
    // cross-sectional dependence, which is what a credit panel is made of.
    U,
    aic: ld + (2 / nobs) * freeParams,
    bic: ld + (Math.log(nobs) / nobs) * freeParams,
    logDet: ld,
  };
}

/**
 * Lag order minimising AIC over 0..maxLags — statsmodels VAR.select_order.
 *
 * The subtlety that matters: every candidate must be scored on the SAME
 * effective sample (T - maxLags observations), otherwise a longer lag is
 * penalised for the observations it consumes and the AICs are not comparable.
 * Trimming the head by (maxLags - p) holds nobs fixed across candidates.
 */
export function selectLag(Y, maxLags = 12) {
  let best = 1;
  let bestAic = Infinity;
  for (let p = 0; p <= maxLags; p++) {
    const f = fitVar(Y.slice(maxLags - p), p);
    if (!f || !Number.isFinite(f.aic)) continue;
    if (f.aic < bestAic) {
      bestAic = f.aic;
      best = p;
    }
  }
  return Math.max(1, best); // engine/forecast.py: max(1, selected_orders['aic'])
}

/** iterate the fitted VAR forward `steps` periods from the tail of Y */
export function forecast(fit, Y, steps) {
  const { A, c, K, p } = fit;
  const hist = Y.slice(-p).map((r) => r.slice());
  const out = [];
  for (let s = 0; s < steps; s++) {
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
    out.push(y);
    hist.push(y);
  }
  return out;
}

/**
 * MA(inf) coefficients Psi_0..Psi_h — the response to a 1-unit shock.
 * Psi_0 = I; Psi_i = sum_{j=1..min(i,p)} A_j · Psi_{i-j}
 * @returns array of (h+1) K x K matrices, indexed [period][response][impulse]
 */
export function irfMa(fit, horizon) {
  const { A, K, p } = fit;
  const psi = [eye(K)];
  for (let i = 1; i <= horizon; i++) {
    let acc = zeros(K, K);
    for (let j = 1; j <= Math.min(i, p); j++) {
      const term = mmul(A[j - 1], psi[i - j]);
      for (let a = 0; a < K; a++) for (let b = 0; b < K; b++) acc[a][b] += term[a][b];
    }
    psi.push(acc);
  }
  return psi;
}

/** orthogonalized IRF: Theta_i = Psi_i · chol(Sigma) — 1 std-dev shock */
export function irfOrth(psi, sigma) {
  const P = chol(sigma);
  if (!P) return null;
  return psi.map((m) => mmul(m, P));
}

/* ------------------------------------------------------------------ */
/* panel alignment — port of forecast.build_dataframe                   */
/* ------------------------------------------------------------------ */

/**
 * Bin label for pandas `resample("B")`. The business-day bin labeled D spans
 * the half-open interval [D, next business day), so a Saturday or Sunday
 * observation folds BACKWARD onto the preceding Friday — and, because the
 * resample takes `.last()`, it overwrites Friday's own value.
 *
 * This is not a corner case here: the ICE BofA OAS series publish month-end
 * levels on calendar dates, so e.g. Sunday 2023-12-31 legitimately replaces
 * Friday 2023-12-29 in the panel. Dropping weekend rows instead (the obvious
 * reading) shifted 52 bps of CCC-B into the estimation sample and flipped the
 * AIC-selected lag order from 2 to 3.
 */
export function businessBinLabel(iso) {
  const d = new Date(iso + "T00:00:00Z");
  const dow = d.getUTCDay();
  if (dow === 6) d.setUTCDate(d.getUTCDate() - 1);
  else if (dow === 0) d.setUTCDate(d.getUTCDate() - 2);
  return d.toISOString().slice(0, 10);
}

/**
 * Port of engine/forecast.build_dataframe:
 *   DataFrame(frames).sort_index().resample("B").last().ffill().dropna()
 * @param cols      series names in FORECAST_HIERARCHY order
 * @param seriesMap name -> { "YYYY-MM-DD": value }
 * @returns { dates, levels } with levels[t][k] aligned to cols[k]
 */
export function alignPanel(cols, seriesMap) {
  const binned = cols.map((c) => {
    const m = new Map();
    for (const d of Object.keys(seriesMap[c] || {}).sort()) {
      const v = seriesMap[c][d];
      if (v != null && Number.isFinite(v)) m.set(businessBinLabel(d), v); // later date wins = .last()
    }
    return m;
  });
  let lo = null;
  let hi = null;
  for (const m of binned) {
    for (const d of m.keys()) {
      if (lo === null || d < lo) lo = d;
      if (hi === null || d > hi) hi = d;
    }
  }
  if (lo === null) return { dates: [], levels: [] };

  const dates = [];
  const levels = [];
  const carry = new Array(cols.length).fill(null);
  const cur = new Date(lo + "T00:00:00Z");
  const end = new Date(hi + "T00:00:00Z");
  while (cur <= end) {
    const dow = cur.getUTCDay();
    if (dow !== 0 && dow !== 6) {
      const iso = cur.toISOString().slice(0, 10);
      for (let k = 0; k < cols.length; k++) {
        const v = binned[k].get(iso);
        if (v !== undefined) carry[k] = v; // .last(), then .ffill() by carrying
      }
      if (carry.every((v) => v !== null)) {
        dates.push(iso);
        levels.push(carry.slice());
      }
    }
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return { dates, levels };
}

/* ------------------------------------------------------------------ */
/* end-to-end pipeline                                                 */
/* ------------------------------------------------------------------ */

/**
 * @param cols    series names, in FORECAST_HIERARCHY order
 * @param levels  T x K matrix of the level series (bps), aligned, no gaps
 * @param dates   T dates aligned with `levels`
 * @param horizon forecast/IRF periods
 */
export function runVarPipeline(cols, levels, dates, { horizon = 12, maxLags = 12 } = {}) {
  const T = levels.length;
  const K = cols.length;
  if (T < 60 || K < 2) {
    return { status: "UNAVAILABLE", why: `need >=60 aligned observations and >=2 series (got ${T} x ${K})` };
  }

  // step 1: first differences (engine/forecast.py rank-0 path)
  const D = [];
  for (let t = 1; t < T; t++) {
    D.push(levels[t].map((v, k) => v - levels[t - 1][k]));
  }

  // step 2 + 3: AIC lag order, then OLS fit
  const p = selectLag(D, Math.min(maxLags, Math.floor(D.length / (K * 4)) || 1));
  const fit = fitVar(D, p);
  if (!fit) return { status: "UNAVAILABLE", why: `VAR(${p}) is not estimable on ${D.length} differenced observations` };

  // step 4: forecast the differences, cumulate back onto the last level
  const fdiff = forecast(fit, D, horizon);
  const last = levels[T - 1];
  const flevels = [];
  const running = last.slice();
  for (const step of fdiff) {
    for (let k = 0; k < K; k++) running[k] += step[k];
    flevels.push(running.slice());
  }
  const futureDates = businessDays(dates[dates.length - 1], horizon);

  // step 5: impulse responses (1 bps unit shock + 1 std-dev orthogonalized)
  const psi = irfMa(fit, horizon);
  const theta = irfOrth(psi, fit.sigma);
  const irfDates = [dates[dates.length - 1], ...futureDates];

  const packIrf = (mats) => {
    if (!mats) return null;
    const out = {};
    for (let s = 0; s < K; s++) {
      const shock = {};
      for (let r = 0; r < K; r++) {
        const timeline = {};
        for (let i = 0; i < mats.length; i++) {
          timeline[irfDates[i] || `Period_${i}`] = round4(mats[i][r][s]);
        }
        shock[`Response_of_${cols[r]}`] = timeline;
      }
      out[`Shock_to_${cols[s]}`] = shock;
    }
    return out;
  };

  const projections = {};
  for (let k = 0; k < K; k++) {
    const t = {};
    for (let i = 0; i < flevels.length; i++) t[futureDates[i]] = round4(flevels[i][k]);
    projections[cols[k]] = t;
  }

  return {
    status: "OK",
    method: "VAR on first differences, forecast cumulated back to levels (engine/forecast.py rank-0 path)",
    cointegration: "not tested — the Johansen/VECM branch is not ported to the web runtime; the level series are differenced unconditionally, exactly as the rank-0 branch does",
    cols,
    lagOrder: p,
    nobs: fit.nobs,
    aic: round4(fit.aic),
    bic: round4(fit.bic),
    horizon,
    history: {
      dates: dates.slice(-120),
      series: Object.fromEntries(cols.map((c, k) => [c, levels.slice(-120).map((r) => round4(r[k]))])),
    },
    futureDates,
    projections,
    irfDates,
    irf1bps: packIrf(psi),
    irfStdDev: packIrf(theta),
    shockSizes: Object.fromEntries(cols.map((c, k) => [c, round4(Math.sqrt(fit.sigma[k][k]))])),
  };
}

function round4(v) {
  return Number.isFinite(v) ? Math.round(v * 10000) / 10000 : null;
}

/** next `n` business days strictly after `iso` (pandas bdate_range semantics) */
export function businessDays(iso, n) {
  const out = [];
  const d = new Date(iso + "T00:00:00Z");
  while (out.length < n) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}
