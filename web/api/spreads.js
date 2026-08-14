/**
 * GET /api/spreads — compensation for HOLDING credit, net of expected loss.
 *
 * This is the buy-and-hold book, and it is deliberately the opposite of
 * /api/returns. There is no dealer markup, no straddle premium and no
 * execution friction anywhere in this file, because none of them are charged
 * to someone who buys a bond and holds it. The only deduction is the loss you
 * actually expect to suffer:
 *
 *   spread_minus_EL[grade](t) = OAS[grade](t) * 100  -  EL[grade] * 10000   [bps]
 *   EL[grade]                 = default-rate proxy   x  published LGD
 *
 * and, for the relative-value rungs the forecast page models, the same net of
 * the difference between two grades:
 *
 *   spread_minus_EL[riskier - safer](t)
 *       = (OAS_riskier - OAS_safer) * 100 - (EL_riskier - EL_safer) * 10000
 *
 * A positive number is what the market pays you, in basis points a year,
 * beyond the losses the default-rate proxy says you should expect. That is
 * the honest answer to "what do I earn for owning this", and it is the series
 * the Python pipeline persists as spread-el_grades.json.
 */
import { fredCsv, json, unavailable, pmap, zLast } from "./_shared.js";
import {
  RATING_ORDER, US_GRADES, PUBLISHED_LGD, DR_SERIES, DR_MAPPING,
  ADJACENT_PAIRS, expectedLossByGrade, CREDIT_PANEL,
} from "./_universe.js";

export const config = { runtime: "nodejs" };

const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
const r4 = (v) => (Number.isFinite(v) ? Math.round(v * 10000) / 10000 : null);

/** daily -> weekly (last observation per ISO week) to keep the payload small */
function weekly(rows) {
  const byW = new Map();
  for (const r of rows) {
    const d = new Date(r.date + "T00:00:00Z");
    const key = d.toISOString().slice(0, 7) + "-" + Math.floor(d.getUTCDate() / 7);
    byW.set(key, r);
  }
  return [...byW.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export default async function handler(req, res) {
  /* ---------- grade OAS curves + default-rate proxies ---------- */
  const oasList = await pmap(RATING_ORDER, 4, (g) => fredCsv(US_GRADES[g].id, { start: "2005-01-01" }));
  const oasRows = {};
  RATING_ORDER.forEach((g, i) => {
    const r = oasList[i];
    if (r && !r.unavailable && r.rows?.length) oasRows[g] = r.rows;
  });
  if (!Object.keys(oasRows).length) {
    return unavailable(res, "credit-grade OAS unavailable — needs FRED_API_KEY on this deployment");
  }

  const drKeys = Object.keys(DR_SERIES);
  const drList = await pmap(drKeys, 2, (k) => fredCsv(DR_SERIES[k], { start: "2005-01-01" }));
  const drLatest = {};
  drKeys.forEach((k, i) => {
    const r = drList[i];
    const rows = r && !r.unavailable ? r.rows : null;
    drLatest[k] = rows?.length ? { v: rows[rows.length - 1].v / 100, date: rows[rows.length - 1].date } : null;
  });

  const elFrac = expectedLossByGrade(drLatest);
  const elBps = expectedLossByGrade(drLatest, { asBps: true });

  /* ---------- per-grade: OAS, EL and spread minus EL ---------- */
  const grades = {};
  const netSeries = {};
  for (const g of RATING_ORDER) {
    const rows = oasRows[g];
    if (!rows) {
      grades[g] = { status: "UNAVAILABLE", why: `FRED ${US_GRADES[g].id} returned no observations` };
      continue;
    }
    const el = elBps[g];
    const last = rows[rows.length - 1];
    const oasBps = last.v * 100;
    const w = weekly(rows);
    const netPoints = el == null ? null : w.map((r) => [r.date, r4(r.v * 100 - el)]);
    if (netPoints) netSeries[g] = netPoints;

    grades[g] = {
      status: "OK",
      grade: g,
      tier: US_GRADES[g].tier,
      seriesId: US_GRADES[g].id,
      label: US_GRADES[g].label,
      asOf: last.date,
      oas_bps: r2(oasBps),
      expected_loss_bps: el,
      expected_loss_pct: elFrac[g] == null ? null : r4(elFrac[g] * 100),
      lgd: PUBLISHED_LGD[g],
      default_rate_pct: (() => {
        const dr = drLatest[DR_MAPPING[g]];
        return dr ? r4(dr.v * 100) : null;
      })(),
      net_of_expected_loss_bps: el == null ? null : r2(oasBps - el),
      cover_ratio: el ? r2(oasBps / el) : null,
      oas_z: zLast(rows, 1260, 250),
      history: {
        oas: w.map((r) => [r.date, r2(r.v * 100)]),
        net: netPoints,
      },
      start: rows[0].date,
      observations: rows.length,
    };
  }

  /* ---------- adjacent rungs: the pair series the VAR models ---------- */
  const pairs = {};
  for (const [riskier, safer] of ADJACENT_PAIRS) {
    const name = `${riskier} - ${safer}`;
    const hi = oasRows[riskier];
    const lo = oasRows[safer];
    const a = elBps[riskier];
    const b = elBps[safer];
    if (!hi || !lo || a == null || b == null) {
      pairs[name] = { status: "UNAVAILABLE", why: "one leg of the rung has no live series or no expected-loss estimate" };
      continue;
    }
    const elDiff = r4(a - b);
    const loMap = new Map(lo.map((r) => [r.date, r.v]));
    const pts = [];
    for (const r of weekly(hi)) {
      const other = loMap.get(r.date);
      if (other == null) continue;
      pts.push([r.date, r4((r.v - other) * 100 - elDiff)]);
    }
    const lastPt = pts.length ? pts[pts.length - 1][1] : null;
    pairs[name] = {
      status: "OK",
      name,
      riskier,
      safer,
      el_diff_bps: elDiff,
      spread_diff_bps: r2((hi[hi.length - 1].v - (loMap.get(hi[hi.length - 1].date) ?? NaN)) * 100),
      net_of_expected_loss_bps: lastPt,
      standsFor: `${US_GRADES[riskier].label} minus ${US_GRADES[safer].label}, net of the expected-loss difference between the two grades`,
      history: pts,
      observations: pts.length,
    };
  }

  /* ---------- the wider index book, spread only (no EL published) ---------- */
  const panelKeys = Object.keys(CREDIT_PANEL).filter((k) => !k.startsWith("US_"));
  const panelRes = await pmap(panelKeys, 4, (k) => fredCsv(CREDIT_PANEL[k].id, { start: "2005-01-01" }));
  const indices = [];
  panelKeys.forEach((k, i) => {
    const r = panelRes[i];
    if (!r || r.unavailable || !r.rows?.length) return;
    const rows = r.rows;
    const last = rows[rows.length - 1];
    indices.push({
      id: k,
      label: CREDIT_PANEL[k].label,
      family: CREDIT_PANEL[k].family,
      seriesId: CREDIT_PANEL[k].id,
      asOf: last.date,
      oas_bps: r2(last.v * 100),
      oas_z: zLast(rows, 1260, 250),
      history: weekly(rows).map((x) => [x.date, r2(x.v * 100)]),
      note: "No published default-rate proxy maps to this index, so no expected-loss deduction is applied and the spread is shown gross.",
    });
  });

  const scored = RATING_ORDER.filter((g) => grades[g]?.status === "OK" && grades[g].net_of_expected_loss_bps != null);

  json(res, {
    status: "OK",
    generated: new Date().toISOString(),
    schema: "spreads.v1",
    definition:
      "Compensation for holding credit, in basis points a year, after subtracting the expected loss implied by the default-rate proxy and the published loss-given-default. No dealer markup, straddle premium or execution friction is charged anywhere on this page — those are costs of trading volatility, not of owning a bond.",
    grades,
    order: RATING_ORDER,
    pairs,
    pairOrder: ADJACENT_PAIRS.map(([a, b]) => `${a} - ${b}`),
    indices,
    expectedLoss: {
      byGradeBps: elBps,
      byGradeFraction: elFrac,
      lgd: PUBLISHED_LGD,
      defaultRateProxies: Object.fromEntries(
        drKeys.map((k) => [
          k,
          drLatest[k]
            ? { seriesId: DR_SERIES[k], rate_pct: r4(drLatest[k].v * 100), asOf: drLatest[k].date }
            : { seriesId: DR_SERIES[k], status: "UNAVAILABLE" },
        ])
      ),
      mapping: DR_MAPPING,
      note: "Expected loss = default-rate proxy x loss-given-default. The investment-grade rungs use the business-loan delinquency proxy and the high-yield rungs the consumer-credit charge-off proxy, exactly as config.DR_MAPPING specifies. A missing proxy makes the grade unavailable rather than zero.",
    },
    coverage: {
      gradesCovered: scored.length,
      gradesTotal: RATING_ORDER.length,
      pairsCovered: Object.values(pairs).filter((p) => p.status === "OK").length,
      indicesCovered: indices.length,
    },
    caution:
      "Expected loss here is a market-wide proxy applied uniformly to a grade, not an issuer-level estimate. A high cover ratio says the index is paid well relative to that proxy; it does not say any individual bond is safe.",
  });
}
