/**
 * GET /api/opportunities — a ranked board of tradeable public-credit ideas.
 *
 * Two books, both scored on the same honest metric:
 *
 *   CREDIT   every ICE BofA corporate OAS index the free FRED tier carries —
 *            EM by region, EM by quality, EM by sector, and the US grade
 *            ladder. For each: the current spread, where that spread sits in
 *            its own history (z-score), realised spread volatility, and a
 *            carry-to-volatility ratio.
 *
 *   SOVEREIGN every country with a live 10Y yield: the yield, the spread over
 *            the US 10Y, where the yield sits in its own history, and the
 *            real yield after the latest published inflation print.
 *
 * The ranking metric is `cheapZ` — the z-score of the CURRENT spread (or
 * yield) against its own trailing history. Positive means wider than its own
 * norm, i.e. you are being paid more than usual to take that risk. It is a
 * relative-value screen computed from real observations, deliberately NOT a
 * blended "opportunity score" with invented weights.
 */
import { fredCsv, json, pmap, zLast, pctReturn, worldBank } from "./_shared.js";
import { COUNTRIES, CREDIT_PANEL, WB_INDICATORS, CREDIT_SPREAD_DURATION, REGION_LABELS } from "./_universe.js";

export const config = { runtime: "nodejs" };

const TRADING_DAYS = 252;
const Z_WINDOW_DAILY = 1260; // ~5 years of business days
const Z_MIN_DAILY = 250;
const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
const r3 = (v) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null);

/** annualized stdev of daily first differences, in bps */
function spreadVolBps(rowsBps) {
  const d = [];
  for (let i = 1; i < rowsBps.length; i++) {
    const a = rowsBps[i - 1];
    const b = rowsBps[i];
    if (Number.isFinite(a) && Number.isFinite(b)) d.push(b - a);
  }
  const tail = d.slice(-TRADING_DAYS);
  if (tail.length < 60) return null;
  const mean = tail.reduce((a, b) => a + b, 0) / tail.length;
  const sd = Math.sqrt(tail.reduce((a, b) => a + (b - mean) ** 2, 0) / tail.length);
  return r2(sd * Math.sqrt(TRADING_DAYS));
}

function monthlyLast(rows) {
  const byM = new Map();
  for (const r of rows) byM.set(r.date.slice(0, 7), r);
  return [...byM.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export default async function handler(req, res) {
  /* ---------------- credit book ---------------- */
  const keys = Object.keys(CREDIT_PANEL);
  const results = await pmap(keys, 4, (k) => fredCsv(CREDIT_PANEL[k].id, { start: "2005-01-01" }));

  const creditBook = [];
  const creditUnavailable = [];
  keys.forEach((k, i) => {
    const r = results[i];
    const spec = CREDIT_PANEL[k];
    if (!r || r.unavailable || !r.rows?.length) {
      creditUnavailable.push({ id: k, label: spec.label, seriesId: spec.id, why: r?.unavailable || "no rows" });
      return;
    }
    const rows = r.rows;
    const bps = rows.map((x) => x.v * 100);
    const last = rows[rows.length - 1];
    const oas = r2(last.v * 100);
    const monthly = monthlyLast(rows);
    const chg1m = monthly.length > 1 ? r2((monthly[monthly.length - 1].v - monthly[monthly.length - 2].v) * 100) : null;
    const chg3m = monthly.length > 3 ? r2((monthly[monthly.length - 1].v - monthly[monthly.length - 4].v) * 100) : null;
    const chg12m = monthly.length > 12 ? r2((monthly[monthly.length - 1].v - monthly[monthly.length - 13].v) * 100) : null;
    const vol = spreadVolBps(bps);
    const cheapZ = zLast(rows, Z_WINDOW_DAILY, Z_MIN_DAILY);
    creditBook.push({
      id: k,
      kind: "credit",
      label: spec.label,
      family: spec.family,
      seriesId: spec.id,
      asOf: last.date,
      oas_bps: oas,
      cheapZ,
      cheapLabel: cheapZ == null ? null : cheapZ > 1 ? "wide vs own history" : cheapZ < -1 ? "tight vs own history" : "near own norm",
      spread_vol_bps: vol,
      carry_to_vol: vol && oas ? r3(oas / vol) : null,
      chg_1m_bps: chg1m,
      chg_3m_bps: chg3m,
      chg_12m_bps: chg12m,
      carry_1m_pct: chg1m == null ? null : r3(-(chg1m / 100) * CREDIT_SPREAD_DURATION),
      history_start: rows[0].date,
      observations: rows.length,
    });
  });

  /* ---------------- sovereign book ---------------- */
  const sovIsos = Object.keys(COUNTRIES).filter((iso) => COUNTRIES[iso].yield);
  const sovRes = await pmap(sovIsos, 6, (iso) => fredCsv(COUNTRIES[iso].yield, { start: "2005-01-01" }));
  const sovRows = {};
  sovIsos.forEach((iso, i) => {
    const r = sovRes[i];
    if (r && !r.unavailable && r.rows?.length) sovRows[iso] = r.rows;
  });
  const usRows = sovRows.US;
  const us10 = usRows ? usRows[usRows.length - 1].v : null;

  const infl = await worldBank(
    WB_INDICATORS.inflation.id,
    sovIsos.map((i) => COUNTRIES[i].iso3)
  );
  const inflLatest = infl && !infl.unavailable ? infl.latest : null;

  const sovereignBook = [];
  for (const iso of sovIsos) {
    const rows = sovRows[iso];
    if (!rows) continue;
    const spec = COUNTRIES[iso];
    const last = rows[rows.length - 1];
    const cheapZ = zLast(rows, 126, 24);
    const inf = inflLatest?.get(spec.iso3);
    sovereignBook.push({
      id: iso,
      kind: "sovereign",
      label: `${spec.name} 10Y government bond`,
      iso,
      name: spec.name,
      region: REGION_LABELS[spec.region] || spec.region,
      regionKey: spec.region,
      seriesId: spec.yield,
      asOf: last.date,
      yield_pct: r3(last.v),
      vs_us_10y_bps: us10 == null ? null : r2((last.v - us10) * 100),
      cheapZ,
      cheapLabel: cheapZ == null ? null : cheapZ > 1 ? "yield high vs own history" : cheapZ < -1 ? "yield low vs own history" : "near own norm",
      real_yield_pct: inf ? r3(last.v - inf.v) : null,
      inflation_pct: inf ? r2(inf.v) : null,
      inflation_year: inf ? Number(inf.year) : null,
      history_start: rows[0].date,
      observations: rows.length,
    });
  }

  const byCheap = (a, b) => (b.cheapZ ?? -99) - (a.cheapZ ?? -99);
  creditBook.sort(byCheap);
  sovereignBook.sort(byCheap);

  json(res, {
    status: "OK",
    generated: new Date().toISOString(),
    schema: "opportunities.v1",
    ranking: {
      metric: "cheapZ",
      definition:
        "z-score of the current spread (credit) or yield (sovereign) against its own trailing history — 5 years of business days for credit, 126 monthly observations for sovereigns. Positive means you are paid more than that instrument's own norm.",
      caution:
        "A relative-value screen, not a recommendation. A wide spread can be wide because the credit deteriorated; pair it with the default-rate and forecast pages before acting.",
    },
    credit: creditBook,
    sovereign: sovereignBook,
    unavailable: creditUnavailable,
    coverage: {
      creditIndices: creditBook.length,
      creditUnavailable: creditUnavailable.length,
      sovereigns: sovereignBook.length,
    },
    sources: [
      "FRED — ICE BofA option-adjusted spreads (EM corporate by region/quality/sector, US corporate grade ladder)",
      "FRED — OECD long-term government bond yields",
      "World Bank — consumer price inflation (annual, lagged) for the real-yield column",
    ],
  });
}
