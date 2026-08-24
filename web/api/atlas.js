/**
 * GET /api/atlas — the global opportunity map.
 *
 * Heat is a 1-month TOTAL-RETURN PROXY IN USD, so the world map is coloured by
 * the returns it actually reports. Up to three legs, each independently
 * sourced and each reported with its own value so the composite is auditable:
 *
 *   bond    local 10Y price proxy  = -(Δ1M yield in bps / 100) x duration 8.5
 *           converted to USD by compounding with the currency's 1M move
 *   equity  US/LN-listed country ETF 1M return (already USD-denominated)
 *   credit  regional EM corporate OAS carry proxy
 *           = -(Δ1M OAS bps / 100) x spread duration 4.5
 *
 *   heat = unweighted mean of the legs that exist for that country
 *
 * A country with no free 10Y series (China, Brazil, Indonesia, Turkey, the
 * Gulf, much of emerging Asia) reports the bond leg as UNAVAILABLE and is
 * scored on the legs that are real. Nothing is imputed.
 */
import {
  fredCsv, ecbCsv, yahooChart, json, pmap, pctReturn, zLast, worldBank,
  cachedJson, CACHE_TTL,
} from "./_shared.js";
import {
  COUNTRIES, REGION_LABELS, CREDIT_INDICES, WB_INDICATORS, DURATION, CREDIT_SPREAD_DURATION,
  FALLEN_ANGEL_ETFS,
} from "./_universe.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUNDLE_PATH = join(__dirname, "..", "public", "data", "bundle.json");
function getStaticGenerated() {
  try {
    const raw = readFileSync(BUNDLE_PATH, "utf8");
    return JSON.parse(raw).generated;
  } catch {
    return null;
  }
}
const STATIC_GENERATED = getStaticGenerated();

export const config = { runtime: "nodejs" };

const Z_WINDOW = 126; // ~10 years of monthly observations
const Z_MIN = 24;
const r3 = (v) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null);
const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);

/** monthly yield changes in bps at 1 / 3 / 12 month horizons */
function yieldChangesBps(rows) {
  if (!rows.length) return null;
  const last = rows[rows.length - 1].v;
  const out = {};
  let ok = false;
  for (const h of [1, 3, 12]) {
    const i = rows.length - 1 - h;
    if (i >= 0) {
      out[h] = r2((last - rows[i].v) * 100);
      ok = true;
    }
  }
  return ok ? out : null;
}

/** collapse a daily series to one observation per month (last of month) */
function toMonthly(rows) {
  const byM = new Map();
  for (const r of rows) byM.set(r.date.slice(0, 7), r);
  return [...byM.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export default async function handler(req, res) {
  // The fan-out is ~200 upstream series across 84 countries. Each one is
  // individually cached, but re-assembling the atlas still costs a second or
  // two of alignment and z-scoring on every request, so the assembled
  // document is cached too.
  const cached = await cachedJson("atlas", "v2", CACHE_TTL.DERIVED, () => buildAtlas());
  json(res, { ...cached.doc, cache: { hit: !!cached.fromCache, stale: !!cached.stale } });
}

async function buildAtlas() {
  const isoList = Object.keys(COUNTRIES);

  /* ---------------- 1. sovereign yields (FRED, monthly) ---------------- */
  const yieldJobs = isoList.filter((iso) => COUNTRIES[iso].yield);
  const yieldRes = await pmap(yieldJobs, 6, (iso) =>
    fredCsv(COUNTRIES[iso].yield, { start: "2005-01-01" })
  );
  const yieldRows = {};
  yieldJobs.forEach((iso, i) => {
    const r = yieldRes[i];
    if (r && !r.unavailable && r.rows?.length) yieldRows[iso] = r.rows;
  });

  /* ---------------- 2. country ETFs (Yahoo, daily) ---------------- */
  const etfJobs = isoList.filter((iso) => COUNTRIES[iso].etf);
  const etfRes = await pmap(etfJobs, 5, (iso) =>
    yahooChart(COUNTRIES[iso].etf, { range: "5y", interval: "1d" })
  );
  const etfRows = {};
  etfJobs.forEach((iso, i) => {
    const r = etfRes[i];
    if (r && !r.unavailable && r.rows?.length) etfRows[iso] = r.rows;
  });

  /* ---------------- 3. FX (Yahoo, daily) — deduped by symbol ------------ */
  const fxSymbols = [...new Set(isoList.filter((i) => COUNTRIES[i].fx).map((i) => COUNTRIES[i].fx.symbol))];
  const fxRes = await pmap(fxSymbols, 5, (s) => yahooChart(s, { range: "2y", interval: "1d" }));
  const fxRows = {};
  fxSymbols.forEach((s, i) => {
    const r = fxRes[i];
    if (r && !r.unavailable && r.rows?.length) fxRows[s] = r.rows;
  });

  /* ------------ 3b. fallen-angel ETFs (Yahoo, daily) — one per market ---- */
  const faKeys = Object.keys(FALLEN_ANGEL_ETFS);
  const faRes = await pmap(faKeys, 3, (k) =>
    yahooChart(FALLEN_ANGEL_ETFS[k].ticker, { range: "5y", interval: "1d" })
  );
  const faRows = {};
  faKeys.forEach((k, i) => {
    const r = faRes[i];
    if (r && !r.unavailable && r.rows?.length) faRows[k] = r.rows;
  });

  /* ---------------- 4. regional EM credit OAS (FRED, daily) ------------- */
  const creditKeys = Object.keys(CREDIT_INDICES);
  const creditRes = await pmap(creditKeys, 3, (k) =>
    fredCsv(CREDIT_INDICES[k].id, { start: "2015-01-01" })
  );
  const credit = {};
  creditKeys.forEach((k, i) => {
    const r = creditRes[i];
    if (!r || r.unavailable || !r.rows?.length) {
      credit[k] = { status: "UNAVAILABLE", label: CREDIT_INDICES[k].label };
      return;
    }
    const rows = r.rows;
    const last = rows[rows.length - 1];
    const monthly = toMonthly(rows);
    const chg1m = monthly.length > 1
      ? r2((monthly[monthly.length - 1].v - monthly[monthly.length - 2].v) * 100)
      : null;
    // carry proxy: a spread TIGHTENING is a positive credit return
    const ret1m = chg1m == null ? null : r3(-(chg1m / 100) * CREDIT_SPREAD_DURATION);
    credit[k] = {
      status: "OK",
      label: CREDIT_INDICES[k].label,
      seriesId: CREDIT_INDICES[k].id,
      oas_bps: r2(last.v * 100),
      asOf: last.date,
      oas_chg_1m_bps: chg1m,
      oas_z: zLast(rows.map((x) => ({ ...x })), 1260, 120),
      credit_1m_pct: ret1m,
      note: `1-month credit return proxy = -(Δ OAS in bps / 100) x spread duration ${CREDIT_SPREAD_DURATION}`,
    };
  });

  /* ---------------- 5. euro-area AAA curve via ECB (keyless) ------------ */
  const ez = await ecbCsv("YC/B.U2.EUR.4F.G_N_A.SV_C_YM.SR_10Y", { start: "2005-01-01" });

  /* ---------------- 6. World Bank structural context (annual) ---------- */
  const iso3All = isoList.map((i) => COUNTRIES[i].iso3);
  const wbKeys = Object.keys(WB_INDICATORS);
  const wbRes = await pmap(wbKeys, 4, (k) => worldBank(WB_INDICATORS[k].id, iso3All));
  const wb = {};
  wbKeys.forEach((k, i) => {
    wb[k] = wbRes[i] && !wbRes[i].unavailable ? wbRes[i].latest : null;
  });

  /* ---------------- 7. assemble ---------------- */
  const usMonthly = yieldRows.US ? yieldRows.US : null;
  const us10Pct = usMonthly ? usMonthly[usMonthly.length - 1].v : null;

  const countries = {};
  for (const iso of isoList) {
    const spec = COUNTRIES[iso];
    const legs = [];
    const instruments = {};

    /* --- bond leg --- */
    const rows = yieldRows[iso];
    let bondLocal1m = null;
    if (rows?.length) {
      const yieldPct = rows[rows.length - 1].v;
      const changes = yieldChangesBps(rows);
      bondLocal1m = changes?.[1] != null ? r3(-(changes[1] / 100) * DURATION) : null;
      instruments.bonds = {
        status: "OK",
        seriesId: spec.yield,
        notes: "10Y government bond yield — OECD long-term rate via FRED, monthly",
        yield_pct: yieldPct,
        asOf: rows[rows.length - 1].date,
        yield_chg_bps: changes || { status: "UNAVAILABLE" },
        yield_z: zLast(rows, Z_WINDOW, Z_MIN),
        bond_price_1m_pct: bondLocal1m,
        duration_assumed: DURATION,
      };
    } else {
      instruments.bonds = {
        status: "UNAVAILABLE",
        why: spec.yield
          ? `FRED ${spec.yield} returned no observations`
          : "no free 10-year government bond series covers this country — the bond leg is genuinely unavailable, not imputed",
      };
    }

    /* --- FX leg --- */
    let fx1m = null;
    if (spec.fx && fxRows[spec.fx.symbol]) {
      const fr = fxRows[spec.fx.symbol];
      const raw1m = pctReturn(fr, 21);
      const raw3m = pctReturn(fr, 63);
      const raw12m = pctReturn(fr, 252);
      // USD<CCY>=X is local per USD: the local currency's own return inverts
      const conv = (v) => (v == null ? null : spec.fx.invert ? r2((1 / (1 + v / 100) - 1) * 100) : v);
      fx1m = conv(raw1m);
      instruments.fx = {
        status: "OK",
        symbol: spec.fx.symbol,
        currency: spec.fx.ccy,
        quote: fr[fr.length - 1].v,
        asOf: fr[fr.length - 1].date,
        ret_1m_pct: fx1m,
        ret_3m_pct: conv(raw3m),
        ret_12m_pct: conv(raw12m),
        note: `${spec.fx.ccy} return against the US dollar${spec.fx.invert ? " (quote inverted: Yahoo prints local units per USD)" : ""}`,
      };
    } else {
      instruments.fx = iso === "US"
        ? { status: "N/A", note: "United States — the US dollar is the base currency" }
        : { status: "UNAVAILABLE" };
    }

    // bond leg in USD: compound the local price move with the currency move
    let bondUsd1m = null;
    if (bondLocal1m != null) {
      bondUsd1m = fx1m == null
        ? bondLocal1m
        : r3(((1 + bondLocal1m / 100) * (1 + fx1m / 100) - 1) * 100);
      instruments.bonds.bond_price_1m_usd_pct = bondUsd1m;
      instruments.bonds.usd_note = fx1m == null
        ? "no currency leg — the local price proxy is used as-is"
        : "local price proxy compounded with the 1-month currency move";
      legs.push({ leg: "bond", value: bondUsd1m });
    }

    /* --- equity leg --- */
    if (etfRows[iso]) {
      const er = etfRows[iso];
      const e1 = pctReturn(er, 21);
      instruments.equity_etf = {
        status: "OK",
        label: spec.etf,
        last: er[er.length - 1].v,
        asOf: er[er.length - 1].date,
        ret_1m_pct: e1,
        ret_3m_pct: pctReturn(er, 63),
        ret_12m_pct: pctReturn(er, 252),
        note: "US/LN-listed country ETF — USD-denominated, so the currency move is already inside this return",
      };
      if (e1 != null) legs.push({ leg: "equity", value: e1 });
    } else {
      instruments.equity_etf = {
        status: "UNAVAILABLE",
        why: spec.etf ? `Yahoo returned no closes for ${spec.etf}` : "no listed single-country ETF with a live free quote",
      };
    }

    // Currency leg — ONLY when nothing else country-specific exists.
    //
    // Both other legs already contain the currency: the bond leg is compounded
    // with it a few lines above, and a US-listed country ETF is priced in
    // dollars, so its return embeds the move too. Adding a standalone FX leg
    // alongside either one counts the same exposure twice, which is what
    // happened to Brazil, Peru, Argentina and Turkey on the first pass — no
    // sovereign curve, but an ETF that was already carrying the currency.
    //
    // With neither, the currency is the one country-specific price a dollar
    // investor actually earns, and without it a market like Kenya or Cambodia
    // would inherit nothing but its regional credit index — a number identical
    // for every country in the region, dressing a regional average up as a
    // country signal.
    const hasEquityLeg = legs.some((l) => l.leg === "equity");
    if (bondUsd1m == null && !hasEquityLeg && fx1m != null) {
      legs.push({ leg: "fx", value: fx1m });
    }

    /* --- credit leg --- */
    if (spec.credit && credit[spec.credit]?.status === "OK") {
      const c = credit[spec.credit];
      instruments.credit = {
        status: "OK",
        region: spec.credit,
        label: c.label,
        oas_bps: c.oas_bps,
        oas_chg_1m_bps: c.oas_chg_1m_bps,
        oas_z: c.oas_z,
        credit_1m_pct: c.credit_1m_pct,
        note: `${c.label} — the regional EM corporate index covering this country. Not country-specific: no free per-country corporate OAS exists.`,
      };
      if (c.credit_1m_pct != null) legs.push({ leg: "credit", value: c.credit_1m_pct });
    } else {
      instruments.credit = {
        status: "UNAVAILABLE",
        why: spec.credit
          ? "the regional EM corporate OAS index is unavailable right now"
          : "developed market — no EM regional corporate OAS index covers it",
      };
    }

    /* --- fallen-angel leg (ETF proxy, where a real market vehicle exists) */
    // US trades its own fallen-angel market (ANGL); the euro-area members
    // get the EUR-quoted UCITS wrapper; the UK the GBP-quoted global UCITS.
    // EM markets have NO fallen-angel ETF — reported UNAVAILABLE, never
    // mislabeled with an ordinary HY fund.
    const faBucket = iso === "US" ? "us" : iso === "GB" ? "gbp" : spec.region === "europe" ? "eur" : null;
    const faSpec = faBucket ? FALLEN_ANGEL_ETFS[faBucket] : null;
    let fa1mUsd = null;
    if (faSpec && faRows[faBucket]) {
      const fr = faRows[faBucket];
      const local1m = pctReturn(fr, 21);
      const conv1m = (v) => {
        if (v == null) return null;
        const f = faSpec.fx && fxRows[faSpec.fx] ? pctReturn(fxRows[faSpec.fx], 21) : null;
        return f == null ? r2(v) : r3(((1 + v / 100) * (1 + f / 100) - 1) * 100);
      };
      fa1mUsd = conv1m(local1m);
      instruments.fallen_angel = {
        status: "OK",
        ticker: faSpec.ticker,
        label: faSpec.label,
        quote_ccy: faSpec.ccy,
        last: fr[fr.length - 1].v,
        asOf: fr[fr.length - 1].date,
        ret_1m_local_pct: r2(local1m),
        ret_1m_usd_pct: fa1mUsd,
        ret_3m_usd_pct: conv1m(pctReturn(fr, 63)),
        ret_12m_usd_pct: conv1m(pctReturn(fr, 252)),
        note: `${faSpec.label}. Regional proxy — not country-specific. ${faSpec.fx ? "Foreign-quoted, converted to USD with the 1M FX move." : "USD-quoted — the return already embeds the currency."}`,
      };
      if (fa1mUsd != null) legs.push({ leg: "fallen_angel", value: fa1mUsd });
    } else {
      instruments.fallen_angel = {
        status: "UNAVAILABLE",
        why: faBucket
          ? `the ${faSpec.ccy} fallen-angel ETF returned no closes`
          : "no fallen-angel ETF covers this market — the available funds track the US, euro-area and UK fallen-angel markets only",
      };
    }

    /* --- sovereign spread vs the US --- */
    const yieldPct = instruments.bonds.yield_pct;
    instruments.sovereign_spread = us10Pct != null && yieldPct != null
      ? {
          status: "proxy",
          vs_us_10y_bps: r2((yieldPct - us10Pct) * 100),
          note: "10Y yield minus the US 10Y — a sovereign risk proxy, not a traded CDS quote (no free CDS source exists)",
        }
      : { status: "UNAVAILABLE" };

    /* --- structural context (World Bank, annual and lagged) --- */
    const ctx = {};
    for (const k of wbKeys) {
      const hit = wb[k]?.get(spec.iso3);
      ctx[k] = hit ? { value: r2(hit.v), year: Number(hit.year), label: WB_INDICATORS[k].label } : { status: "UNAVAILABLE" };
    }
    instruments.structural = { ...ctx, note: "World Bank annual indicators — structural context, lagged by 1-2 years. Never used in heat." };

    const heat = legs.length ? r3(legs.reduce((a, b) => a + b.value, 0) / legs.length) : null;

    countries[iso] = {
      name: spec.name,
      iso,
      iso3: spec.iso3,
      region: spec.region,
      regionLabel: REGION_LABELS[spec.region],
      heat,
      heatLegs: legs.map((l) => ({ leg: l.leg, value: l.value })),
      heatBasis: legs.length
        ? `unweighted mean of ${legs.length} live 1-month USD return prox${legs.length === 1 ? "y" : "ies"}: ${legs.map((l) => l.leg).join(", ")}`
        : "no live return leg available for this country",
      instruments,
    };
  }

  /* --- euro area aggregate via the keyless ECB curve --- */
  if (!ez.unavailable && ez.rows?.length) {
    const rows = ez.rows;
    const changes = yieldChangesBps(rows);
    const bond1m = changes?.[1] != null ? r3(-(changes[1] / 100) * DURATION) : null;
    const eur = fxRows["EURUSD=X"];
    const fx1m = eur ? pctReturn(eur, 21) : null;
    const bondUsd = bond1m == null ? null : fx1m == null ? bond1m : r3(((1 + bond1m / 100) * (1 + fx1m / 100) - 1) * 100);
    const ezEtf = await yahooChart("EZU", { range: "5y", interval: "1d" });
    const eq = ezEtf.unavailable ? null : pctReturn(ezEtf.rows, 21);
    const legs = [bondUsd, eq].filter((v) => v != null);
    countries.EZ = {
      name: "Euro Area",
      iso: "EZ",
      iso3: "EMU",
      region: "europe",
      regionLabel: REGION_LABELS.europe,
      aggregate: true,
      heat: legs.length ? r3(legs.reduce((a, b) => a + b, 0) / legs.length) : null,
      heatLegs: [
        ...(bondUsd != null ? [{ leg: "bond", value: bondUsd }] : []),
        ...(eq != null ? [{ leg: "equity", value: eq }] : []),
      ],
      heatBasis: "aggregate of the euro-area AAA curve and the EZU equity ETF — not a country",
      instruments: {
        bonds: {
          status: "OK",
          notes: "ECB euro-area AAA 10Y government curve (SDW, keyless)",
          yield_pct: rows[rows.length - 1].v,
          asOf: rows[rows.length - 1].date,
          yield_chg_bps: changes || { status: "UNAVAILABLE" },
          yield_z: zLast(rows, Z_WINDOW, Z_MIN),
          bond_price_1m_pct: bond1m,
          bond_price_1m_usd_pct: bondUsd,
          duration_assumed: DURATION,
        },
        equity_etf: ezEtf.unavailable
          ? { status: "UNAVAILABLE" }
          : { status: "OK", label: "EZU", ret_1m_pct: eq, ret_3m_pct: pctReturn(ezEtf.rows, 63), ret_12m_pct: pctReturn(ezEtf.rows, 252) },
        credit: { status: "UNAVAILABLE", why: "developed market — no EM regional corporate OAS index covers it" },
        sovereign_spread: us10Pct != null
          ? { status: "proxy", vs_us_10y_bps: r2((rows[rows.length - 1].v - us10Pct) * 100), note: "euro-area AAA 10Y minus the US 10Y" }
          : { status: "UNAVAILABLE" },
        structural: { note: "aggregate — no single World Bank country row applies" },
      },
    };
  }

  /* --- region rollups --- */
  const buckets = {};
  for (const node of Object.values(countries)) {
    if (node.aggregate || node.heat == null) continue;
    (buckets[node.region] = buckets[node.region] || []).push(node.heat);
  }
  const regions = {};
  for (const [region, vals] of Object.entries(buckets)) {
    regions[region] = {
      label: REGION_LABELS[region] || region,
      heat: r3(vals.reduce((a, b) => a + b, 0) / vals.length),
      countries: vals.length,
    };
  }

  const withBond = Object.values(countries).filter((c) => c.instruments.bonds?.status === "OK").length;
  const withEquity = Object.values(countries).filter((c) => c.instruments.equity_etf?.status === "OK").length;
  const withCredit = Object.values(countries).filter((c) => c.instruments.credit?.status === "OK").length;
  const withFallen = Object.values(countries).filter((c) => c.instruments.fallen_angel?.status === "OK").length;
  const scored = Object.values(countries).filter((c) => c.heat != null).length;

  return {
    status: "OK",
    generated: STATIC_GENERATED || new Date().toISOString(),
    schema: "atlas.v2",
    heatDefinition:
      "1-month total-return proxy in USD: the unweighted mean of the available legs — sovereign bond price proxy converted to USD, country equity ETF return, regional EM corporate credit carry, the fallen-angel ETF proxy, and, for markets with no free sovereign curve, the currency return against the dollar. Green means positive compensation over the last month, red negative.",
    countries,
    regions,
    credit,
    coverage: {
      total: Object.keys(countries).length,
      scored,
      withSovereignYield: withBond,
      withEquityEtf: withEquity,
      withCreditLeg: withCredit,
      withFallenAngelEtf: withFallen,
    },
    sources: [
      "FRED — OECD long-term (10Y) government bond yields, monthly",
      "FRED — ICE BofA emerging-market corporate OAS by region, daily",
      "ECB Data Portal — euro-area AAA government curve, keyless",
      "Yahoo Finance — single-country equity ETFs, fallen-angel ETFs (ANGL / EM1A.DE / GFA.L) and FX crosses, daily",
      "World Bank — debt/GDP, inflation, lending rate and lending risk premium (annual, lagged)",
    ],
  };
}
