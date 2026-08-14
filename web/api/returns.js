/**
 * GET /api/returns?market=us|eu|em|countries&mode=pure|spread&basis=hold|vol
 *
 * Two economically different books, deliberately both exposed:
 *
 *   basis=hold  BUY AND HOLD. What you earn by owning the asset: the spread
 *               or yield it carries, and that carry net of the loss you
 *               expect to suffer. No dealer markup, no straddle premium, no
 *               execution friction — none of those are charged to a holder.
 *
 *   basis=vol   VOLATILITY STRATEGY. A port of engine/volatility.py's
 *               return_curve: gross is the mean absolute T-day move captured
 *               on high-volatility days, and the net tiers subtract the
 *               straddle premium a dealer charges plus execution friction.
 *               A markup belongs here because you are buying an option.
 *
 * `mode` splits each book into single-asset and relative-value legs.
 *
 * UNITS. Each series goes to returnCurve in the units the market quotes —
 * spreads and yields in basis points, listed prices as 10000*ln(P) — together
 * with the `pnlScale` that converts one unit of move into basis points of
 * P&L: spread duration 4.5, bond duration 8.5, log-price 1. Before this, a
 * spread level, a yield level and a price-times-100 were all read as if they
 * were already basis points of return, which mis-scaled every curve by a
 * different factor and made the markets incomparable. See _shared.js for why
 * the scale is applied after the cost model rather than to the input.
 */
import {
  fredCsv, yahooChart, yahooAtmIv, ecbCsv, returnCurve, json, pmap, worldBank,
  toBps, logPriceBps, alignedDiff,
  SPREAD_DURATION, BOND_DURATION, PRICE_SCALE,
} from "./_shared.js";
import {
  RATING_ORDER, US_GRADES, DR_SERIES, DR_MAPPING, ADJACENT_PAIRS,
  expectedLossByGrade, CREDIT_PANEL, COUNTRIES, WB_INDICATORS,
} from "./_universe.js";

export const config = { runtime: "nodejs" };

const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);

const ETF_ASSETS = {
  ANGL: { symbol: "ANGL", label: "Fallen angels — bonds downgraded from investment grade to high yield (VanEck ANGL)" },
  IEACL: { symbol: "IEAC.L", label: "Euro investment-grade corporate bonds (iShares Core EUR Corp IEAC.L)" },
  IHYGL: { symbol: "IHYG.L", label: "Euro high-yield corporate bonds (iShares EUR High Yield IHYG.L)" },
  EMB: { symbol: "EMB", label: "EM US-dollar sovereign bonds (iShares J.P. Morgan USD EM Bond EMB)" },
  CEMB: { symbol: "CEMB", label: "EM US-dollar corporate bonds (iShares J.P. Morgan EM Corporate CEMB)" },
  EMHY: { symbol: "EMHY", label: "EM high-yield bonds (iShares J.P. Morgan EM High Yield EMHY)" },
  LEMB: { symbol: "LEMB", label: "EM local-currency bonds (iShares J.P. Morgan EM Local Currency LEMB)" },
};

const ECB_LTIR = {
  DE: "Germany — Bund long-term (10Y) rate", FI: "Finland — 10Y rate",
  FR: "France — 10Y OAT rate", IT: "Italy — 10Y BTP rate",
  ES: "Spain — 10Y Bonos rate", NL: "Netherlands — 10Y DSL rate",
  BE: "Belgium — 10Y OLO rate", AT: "Austria — 10Y rate",
  PT: "Portugal — 10Y rate", IE: "Ireland — 10Y rate", GR: "Greece — 10Y rate",
};

/* ==================================================================== */
/* buy-and-hold book                                                     */
/* ==================================================================== */

/**
 * A hold asset is described by its annual carry in bps, optionally net of an
 * annual expected loss. The projection chart consumes `curves` + `edge`, so
 * one monthly row and an annualised edge is all it needs: month-1 accrual is
 * carry/12 and it compounds from there.
 */
function holdAsset(id, name, standsFor, grossAnnualBps, netAnnualBps, extra = {}) {
  if (!Number.isFinite(grossAnnualBps)) {
    return { id, name, standsFor, unavailable: "no live carry for this asset", curves: [], edge: null };
  }
  const net = Number.isFinite(netAnnualBps) ? netAnnualBps : grossAnnualBps;
  return {
    id,
    name,
    standsFor,
    unit: "months",
    holdMax: 1,
    curves: [[1, r2(grossAnnualBps / 12), r2(net / 12), r2(net / 12)]],
    edge: { gross: r2(grossAnnualBps), hf: r2(net), ret: r2(net) },
    ...extra,
  };
}

async function buildHoldBook(market) {
  const markets = {};

  if (market === "us" || market === "all") {
    const oasList = await pmap(RATING_ORDER, 4, (g) => fredCsv(US_GRADES[g].id, { start: "2015-01-01" }));
    const oas = {};
    RATING_ORDER.forEach((g, i) => {
      const r = oasList[i];
      if (r && !r.unavailable && r.rows?.length) oas[g] = r.rows;
    });
    const drKeys = Object.keys(DR_SERIES);
    const drRes = await pmap(drKeys, 2, (k) => fredCsv(DR_SERIES[k], { start: "2010-01-01" }));
    const drLatest = {};
    drKeys.forEach((k, i) => {
      const rr = drRes[i];
      const rows = rr && !rr.unavailable ? rr.rows : null;
      drLatest[k] = rows?.length ? { v: rows[rows.length - 1].v / 100 } : null;
    });
    const elBps = expectedLossByGrade(drLatest, { asBps: true });

    const pure = [];
    for (const g of RATING_ORDER) {
      if (!oas[g]) continue;
      const carry = oas[g][oas[g].length - 1].v * 100;
      const el = elBps[g];
      pure.push(
        holdAsset(
          g,
          g,
          `${US_GRADES[g].label} — carry of ${r2(carry)} bps a year${el == null ? "" : `, less expected loss of ${r2(el)} bps`}`,
          carry,
          el == null ? null : carry - el,
          { oas_bps: r2(carry), expected_loss_bps: el, tier: US_GRADES[g].tier }
        )
      );
    }

    const spread = [];
    for (const [riskier, safer] of ADJACENT_PAIRS) {
      if (!oas[riskier] || !oas[safer]) continue;
      const hi = oas[riskier][oas[riskier].length - 1].v * 100;
      const lo = oas[safer][oas[safer].length - 1].v * 100;
      const elHi = elBps[riskier];
      const elLo = elBps[safer];
      const gross = hi - lo;
      const net = elHi == null || elLo == null ? null : gross - (elHi - elLo);
      spread.push(
        holdAsset(
          `${riskier} - ${safer}`,
          `${riskier} - ${safer}`,
          `Extra carry for holding ${riskier} instead of ${safer}${net == null ? "" : ", net of the extra expected loss that step implies"}`,
          gross,
          net,
          { spread_diff_bps: r2(gross), el_diff_bps: elHi == null || elLo == null ? null : r2(elHi - elLo) }
        )
      );
    }
    markets.us = { pure, spread };
  }

  if (market === "em" || market === "eu" || market === "all") {
    const wanted = market === "eu"
      ? ["EM_EUR"]
      : ["EM_CORP", "EM_ASIA", "EM_LATAM", "EM_EMEA", "EM_HG", "EM_HY", "EM_BBB", "EM_BB", "EM_B_LOWER", "EM_XOVER"];
    const keys = wanted.filter((k) => CREDIT_PANEL[k]);
    const res = await pmap(keys, 4, (k) => fredCsv(CREDIT_PANEL[k].id, { start: "2015-01-01" }));
    const pure = [];
    keys.forEach((k, i) => {
      const r = res[i];
      if (!r || r.unavailable || !r.rows?.length) return;
      const carry = r.rows[r.rows.length - 1].v * 100;
      pure.push(
        holdAsset(
          k,
          CREDIT_PANEL[k].label,
          `${CREDIT_PANEL[k].label} — carry of ${r2(carry)} bps a year. No published default-rate proxy maps to this index, so no expected-loss deduction is applied and the carry is gross.`,
          carry,
          null,
          { oas_bps: r2(carry), expected_loss_bps: null, gross_only: true }
        )
      );
    });
    const spread = [];
    if (market === "eu" || market === "all") {
      // The euro-denominated EM corporate index is the only euro credit OAS
      // FRED publishes, which left "Europe / buy & hold" as a single line.
      // The canonical euro credit hold is the sovereign spread over Bund —
      // BTP-Bund, OAT-Bund — so it is built here from the same ECB long-term
      // rate series the volatility book uses. It is a real carry position: you
      // are paid the differential for holding the periphery against the core.
      const isos = Object.keys(ECB_LTIR);
      const ltir = await pmap(isos, 5, (iso) => ecbCsv(`IRS/M.${iso}.L.L40.CI.0000.EUR.N.Z`, { start: "2015-01-01" }));
      const last = {};
      isos.forEach((iso, i) => {
        const r = ltir[i];
        if (r && !r.unavailable && r.rows?.length) last[iso] = r.rows[r.rows.length - 1].v * 100;
      });
      if (Number.isFinite(last.DE)) {
        for (const iso of isos) {
          if (iso === "DE" || !Number.isFinite(last[iso])) continue;
          const diff = last[iso] - last.DE;
          spread.push(
            holdAsset(
              `${iso} - DE`,
              `${iso} - DE`,
              `${ECB_LTIR[iso].split(" — ")[0]} 10-year yield over the Bund — ${r2(diff)} bps a year for holding this sovereign instead of Germany. Both legs are euro-denominated, so the differential is credit and liquidity, not currency. No expected-loss deduction: no default-rate proxy is published for euro-area sovereigns, so this carry is gross.`,
              diff,
              null,
              { spread_diff_bps: r2(diff), yield_bps: r2(last[iso]), bund_bps: r2(last.DE), gross_only: true }
            )
          );
        }
      }
    }
    markets[market === "eu" ? "eu" : "em"] = { pure, spread };
  }

  if (market === "countries" || market === "all") {
    const isos = Object.keys(COUNTRIES).filter((i) => COUNTRIES[i].yield);
    const res = await pmap(isos, 6, (iso) => fredCsv(COUNTRIES[iso].yield, { start: "2015-01-01" }));
    const infl = await worldBank(WB_INDICATORS.inflation.id, isos.map((i) => COUNTRIES[i].iso3));
    const inflLatest = infl && !infl.unavailable ? infl.latest : null;
    const pure = [];
    isos.forEach((iso, i) => {
      const r = res[i];
      if (!r || r.unavailable || !r.rows?.length) return;
      const y = r.rows[r.rows.length - 1].v * 100;
      const inf = inflLatest?.get(COUNTRIES[iso].iso3);
      const real = inf ? y - inf.v * 100 : null;
      pure.push(
        holdAsset(
          iso,
          COUNTRIES[iso].name,
          `${COUNTRIES[iso].name} 10-year government bond — nominal yield ${r2(y)} bps a year${inf ? `, ${r2(real)} bps after the ${inf.year} inflation print` : ""}. Holding to maturity earns the yield; the net view deducts inflation, not a fee.`,
          y,
          real,
          { yield_bps: r2(y), inflation_bps: inf ? r2(inf.v * 100) : null, inflation_year: inf ? Number(inf.year) : null }
        )
      );
    });
    markets.countries = { pure, spread: [] };
  }

  return markets;
}

/* ==================================================================== */
/* volatility book                                                       */
/* ==================================================================== */

/**
 * Every series in one market has to be measured over the SAME window, because
 * the page ranks them against each other and "shock day" is defined by a
 * within-series percentile. FRED serves only the last three years of the ICE
 * BofA OAS indices (a licensing limit on their side, not a fetch bug — the
 * API reports count: 795), while Yahoo hands back fifteen years for an ETF.
 * Ranking a spread whose worst days are 2024 wobbles against an ETF whose
 * worst days are March 2020 is not a comparison, so the book is clipped to
 * the latest start date any of its members has.
 */
function commonStart(rowSets) {
  let start = null;
  for (const rows of rowSets) {
    if (!rows?.length) continue;
    const d = rows[0].date;
    if (start == null || d > start) start = d;
  }
  return start;
}
const clip = (rows, start) => (start ? rows.filter((r) => r.date >= start) : rows);

async function buildAsset(name, observable, { standsFor, unit = "days", holdMax = 21, atmIv = null, pnlScale = PRICE_SCALE }) {
  const curve = returnCurve(observable, { holdMax, atmIv, name, unit, pnlScale });
  if (!curve) {
    return { id: name, name, standsFor, unit, unavailable: "insufficient history on this deployment", curves: [], edge: null };
  }
  return {
    id: name,
    name,
    standsFor,
    unit,
    holdMax,
    curves: curve.rows.map((r) => [r.T, r.gross, r.hf, r.ret]),
    edge: curve.edge,
    markupNote: curve.markupNote,
  };
}

async function buildVolBook(market) {
  const markets = {};
  const windows = {};

  if (market === "us" || market === "all") {
    const oasList = await pmap(RATING_ORDER, 4, (g) => fredCsv(US_GRADES[g].id, { start: "2010-01-01" }));
    const oas = {};
    RATING_ORDER.forEach((g, i) => {
      const r = oasList[i];
      if (r && !r.unavailable && r.rows?.length) oas[g] = r.rows;
    });
    const ang = await yahooChart("ANGL", { range: "15y", interval: "1d" });
    let angRows = ang.unavailable ? null : ang.rows;
    let angIv = null;
    if (angRows) {
      const iv = await yahooAtmIv("ANGL");
      angIv = iv.atmIv || null;
    }

    const start = commonStart([...Object.values(oas), ...(angRows ? [angRows] : [])]);
    for (const g of Object.keys(oas)) oas[g] = clip(oas[g], start);
    if (angRows) {
      angRows = clip(angRows, start);
      if (angRows.length < 120) angRows = null; // honest drop, not a short-window curve
    }
    windows.us = start;

    const pure = [];
    for (const g of RATING_ORDER) {
      if (!oas[g]) continue;
      pure.push(
        await buildAsset(g, toBps(oas[g]), {
          standsFor: `${US_GRADES[g].label} — straddle on the option-adjusted spread, ${SPREAD_DURATION} bps of P&L per bp of spread move`,
          pnlScale: SPREAD_DURATION,
        })
      );
    }
    if (angRows) {
      pure.push(
        await buildAsset("Fallen_Angel", logPriceBps(angRows), {
          standsFor: ETF_ASSETS.ANGL.label,
          atmIv: angIv,
          pnlScale: PRICE_SCALE,
        })
      );
    }

    const spread = [];
    for (const [riskier, safer] of ADJACENT_PAIRS) {
      if (!oas[riskier] || !oas[safer]) continue;
      const pair = alignedDiff(oas[riskier], oas[safer], toBps);
      if (pair.length < 120) continue;
      spread.push(
        await buildAsset(`${riskier} - ${safer}`, pair.map((r) => r.v), {
          standsFor: `Long ${riskier} against short ${safer} — both legs quoted as option-adjusted spreads, so the difference is a spread in bps at duration ${SPREAD_DURATION}`,
          pnlScale: SPREAD_DURATION,
        })
      );
    }
    // BB vs the fallen-angel ETF is deliberately NOT offered. A credit spread
    // in bps and a log-price index in bps are different quantities that happen
    // to share a name for their unit; differencing them is not a trade, and
    // no single pnlScale is correct for the result. The Python pipeline omits
    // it for the same reason.
    markets.us = { pure, spread };
  }

  if (market === "eu" || market === "all") {
    const [ieacRes, ihygRes] = await pmap(["IEAC.L", "IHYG.L"], 2, (s) => yahooChart(s, { range: "15y", interval: "1d" }));
    const raw = {};
    if (!ieacRes.unavailable && ieacRes.rows?.length) raw.IEAC = ieacRes.rows;
    if (!ihygRes.unavailable && ihygRes.rows?.length) raw.IHYG = ihygRes.rows;
    const start = commonStart(Object.values(raw));
    for (const k of Object.keys(raw)) raw[k] = clip(raw[k], start);
    windows.eu = start;

    const pure = [];
    const spread = [];
    if (raw.IEAC) pure.push(await buildAsset("EUR_IG", logPriceBps(raw.IEAC), { standsFor: ETF_ASSETS.IEACL.label }));
    if (raw.IHYG) pure.push(await buildAsset("EUR_HY", logPriceBps(raw.IHYG), { standsFor: ETF_ASSETS.IHYGL.label }));
    if (raw.IEAC && raw.IHYG) {
      const pair = alignedDiff(raw.IHYG, raw.IEAC, logPriceBps);
      if (pair.length >= 120) {
        spread.push(await buildAsset("EUR_HY - EUR_IG", pair.map((r) => r.v), { standsFor: "Long euro high yield against short euro investment grade" }));
      }
    }
    markets.eu = { pure, spread };
  }

  if (market === "em" || market === "all") {
    const keys = ["EMB", "CEMB", "EMHY", "LEMB"];
    const res = await pmap(keys, 4, (k) => yahooChart(ETF_ASSETS[k].symbol, { range: "15y", interval: "1d" }));
    const rows = {};
    keys.forEach((k, i) => {
      if (!res[i].unavailable && res[i].rows?.length) rows[k] = res[i].rows;
    });
    const NAMES = { EMB: "EM_USD_Sovereign", CEMB: "EM_Corporate", EMHY: "EM_High_Yield", LEMB: "EM_Local_Currency" };
    const start = commonStart(Object.values(rows));
    for (const k of Object.keys(rows)) rows[k] = clip(rows[k], start);
    windows.em = start;

    const pure = [];
    for (const k of keys) {
      if (!rows[k]) continue;
      pure.push(await buildAsset(NAMES[k], logPriceBps(rows[k]), { standsFor: ETF_ASSETS[k].label }));
    }
    const PAIRS = [["CEMB", "EMB"], ["EMHY", "CEMB"], ["LEMB", "EMHY"]];
    const spread = [];
    for (const [a, b] of PAIRS) {
      if (!rows[a] || !rows[b]) continue;
      const pair = alignedDiff(rows[a], rows[b], logPriceBps);
      if (pair.length < 120) continue;
      spread.push(
        await buildAsset(`${NAMES[a]} - ${NAMES[b]}`, pair.map((r) => r.v), {
          standsFor: `Long ${ETF_ASSETS[a].label} against short ${ETF_ASSETS[b].label}`,
        })
      );
    }
    markets.em = { pure, spread };
  }

  if (market === "countries" || market === "all") {
    const isos = Object.keys(ECB_LTIR);
    const res = await pmap(isos, 5, (iso) => ecbCsv(`IRS/M.${iso}.L.L40.CI.0000.EUR.N.Z`, { start: "2010-01-01" }));
    const usable = {};
    isos.forEach((iso, i) => {
      const r = res[i];
      if (r && !r.unavailable && r.rows?.length >= 120) usable[iso] = r.rows;
    });
    const start = commonStart(Object.values(usable));
    for (const iso of Object.keys(usable)) {
      const c = clip(usable[iso], start);
      if (c.length < 120) delete usable[iso];
      else usable[iso] = c;
    }
    windows.countries = start;

    const pure = [];
    for (const iso of isos) {
      if (!usable[iso]) continue;
      pure.push(
        await buildAsset(iso, toBps(usable[iso]), {
          standsFor: `${ECB_LTIR[iso]} — straddle on the 10-year yield, ${BOND_DURATION} bps of price P&L per bp of yield move`,
          unit: "months",
          holdMax: 12,
          pnlScale: BOND_DURATION,
        })
      );
    }
    markets.countries = { pure, spread: [] };
  }

  return { markets, windows };
}

/* ==================================================================== */

export default async function handler(req, res) {
  const url = new URL(req.url, "http://x");
  const market = url.searchParams.get("market") || "us";
  const basis = url.searchParams.get("basis") === "vol" ? "vol" : "hold";

  let markets;
  let windows = null;
  if (basis === "hold") {
    markets = await buildHoldBook(market);
  } else {
    ({ markets, windows } = await buildVolBook(market));
  }

  const common = {
    status: "OK",
    generated: new Date().toISOString(),
    basis,
    markets,
  };
  if (windows) common.windows = windows;
  if (!markets[market] && market !== "all") {
    common.status = "UNAVAILABLE";
    common.why = `no ${basis} book for market '${market}'`;
  }

  if (basis === "hold") {
    return json(res, {
      ...common,
      label: "Carry accrued by holding the asset — compounded, not forecast",
      approximations: [
        "Carry is the current spread or yield annualised; it is what the asset pays at today's level, held flat. It is not a forecast of where spreads or yields go.",
        "Expected loss is the default-rate proxy times the published loss-given-default for that grade, deducted once a year.",
        "Sovereign carry is the nominal 10-year yield; the net view deducts the latest published inflation print, which is annual and lagged, so the real figure is structural rather than live.",
        "No dealer markup, straddle premium or execution friction is charged anywhere in this book — none of them applies to a holder.",
      ],
    });
  }

  return json(res, {
    ...common,
    label: "Long-volatility straddle, extrapolated from live hold-horizon curves — not a forecast",
    approximations: [
      "Shock periods = realized vol of first differences at the 90th percentile (the engine uses a GARCH fit at the same percentile; the rolling-vol mask is the site's documented approximation)",
      "Dealer markup: 30% share of the IV-RV premium over parity with a 1.05 floor, from live ATM implied vol where a listed options chain exists; otherwise the 1.05 floor",
      `Units: each move is measured in the units the market quotes — spreads and yields in bps, listed prices as 10000*ln(price) — then converted to basis points of P&L: spread duration ${SPREAD_DURATION}, bond duration ${BOND_DURATION}, log-price 1. Costs are charged in the quoted units, where the engine's friction model was calibrated.`,
      "Relative-value legs are only formed from two series with the same quoted units, so a credit spread is never differenced against a price index.",
      "Execution friction grows exponentially in how far volatility sits above its own 90th percentile, measured in units of that series' own dispersion. The engine states this growth in absolute bps, which only holds at the scale it was fitted on and charged a price index up to 4,700% per round trip.",
      "Window lengths follow the observation frequency: 21/90 observations on daily series, 12/48 on monthly. Applying the daily counts to a monthly series priced a seven-and-a-half-year fee window against one-year shocks.",
      "Every series inside one market is clipped to a common start date, because a shock is defined by a within-series percentile and windows of different lengths are not comparable. FRED serves only three years of the ICE BofA indices, which sets the US window.",
      "Extrapolation compounds the net edge measured at the longest evaluated hold horizon (21 days / 12 months)",
    ],
  });
}
