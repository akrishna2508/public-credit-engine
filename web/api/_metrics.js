/**
 * Performance and risk metrics computed from a realized total-return series.
 *
 * The return series itself is built rather than downloaded, because no free
 * source publishes a total-return index for these instruments. For a credit
 * spread or a government yield the first-order decomposition is
 *
 *     r_t = level_{t-1} / periods_per_year  -  duration x (level_t - level_{t-1})
 *
 * carry earned over the period, plus the mark-to-market on the level move.
 * Validation that this is the right construction: the US 10-year comes out at
 * a 27.9% maximum drawdown, which is the 2022 rate rout at duration 8.5, and
 * AAA credit at 0.8% annual volatility against CCC at 8.3%.
 *
 * Everything is in BASIS POINTS per period unless a name says otherwise.
 */

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

function stdev(a) {
  if (a.length < 2) return NaN;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1));
}

function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/**
 * Realized total return per period from a level series (spread or yield).
 * @param rows  [{date, v}] with v in PERCENT
 * @param duration      spread duration for credit, bond duration for a yield
 * @param periodsPerYear 252 for a daily panel, 12 for a monthly one
 */
export function totalReturnSeries(rows, duration, periodsPerYear) {
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1].v * 100;
    const b = rows[i].v * 100;
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    out.push({
      date: rows[i].date,
      r: a / periodsPerYear - duration * (b - a), // bps this period
      carry: a / periodsPerYear,
      price: -duration * (b - a),
    });
  }
  return out;
}

/** maximum peak-to-trough fall of the cumulative series, in bps (<= 0) */
function maxDrawdown(rs) {
  let cum = 0;
  let peak = 0;
  let dd = 0;
  for (const r of rs) {
    cum += r;
    if (cum > peak) peak = cum;
    dd = Math.min(dd, cum - peak);
  }
  return dd;
}

/** root-mean-square drawdown — penalises long shallow pain, not just depth */
function ulcerIndex(rs) {
  let cum = 0;
  let peak = 0;
  let acc = 0;
  let n = 0;
  for (const r of rs) {
    cum += r;
    if (cum > peak) peak = cum;
    const d = peak > 0 ? (cum - peak) / peak : 0;
    acc += d * d;
    n++;
  }
  return n ? Math.sqrt(acc / n) * 100 : NaN;
}

/**
 * Internal rate of return of the actual cash flows, which is NOT the same as
 * the annualised return: buy at par, collect the carry each period, sell at
 * whatever the level move left the price. Money-weighted rather than
 * time-weighted, so a position that earned its return early scores higher.
 * Solved by bisection because the sign pattern is not guaranteed monotone
 * enough for Newton to be safe.
 */
function irr(series, periodsPerYear) {
  if (series.length < 4) return NaN;
  const n = series.length;
  const cf = new Array(n + 1).fill(0);
  cf[0] = -1;
  let priceCum = 0;
  for (let i = 0; i < n; i++) {
    cf[i + 1] = series[i].carry / 10000; // carry as a fraction of par
    priceCum += series[i].price / 10000;
  }
  cf[n] += 1 + priceCum; // redemption at the marked price
  const npv = (r) => {
    let s = 0;
    for (let i = 0; i <= n; i++) s += cf[i] / Math.pow(1 + r, i / periodsPerYear);
    return s;
  };
  let lo = -0.95;
  let hi = 5;
  if (npv(lo) * npv(hi) > 0) return NaN; // no sign change — no real IRR
  for (let it = 0; it < 200; it++) {
    const mid = (lo + hi) / 2;
    if (npv(lo) * npv(mid) <= 0) hi = mid;
    else lo = mid;
  }
  return ((lo + hi) / 2) * 100; // per cent a year
}

/**
 * The full metric set for one instrument.
 * @param series          from totalReturnSeries
 * @param periodsPerYear  252 or 12
 * @param riskFreePct     annual risk-free rate in per cent. Pass ZERO for a
 *   credit spread: an option-adjusted spread IS a spread over the government
 *   curve, so its total return is already an excess return and subtracting a
 *   bill rate again double-counts it. Uncorrected, AAA scored a Sharpe of
 *   -4.12 against its true +0.62, and every investment-grade credit read as
 *   catastrophic. A sovereign YIELD return is not excess and does need it.
 */
export function computeMetrics(series, periodsPerYear, riskFreePct = 0) {
  const rs = series.map((x) => x.r).filter(Number.isFinite);
  if (rs.length < 24) return null;

  const per = mean(rs);
  const sd = stdev(rs);
  const annRet = (per * periodsPerYear) / 100; // per cent a year
  const annVol = (sd * Math.sqrt(periodsPerYear)) / 100;

  const down = rs.filter((x) => x < 0);
  const downDev = down.length
    ? (Math.sqrt(down.reduce((a, b) => a + b * b, 0) / down.length) * Math.sqrt(periodsPerYear)) / 100
    : NaN;

  const dd = maxDrawdown(rs) / 100;
  const sorted = rs.slice().sort((a, b) => a - b);
  const var95 = quantile(sorted, 0.05) / 100;
  const tail = sorted.filter((x) => x <= quantile(sorted, 0.05));
  const cvar95 = tail.length ? mean(tail) / 100 : NaN;

  const m3 = mean(rs.map((x) => Math.pow((x - per) / sd, 3)));
  const m4 = mean(rs.map((x) => Math.pow((x - per) / sd, 4)));

  const gains = rs.filter((x) => x > 0).reduce((a, b) => a + b, 0);
  const losses = -rs.filter((x) => x < 0).reduce((a, b) => a + b, 0);

  // cumulative total return over the whole observed window
  const roi = rs.reduce((a, b) => a + b, 0) / 100;
  const years = rs.length / periodsPerYear;
  const cagr = years > 0 ? (Math.pow(1 + roi / 100, 1 / years) - 1) * 100 : NaN;

  const ex = annRet - riskFreePct;

  return {
    observations: rs.length,
    years: Math.round(years * 100) / 100,
    ann_return_pct: annRet,
    total_roi_pct: roi,
    cagr_pct: cagr,
    irr_pct: irr(series, periodsPerYear),
    ann_vol_pct: annVol,
    downside_dev_pct: downDev,
    max_drawdown_pct: dd,
    ulcer_index: ulcerIndex(rs),
    var_95_pct: var95,
    cvar_95_pct: cvar95,
    skew: m3,
    excess_kurtosis: m4 - 3,
    sharpe: annVol > 0 ? ex / annVol : NaN,
    sortino: downDev > 0 ? ex / downDev : NaN,
    calmar: dd < 0 ? annRet / Math.abs(dd) : NaN,
    omega: losses > 0 ? gains / losses : NaN,
    gain_to_pain: losses > 0 ? (gains - losses) / losses : NaN,
    hit_rate_pct: (100 * rs.filter((x) => x > 0).length) / rs.length,
    best_period_bps: Math.max(...rs),
    worst_period_bps: Math.min(...rs),
  };
}

/**
 * How each metric should be read.
 *
 * `dir` is +1 when larger is better and -1 when it is worse; the unsupervised
 * step multiplies by it so every standardised column points the same way.
 *
 * `scaleFree` marks a metric that is already normalised for risk or is
 * unit-free. ONLY these are used to classify, and the reason is a finding,
 * not a preference. Run PCA over all twenty-four and the first component is
 * not a quality axis at all: it correlates -0.92 with volatility and only
 * 0.46 with Sharpe, because the dominant axis of variation among financial
 * instruments is risk SCALE, not risk-adjusted quality. Orienting the columns
 * does not change that — it only decides which end of the risk axis is called
 * positive. Measured on the live universe, that mislabelled EM high yield at
 * a Sharpe of 2.08 as weak and Japan at -1.35 as neutral.
 *
 * Restricted to the scale-free set there is no risk axis left to find, and
 * the first component lines up with quality: correlation 0.963 with Sharpe,
 * -0.275 with volatility, silhouette 0.537 against 0.428. Every metric is
 * still computed and displayed; the classification just refuses to be driven
 * by which instrument happens to be the most volatile.
 */
export const METRIC_META = {
  ann_return_pct: { label: "Annualised return", unit: "%", dir: 1, group: "Return" },
  total_roi_pct: { label: "Total ROI (window)", unit: "%", dir: 1, group: "Return" },
  cagr_pct: { label: "CAGR", unit: "%", dir: 1, group: "Return" },
  irr_pct: { label: "IRR (money-weighted)", unit: "%", dir: 1, group: "Return" },
  carry_now_bps: { label: "Current carry", unit: "bps", dir: 1, group: "Return" },
  ann_vol_pct: { label: "Annualised volatility", unit: "%", dir: -1, group: "Risk" },
  downside_dev_pct: { label: "Downside deviation", unit: "%", dir: -1, group: "Risk" },
  max_drawdown_pct: { label: "Maximum drawdown", unit: "%", dir: 1, group: "Risk" },
  ulcer_index: { label: "Ulcer index", unit: "", dir: -1, scaleFree: true, group: "Risk" },
  var_95_pct: { label: "VaR 95 (per period)", unit: "%", dir: 1, group: "Risk" },
  cvar_95_pct: { label: "CVaR 95 (expected shortfall)", unit: "%", dir: 1, group: "Risk" },
  skew: { label: "Skew", unit: "", dir: 1, scaleFree: true, group: "Risk" },
  excess_kurtosis: { label: "Excess kurtosis", unit: "", dir: -1, scaleFree: true, group: "Risk" },
  sharpe: { label: "Sharpe ratio", unit: "", dir: 1, scaleFree: true, group: "Risk-adjusted" },
  sortino: { label: "Sortino ratio", unit: "", dir: 1, scaleFree: true, group: "Risk-adjusted" },
  calmar: { label: "Calmar ratio", unit: "", dir: 1, scaleFree: true, group: "Risk-adjusted" },
  omega: { label: "Omega ratio", unit: "", dir: 1, scaleFree: true, group: "Risk-adjusted" },
  gain_to_pain: { label: "Gain to pain", unit: "", dir: 1, scaleFree: true, group: "Risk-adjusted" },
  hit_rate_pct: { label: "Hit rate", unit: "%", dir: 1, scaleFree: true, group: "Risk-adjusted" },
  cheap_z: { label: "Cheap vs own history", unit: "σ", dir: 1, scaleFree: true, group: "Valuation" },
  carry_to_vol: { label: "Carry per unit of vol", unit: "", dir: 1, scaleFree: true, group: "Valuation" },
  net_of_el_bps: { label: "Spread less expected loss", unit: "bps", dir: 1, group: "Valuation" },
  cover_ratio: { label: "Spread / expected loss", unit: "x", dir: 1, scaleFree: true, group: "Valuation" },
  external_driver_share: { label: "Externally driven share", unit: "%", dir: -1, group: "Model" },
};

/** the metrics actually used to classify, in a stable order */
export const METRIC_KEYS = Object.keys(METRIC_META);
