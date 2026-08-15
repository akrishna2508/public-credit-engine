/**
 * GET /api/recommend — unsupervised strong / neutral / weak classification.
 *
 * For every instrument the site covers, a realized total-return series is
 * built from history, ~24 performance and risk metrics are computed from it,
 * and the resulting matrix is handed to two unsupervised methods — PCA for
 * the quality axis and k-means for the grouping. Nothing is told what a good
 * instrument looks like; there are no labels anywhere in the pipeline.
 *
 * Per instrument the payload carries every metric value, the standardised
 * score, the cluster, and the metrics that drove it up or held it back.
 */
import {
  fredCsv, json, pmap, worldBank, cachedJson, CACHE_TTL,
  SPREAD_DURATION, BOND_DURATION,
} from "./_shared.js";
import { totalReturnSeries, computeMetrics, METRIC_META, METRIC_KEYS } from "./_metrics.js";
import { standardise, pca, kmeans, contributions } from "./_unsup.js";
import {
  RATING_ORDER, US_GRADES, CREDIT_PANEL, COUNTRIES, REGION_LABELS,
  DR_SERIES, DR_MAPPING, expectedLossByGrade,
} from "./_universe.js";

export const config = { runtime: "nodejs" };

const r4 = (v) => (Number.isFinite(v) ? Math.round(v * 10000) / 10000 : null);

/** z-score of the last observation against its own history */
function lastZ(rows) {
  const v = rows.map((r) => r.v).filter(Number.isFinite);
  if (v.length < 30) return NaN;
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  const sd = Math.sqrt(v.reduce((s, x) => s + (x - m) * (x - m), 0) / (v.length - 1));
  return sd > 0 ? (v[v.length - 1] - m) / sd : NaN;
}

async function build() {
  // risk-free rate for the excess-return metrics
  const rf = await fredCsv("DGS3MO", { start: "2024-01-01" });
  const riskFreePct = rf && !rf.unavailable && rf.rows?.length ? rf.rows[rf.rows.length - 1].v : 4;

  // expected loss by grade, for the valuation metrics on the US ladder
  const drKeys = Object.keys(DR_SERIES);
  const drRes = await pmap(drKeys, 2, (k) => fredCsv(DR_SERIES[k], { start: "2010-01-01" }));
  const drLatest = {};
  drKeys.forEach((k, i) => {
    const rr = drRes[i];
    drLatest[k] = rr && !rr.unavailable && rr.rows?.length
      ? { v: rr.rows[rr.rows.length - 1].v / 100 }
      : null;
  });
  const elBps = expectedLossByGrade(drLatest, { asBps: true });

  const items = [];

  /* ---- US credit grade ladder ---- */
  {
    const res = await pmap(RATING_ORDER, 4, (g) => fredCsv(US_GRADES[g].id, { start: "2010-01-01" }));
    RATING_ORDER.forEach((g, i) => {
      const r = res[i];
      if (!r || r.unavailable || !r.rows?.length) return;
      const series = totalReturnSeries(r.rows, SPREAD_DURATION, 252);
      // an OAS is already a spread over governments, so its total return is
      // an excess return: no bill rate is subtracted again
      const m = computeMetrics(series, 252, 0);
      if (!m) return;
      const oas = r.rows[r.rows.length - 1].v * 100;
      const el = elBps[g];
      items.push({
        id: `US_${g}`,
        name: g,
        label: US_GRADES[g].label,
        kind: "credit",
        group: "US grade ladder",
        asOf: r.rows[r.rows.length - 1].date,
        metrics: {
          ...m,
          carry_now_bps: oas,
          cheap_z: lastZ(r.rows),
          carry_to_vol: m.ann_vol_pct > 0 ? oas / 100 / m.ann_vol_pct : NaN,
          net_of_el_bps: el == null ? NaN : oas - el,
          cover_ratio: el ? oas / el : NaN,
        },
      });
    });
  }

  /* ---- EM and euro credit indices ---- */
  {
    const keys = Object.keys(CREDIT_PANEL).filter((k) => !k.startsWith("US_"));
    const res = await pmap(keys, 5, (k) => fredCsv(CREDIT_PANEL[k].id, { start: "2015-01-01" }));
    keys.forEach((k, i) => {
      const r = res[i];
      if (!r || r.unavailable || !r.rows?.length) return;
      const series = totalReturnSeries(r.rows, SPREAD_DURATION, 252);
      const m = computeMetrics(series, 252, 0); // OAS return is already excess
      if (!m) return;
      const oas = r.rows[r.rows.length - 1].v * 100;
      items.push({
        id: k,
        name: k,
        label: CREDIT_PANEL[k].label,
        kind: "credit",
        group: `EM credit — ${CREDIT_PANEL[k].family}`,
        asOf: r.rows[r.rows.length - 1].date,
        metrics: {
          ...m,
          carry_now_bps: oas,
          cheap_z: lastZ(r.rows),
          carry_to_vol: m.ann_vol_pct > 0 ? oas / 100 / m.ann_vol_pct : NaN,
        },
      });
    });
  }

  /* ---- sovereign 10-year curves ---- */
  {
    const isos = Object.keys(COUNTRIES).filter((i) => COUNTRIES[i].yield);
    const res = await pmap(isos, 6, (iso) => fredCsv(COUNTRIES[iso].yield, { start: "1990-01-01" }));
    isos.forEach((iso, i) => {
      const r = res[i];
      if (!r || r.unavailable || !r.rows?.length) return;
      const series = totalReturnSeries(r.rows, BOND_DURATION, 12);
      // a yield return is a TOTAL return, so the bill rate does come off
      const m = computeMetrics(series, 12, riskFreePct);
      if (!m) return;
      const y = r.rows[r.rows.length - 1].v * 100;
      items.push({
        id: iso,
        name: COUNTRIES[iso].name,
        label: `${COUNTRIES[iso].name} 10-year government bond`,
        kind: "sovereign",
        group: REGION_LABELS[COUNTRIES[iso].region] || COUNTRIES[iso].region,
        asOf: r.rows[r.rows.length - 1].date,
        metrics: {
          ...m,
          carry_now_bps: y,
          cheap_z: lastZ(r.rows),
          carry_to_vol: m.ann_vol_pct > 0 ? y / 100 / m.ann_vol_pct : NaN,
        },
      });
    });
  }

  if (items.length < 8) {
    return { status: "UNAVAILABLE", why: `only ${items.length} instruments had enough history to score` };
  }

  /* ---- unsupervised step, run WITHIN each asset class ---- */
  //
  // Pooling credit and sovereigns produced a classification that was almost
  // purely the asset class: 19 credit and 0 sovereigns strong, 3 credit and
  // 33 sovereigns weak, with mean Sharpe 1.30 against -0.08. That is a true
  // fact about the 2023-26 window — spreads tightened while rates sold off —
  // but as a recommendation it says only "credit beat govvies", which the
  // user already knows. Ranking inside each pool makes "strong" mean strong
  // against its own peers, which is the comparison an allocator can act on.
  const CLASSIFY_KEYS = METRIC_KEYS.filter((k) => METRIC_META[k].scaleFree);
  const pools = [
    { id: "credit", label: "Credit indices", rows: items.filter((i) => i.kind === "credit") },
    { id: "sovereign", label: "Sovereign curves", rows: items.filter((i) => i.kind === "sovereign") },
  ].filter((p) => p.rows.length >= 8);

  if (!pools.length) return { status: "UNAVAILABLE", why: "no pool had enough instruments to classify" };

  const scored = [];
  const poolInfo = [];
  const loadingsByPool = {};

  for (const pool of pools) {
    const { Z, usable } = standardise(pool.rows, CLASSIFY_KEYS, METRIC_META);
    const comp = pca(Z, 5);
    if (!comp) continue;

    // cluster on the reduced representation: in the raw standardised space
    // euclidean distance concentrates and k-means returned lopsided groups
    let keep = 1;
    let cum = comp.components[0].explained;
    while (keep < comp.components.length && cum < 0.7) cum += comp.components[keep++].explained;
    const reduced = pool.rows.map((_, i) => comp.components.slice(0, keep).map((c) => c.scores[i]));
    const km = kmeans(reduced, 3);
    if (!km) continue;

    // name the clusters AFTER fitting, by ranking centroids on the axis the
    // data produced
    const rank = [0, 1, 2].map((c) => {
      const sc = comp.scores.filter((_, i) => km.assign[i] === c);
      return { c, mean: sc.length ? sc.reduce((a, b) => a + b, 0) / sc.length : -Infinity, n: sc.length };
    }).sort((a, b) => b.mean - a.mean);
    const nameOf = {};
    ["strong", "neutral", "weak"].forEach((n, i) => { if (rank[i]) nameOf[rank[i].c] = n; });

    pool.rows.forEach((it, i) => {
      const { drivers, blockers } = contributions(Z[i], comp.loadings, usable, METRIC_META);
      scored.push({
        id: it.id,
        name: it.name,
        label: it.label,
        kind: it.kind,
        group: it.group,
        asOf: it.asOf,
        pool: pool.id,
        poolLabel: pool.label,
        classification: nameOf[km.assign[i]] || "neutral",
        score: r4(comp.scores[i]),
        metrics: Object.fromEntries(Object.entries(it.metrics).map(([k, v]) => [k, r4(v)])),
        z: Object.fromEntries(usable.map((k, j) => [k, r4(Z[i][j])])),
        drivers: drivers.map((d) => ({ key: d.key, label: d.label, z: r4(d.z), contribution: r4(d.contribution) })),
        blockers: blockers.map((d) => ({ key: d.key, label: d.label, z: r4(d.z), contribution: r4(d.contribution) })),
      });
    });

    loadingsByPool[pool.id] = usable
      .map((k, i) => ({ key: k, label: METRIC_META[k].label, group: METRIC_META[k].group, loading: r4(comp.loadings[i]) }))
      .sort((a, b) => Math.abs(b.loading) - Math.abs(a.loading));

    poolInfo.push({
      id: pool.id,
      label: pool.label,
      instruments: pool.rows.length,
      metricsUsedToClassify: usable.length,
      componentsUsedForClustering: keep,
      varianceInClustering: r4(cum * 100),
      varianceExplainedPC1: r4((comp.explained || 0) * 100),
      silhouette: r4(km.silhouette),
      kmeansRestarts: km.restarts,
      clusterSizes: Object.fromEntries(rank.map((c) => [nameOf[c.c], c.n])),
    });
  }

  if (!scored.length) return { status: "UNAVAILABLE", why: "no pool could be classified" };
  scored.sort((a, b) => b.score - a.score);

  return {
    status: "OK",
    generated: new Date().toISOString(),
    riskFreePct: r4(riskFreePct),
    model: {
      kind: "unsupervised — principal component analysis + k-means, run within each asset class",
      instruments: scored.length,
      metricsComputed: METRIC_KEYS.length,
      metricsDisplayedOnly: METRIC_KEYS.filter((k) => !METRIC_META[k].scaleFree),
      pools: poolInfo,
      labelled: "clusters are named after fitting, by ranking their centroids on the first principal component",
    },
    loadings: loadingsByPool,
    metricMeta: METRIC_META,
    items: scored,
    caveats: [
      "The classification is RELATIVE to the pool an instrument sits in — credit against credit, sovereigns against sovereigns. Nothing here says an instrument is good in absolute terms.",
      "Pooling the two together produced a classification that was almost purely the asset class: 19 credit and no sovereigns strong, mean Sharpe 1.30 against -0.08. True for the 2023-26 window, but it only restates that credit beat governments.",
      "No labels are used anywhere. PCA finds the axis along which instruments differ most and k-means groups on it; the words strong, neutral and weak are attached afterwards by ranking the centroids.",
      "All twenty-four metrics are computed and shown, but only the scale-free ones classify. Over the full set the first component correlates -0.92 with volatility and 0.46 with Sharpe — the dominant axis is risk SCALE, not quality, and it mislabelled EM high yield at a Sharpe of 2.08 as weak. Restricted to scale-free metrics it correlates 0.963 with Sharpe.",
      "A credit spread return is already an excess return, so no bill rate is subtracted from it; a sovereign yield return is a total return and does have it deducted.",
      "Metrics come from a total-return series built as carry minus duration times the level change, because no free source publishes total-return indices for these instruments.",
      "Silhouette measures how separated the clusters actually are. Near zero means the pool is a continuum and the boundaries are soft.",
      "Realized past performance is not a forecast. The forward-looking view is the Returns tab.",
    ],
  };
}

export default async function handler(req, res) {
  const cached = await cachedJson("recommend", "v1", CACHE_TTL.DERIVED, () => build());
  return json(res, { ...cached.doc, cache: { hit: !!cached.fromCache, stale: !!cached.stale } });
}
