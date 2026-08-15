/**
 * Unsupervised classification of instruments from their metric matrix.
 *
 * This is machine learning in the strict sense and, unlike the vector
 * autoregression behind the Drivers page, it is not econometrics: nothing
 * here is told what a good instrument looks like. There are no labels, no
 * training set and no target. Two classical unsupervised methods run over
 * the standardised metric matrix:
 *
 *   PCA      the leading principal component is the axis along which the
 *            instruments differ most. Because every column is oriented so
 *            that larger is better, that axis is a quality ordering the data
 *            found on its own, and its LOADINGS say which metrics built it.
 *   k-means  three clusters over the same matrix, k = 3 because the output
 *            asked for is strong / neutral / weak. The clusters are named
 *            afterwards by ranking their centroids along PC1 — the model
 *            groups, and only then does the grouping get a word attached.
 *
 * What this cannot do is tell you an instrument is good in any absolute
 * sense. It is a RELATIVE ranking inside the universe it was given: remove
 * the worst instrument and something else becomes weak. That is a property
 * of unsupervised clustering, not a defect, and the page says so.
 */

/** deterministic PRNG so the same universe always yields the same clusters */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

/**
 * Standardise each column to zero mean and unit variance, multiplied by its
 * direction so larger is always better.
 *
 * Missing values are filled with the column mean, i.e. zero after
 * standardising — an instrument with no expected-loss mapping is treated as
 * average on that metric rather than as a zero, which would have read as
 * strongly negative and quietly punished every EM index.
 */
export function standardise(rows, keys, meta) {
  const stats = {};
  for (const k of keys) {
    const vals = rows.map((r) => r.metrics[k]).filter((v) => Number.isFinite(v));
    const m = mean(vals);
    const sd = vals.length > 1
      ? Math.sqrt(vals.reduce((s, x) => s + (x - m) * (x - m), 0) / (vals.length - 1))
      : 0;
    stats[k] = { mean: m, sd, n: vals.length };
  }
  // a column that is constant, or that almost nothing reports, carries no
  // information and would only add noise to the components
  const usable = keys.filter((k) => stats[k].sd > 1e-9 && stats[k].n >= Math.max(4, rows.length * 0.5));
  const Z = rows.map((r) =>
    usable.map((k) => {
      const v = r.metrics[k];
      if (!Number.isFinite(v)) return 0;
      return ((v - stats[k].mean) / stats[k].sd) * (meta[k].dir || 1);
    })
  );
  return { Z, usable, stats };
}

/** leading eigenvector of a symmetric matrix by power iteration */
function leadingEigen(C, iters = 500) {
  const n = C.length;
  let v = new Array(n).fill(0).map((_, i) => Math.sin(i + 1) + 0.5);
  let lam = 0;
  for (let it = 0; it < iters; it++) {
    const w = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let j = 0; j < n; j++) s += C[i][j] * v[j];
      w[i] = s;
    }
    let nrm = Math.sqrt(w.reduce((s, x) => s + x * x, 0));
    if (!nrm || !Number.isFinite(nrm)) return null;
    for (let i = 0; i < n; i++) v[i] = w[i] / nrm;
    lam = nrm;
  }
  return { vector: v, value: lam };
}

/**
 * PCA on the standardised matrix. Returns the first component's loadings,
 * each row's score on it, and the share of total variance it explains — the
 * last one matters, because a component explaining 20% of the variance is not
 * a quality axis and the page should not pretend otherwise.
 */
export function pca(Z, nComp = 4) {
  const n = Z.length;
  const p = Z[0]?.length || 0;
  if (n < 3 || p < 2) return null;
  const C = Array.from({ length: p }, () => new Array(p).fill(0));
  for (let i = 0; i < p; i++) {
    for (let j = 0; j < p; j++) {
      let s = 0;
      for (let t = 0; t < n; t++) s += Z[t][i] * Z[t][j];
      C[i][j] = s / (n - 1);
    }
  }
  let trace = 0;
  for (let i = 0; i < p; i++) trace += C[i][i];

  // successive components by power iteration with Hotelling deflation:
  // after extracting a component, subtract lambda*vv' and repeat
  const comps = [];
  const work = C.map((r) => r.slice());
  for (let c = 0; c < Math.min(nComp, p); c++) {
    const eig = leadingEigen(work);
    if (!eig || !Number.isFinite(eig.value) || eig.value <= 1e-12) break;
    let load = eig.vector;
    if (c === 0) {
      // the sign of an eigenvector is arbitrary; orient the first so that
      // positive means better, which is what the columns were oriented for
      const bias = load.reduce((a, b) => a + b, 0);
      if (bias < 0) load = load.map((x) => -x);
    }
    comps.push({ loadings: load, value: eig.value, explained: trace > 0 ? eig.value / trace : NaN });
    for (let i = 0; i < p; i++) {
      for (let j = 0; j < p; j++) work[i][j] -= eig.value * load[i] * load[j];
    }
  }
  if (!comps.length) return null;

  const scoresFor = (load) => Z.map((row) => row.reduce((s, x, i) => s + x * load[i], 0));
  return {
    loadings: comps[0].loadings,
    scores: scoresFor(comps[0].loadings),
    explained: comps[0].explained,
    components: comps.map((c) => ({ loadings: c.loadings, explained: c.explained, scores: scoresFor(c.loadings) })),
  };
}

/**
 * k-means++ seeding then Lloyd's algorithm, repeated from several
 * initialisations and keeping the lowest-inertia solution.
 *
 * The restarts are not decoration. From a single seed the fit converged to a
 * local optimum that put 19 instruments in one cluster, 39 in another and
 * exactly ONE in the middle — a three-way classification with an empty middle
 * is not a classification. k-means is only guaranteed to find a local
 * optimum, so running it once and trusting the answer is the mistake.
 */
export function kmeans(Z, k = 3, seed = 20260815, iters = 100, restarts = 25) {
  let best = null;
  for (let r = 0; r < restarts; r++) {
    const cand = kmeansOnce(Z, k, seed + r * 7919, iters);
    if (!cand) continue;
    if (!best || cand.inertia < best.inertia) best = cand;
  }
  if (!best) return null;
  return { ...best, restarts };
}

function kmeansOnce(Z, k, seed, iters) {
  const n = Z.length;
  if (n < k) return null;
  const p = Z[0].length;
  const rand = rng(seed);
  const dist2 = (a, b) => {
    let s = 0;
    for (let i = 0; i < p; i++) s += (a[i] - b[i]) * (a[i] - b[i]);
    return s;
  };

  const centres = [Z[(rand() * n) | 0].slice()];
  while (centres.length < k) {
    const d = Z.map((z) => Math.min(...centres.map((c) => dist2(z, c))));
    const tot = d.reduce((a, b) => a + b, 0);
    let x = rand() * tot;
    let pick = 0;
    for (let i = 0; i < n; i++) {
      x -= d[i];
      if (x <= 0) { pick = i; break; }
    }
    centres.push(Z[pick].slice());
  }

  let assign = new Array(n).fill(0);
  for (let it = 0; it < iters; it++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bd = Infinity;
      for (let c = 0; c < k; c++) {
        const d = dist2(Z[i], centres[c]);
        if (d < bd) { bd = d; best = c; }
      }
      if (assign[i] !== best) { assign[i] = best; moved = true; }
    }
    for (let c = 0; c < k; c++) {
      const members = Z.filter((_, i) => assign[i] === c);
      if (!members.length) continue;
      for (let d = 0; d < p; d++) centres[c][d] = mean(members.map((m) => m[d]));
    }
    if (!moved && it > 0) break;
  }

  // silhouette: how well separated the clustering actually is, so a weak
  // grouping can be reported as weak instead of asserted as clean
  let sil = 0;
  let cnt = 0;
  for (let i = 0; i < n; i++) {
    const own = Z.filter((_, j) => assign[j] === assign[i] && j !== i);
    if (!own.length) continue;
    const a = mean(own.map((z) => Math.sqrt(dist2(Z[i], z))));
    let b = Infinity;
    for (let c = 0; c < k; c++) {
      if (c === assign[i]) continue;
      const other = Z.filter((_, j) => assign[j] === c);
      if (!other.length) continue;
      b = Math.min(b, mean(other.map((z) => Math.sqrt(dist2(Z[i], z)))));
    }
    if (Number.isFinite(a) && Number.isFinite(b) && Math.max(a, b) > 0) {
      sil += (b - a) / Math.max(a, b);
      cnt++;
    }
  }
  let inertia = 0;
  for (let i = 0; i < n; i++) inertia += dist2(Z[i], centres[assign[i]]);

  return { assign, centres, inertia, silhouette: cnt ? sil / cnt : NaN };
}

/**
 * What pushed this instrument up, and what is holding it back.
 *
 * The contribution of a metric to an instrument's PC1 score is its
 * standardised value times that metric's loading. A large positive
 * contribution is a driver; a large negative one is a blocker. Reading the
 * standardised value alone would be wrong — a metric the component barely
 * weights cannot be what is driving the classification.
 */
export function contributions(zRow, loadings, usable, meta, topN = 3) {
  const c = usable.map((k, i) => ({
    key: k,
    label: meta[k].label,
    z: zRow[i],
    loading: loadings[i],
    contribution: zRow[i] * loadings[i],
  }));
  const sorted = c.slice().sort((a, b) => b.contribution - a.contribution);
  return {
    drivers: sorted.filter((x) => x.contribution > 0).slice(0, topN),
    blockers: sorted.filter((x) => x.contribution < 0).reverse().slice(0, topN),
  };
}
