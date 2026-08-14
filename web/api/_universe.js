/**
 * The country universe, and for each country the free live sources that
 * genuinely cover it. Nothing here is a placeholder: a country appears with a
 * leg only when a real, free, keyless-or-FRED-keyed series was verified to
 * return data for it (probed 2026-08-13).
 *
 *   yield   FRED series id for a 10-year government bond yield, monthly.
 *           Most follow the OECD MEI pattern IRLTLT01<ISO2>M156N; India and
 *           Colombia only exist under the <ISO3>IRLTLT01STM form. Countries
 *           with NO free 10Y series (China, Brazil, Indonesia, Turkey,
 *           Thailand, Malaysia, Philippines, Taiwan, Singapore, Vietnam,
 *           Peru, Argentina, Gulf states) carry `yield: null` and report the
 *           bond leg as UNAVAILABLE rather than inventing one.
 *   etf     US/LN-listed country ETF (Yahoo chart) — USD-denominated, so its
 *           return already embeds the currency move.
 *   fx      { symbol, invert }. Yahoo quotes USD<CCY>=X as units of local per
 *           USD, so a USD investor's local-currency return is old/new - 1
 *           (invert: true). EURUSD/GBPUSD/AUDUSD/NZDUSD quote directly.
 *   credit  Which ICE BofA EM corporate OAS region index covers the country's
 *           corporate credit. Developed markets have no EM regional index and
 *           report the credit leg as UNAVAILABLE.
 */

export const REGION_LABELS = {
  namerica: "North America",
  latam: "Latin America",
  europe: "Europe",
  emeurope: "Emerging Europe",
  mideast: "Middle East",
  africa: "Africa",
  asia: "Developed Asia",
  emasia: "Emerging Asia",
  apac: "Asia-Pacific",
};

const fxOf = (ccy) => ({ symbol: `USD${ccy}=X`, invert: true, ccy });
const fxDirect = (ccy) => ({ symbol: `${ccy}USD=X`, invert: false, ccy });

export const COUNTRIES = {
  /* ---------------- North America ---------------- */
  US: { name: "United States", iso3: "USA", region: "namerica", yield: "IRLTLT01USM156N", etf: "SPY", fx: null, credit: null },
  CA: { name: "Canada", iso3: "CAN", region: "namerica", yield: "IRLTLT01CAM156N", etf: "EWC", fx: fxOf("CAD"), credit: null },

  /* ---------------- Latin America ---------------- */
  MX: { name: "Mexico", iso3: "MEX", region: "latam", yield: "IRLTLT01MXM156N", etf: "EWW", fx: fxOf("MXN"), credit: "latam" },
  BR: { name: "Brazil", iso3: "BRA", region: "latam", yield: null, etf: "EWZ", fx: fxOf("BRL"), credit: "latam" },
  CL: { name: "Chile", iso3: "CHL", region: "latam", yield: "IRLTLT01CLM156N", etf: "ECH", fx: fxOf("CLP"), credit: "latam" },
  CO: { name: "Colombia", iso3: "COL", region: "latam", yield: "COLIRLTLT01STM", etf: null, fx: fxOf("COP"), credit: "latam" },
  PE: { name: "Peru", iso3: "PER", region: "latam", yield: null, etf: "EPU", fx: fxOf("PEN"), credit: "latam" },
  AR: { name: "Argentina", iso3: "ARG", region: "latam", yield: null, etf: "ARGT", fx: fxOf("ARS"), credit: "latam" },

  /* ---------------- Europe ---------------- */
  DE: { name: "Germany", iso3: "DEU", region: "europe", yield: "IRLTLT01DEM156N", etf: "EWG", fx: fxDirect("EUR"), credit: null },
  FR: { name: "France", iso3: "FRA", region: "europe", yield: "IRLTLT01FRM156N", etf: "EWQ", fx: fxDirect("EUR"), credit: null },
  IT: { name: "Italy", iso3: "ITA", region: "europe", yield: "IRLTLT01ITM156N", etf: "EWI", fx: fxDirect("EUR"), credit: null },
  ES: { name: "Spain", iso3: "ESP", region: "europe", yield: "IRLTLT01ESM156N", etf: "EWP", fx: fxDirect("EUR"), credit: null },
  NL: { name: "Netherlands", iso3: "NLD", region: "europe", yield: "IRLTLT01NLM156N", etf: "EWN", fx: fxDirect("EUR"), credit: null },
  BE: { name: "Belgium", iso3: "BEL", region: "europe", yield: "IRLTLT01BEM156N", etf: null, fx: fxDirect("EUR"), credit: null },
  AT: { name: "Austria", iso3: "AUT", region: "europe", yield: "IRLTLT01ATM156N", etf: null, fx: fxDirect("EUR"), credit: null },
  PT: { name: "Portugal", iso3: "PRT", region: "europe", yield: "IRLTLT01PTM156N", etf: null, fx: fxDirect("EUR"), credit: null },
  IE: { name: "Ireland", iso3: "IRL", region: "europe", yield: "IRLTLT01IEM156N", etf: null, fx: fxDirect("EUR"), credit: null },
  FI: { name: "Finland", iso3: "FIN", region: "europe", yield: "IRLTLT01FIM156N", etf: null, fx: fxDirect("EUR"), credit: null },
  GR: { name: "Greece", iso3: "GRC", region: "europe", yield: "IRLTLT01GRM156N", etf: "GREK", fx: fxDirect("EUR"), credit: null },
  SK: { name: "Slovakia", iso3: "SVK", region: "europe", yield: "IRLTLT01SKM156N", etf: null, fx: fxDirect("EUR"), credit: null },
  SI: { name: "Slovenia", iso3: "SVN", region: "europe", yield: "IRLTLT01SIM156N", etf: null, fx: fxDirect("EUR"), credit: null },
  LU: { name: "Luxembourg", iso3: "LUX", region: "europe", yield: "IRLTLT01LUM156N", etf: null, fx: fxDirect("EUR"), credit: null },
  GB: { name: "United Kingdom", iso3: "GBR", region: "europe", yield: "IRLTLT01GBM156N", etf: "EWU", fx: fxDirect("GBP"), credit: null },
  CH: { name: "Switzerland", iso3: "CHE", region: "europe", yield: "IRLTLT01CHM156N", etf: "EWL", fx: fxOf("CHF"), credit: null },
  NO: { name: "Norway", iso3: "NOR", region: "europe", yield: "IRLTLT01NOM156N", etf: null, fx: fxOf("NOK"), credit: null },
  SE: { name: "Sweden", iso3: "SWE", region: "europe", yield: "IRLTLT01SEM156N", etf: null, fx: fxOf("SEK"), credit: null },
  DK: { name: "Denmark", iso3: "DNK", region: "europe", yield: "IRLTLT01DKM156N", etf: null, fx: fxOf("DKK"), credit: null },

  /* ---------------- Emerging Europe ---------------- */
  PL: { name: "Poland", iso3: "POL", region: "emeurope", yield: "IRLTLT01PLM156N", etf: "EPOL", fx: fxOf("PLN"), credit: "emea" },
  CZ: { name: "Czechia", iso3: "CZE", region: "emeurope", yield: "IRLTLT01CZM156N", etf: null, fx: fxOf("CZK"), credit: "emea" },
  HU: { name: "Hungary", iso3: "HUN", region: "emeurope", yield: "IRLTLT01HUM156N", etf: null, fx: fxOf("HUF"), credit: "emea" },
  TR: { name: "Turkey", iso3: "TUR", region: "emeurope", yield: null, etf: "TUR", fx: fxOf("TRY"), credit: "emea" },

  /* ---------------- Middle East ---------------- */
  IL: { name: "Israel", iso3: "ISR", region: "mideast", yield: "IRLTLT01ILM156N", etf: null, fx: fxOf("ILS"), credit: "emea" },
  SA: { name: "Saudi Arabia", iso3: "SAU", region: "mideast", yield: null, etf: "KSA", fx: fxOf("SAR"), credit: "emea" },
  AE: { name: "United Arab Emirates", iso3: "ARE", region: "mideast", yield: null, etf: "UAE", fx: fxOf("AED"), credit: "emea" },
  QA: { name: "Qatar", iso3: "QAT", region: "mideast", yield: null, etf: "QAT", fx: fxOf("QAR"), credit: "emea" },

  /* ---------------- Africa ---------------- */
  ZA: { name: "South Africa", iso3: "ZAF", region: "africa", yield: "IRLTLT01ZAM156N", etf: "EZA", fx: fxOf("ZAR"), credit: "emea" },

  /* ---------------- Developed Asia / Pacific ---------------- */
  JP: { name: "Japan", iso3: "JPN", region: "asia", yield: "IRLTLT01JPM156N", etf: "EWJ", fx: fxOf("JPY"), credit: null },
  KR: { name: "South Korea", iso3: "KOR", region: "asia", yield: "IRLTLT01KRM156N", etf: "EWY", fx: fxOf("KRW"), credit: "asia" },
  SG: { name: "Singapore", iso3: "SGP", region: "asia", yield: null, etf: "EWS", fx: fxOf("SGD"), credit: "asia" },
  TW: { name: "Taiwan", iso3: "TWN", region: "asia", yield: null, etf: "EWT", fx: fxOf("TWD"), credit: "asia" },
  AU: { name: "Australia", iso3: "AUS", region: "apac", yield: "IRLTLT01AUM156N", etf: "EWA", fx: fxDirect("AUD"), credit: null },
  NZ: { name: "New Zealand", iso3: "NZL", region: "apac", yield: "IRLTLT01NZM156N", etf: null, fx: fxDirect("NZD"), credit: null },

  /* ---------------- Emerging Asia ---------------- */
  CN: { name: "China", iso3: "CHN", region: "emasia", yield: null, etf: "MCHI", fx: fxOf("CNY"), credit: "asia" },
  IN: { name: "India", iso3: "IND", region: "emasia", yield: "INDIRLTLT01STM", etf: "INDA", fx: fxOf("INR"), credit: "asia" },
  ID: { name: "Indonesia", iso3: "IDN", region: "emasia", yield: null, etf: "EIDO", fx: fxOf("IDR"), credit: "asia" },
  TH: { name: "Thailand", iso3: "THA", region: "emasia", yield: null, etf: "THD", fx: fxOf("THB"), credit: "asia" },
  MY: { name: "Malaysia", iso3: "MYS", region: "emasia", yield: null, etf: "EWM", fx: fxOf("MYR"), credit: "asia" },
  PH: { name: "Philippines", iso3: "PHL", region: "emasia", yield: null, etf: "EPHE", fx: fxOf("PHP"), credit: "asia" },
  VN: { name: "Vietnam", iso3: "VNM", region: "emasia", yield: null, etf: "VNM", fx: fxOf("VND"), credit: "asia" },
};

/** ICE BofA EM corporate OAS indices (FRED, daily) used for the credit leg */
export const CREDIT_INDICES = {
  asia: { id: "BAMLEMRACRPIASIAOAS", label: "ICE BofA Asia Emerging Markets Corporate Plus OAS" },
  latam: { id: "BAMLEMRLCRPILAOAS", label: "ICE BofA Latin America Emerging Markets Corporate Plus OAS" },
  emea: { id: "BAMLEMRECRPIEMEAOAS", label: "ICE BofA EMEA Emerging Markets Corporate Plus OAS" },
};

/** the wider EM/global credit panel surfaced on the Opportunities page */
export const CREDIT_PANEL = {
  EM_CORP: { id: "BAMLEMCBPIOAS", label: "EM corporate — all", family: "region" },
  EM_ASIA: { id: "BAMLEMRACRPIASIAOAS", label: "EM corporate — Asia", family: "region" },
  EM_LATAM: { id: "BAMLEMRLCRPILAOAS", label: "EM corporate — Latin America", family: "region" },
  EM_EMEA: { id: "BAMLEMRECRPIEMEAOAS", label: "EM corporate — EMEA", family: "region" },
  EM_EUR: { id: "BAMLEMEBCRPIEOAS", label: "EM corporate — euro-denominated", family: "region" },
  EM_HG: { id: "BAMLEMIBHGCRPIOAS", label: "EM corporate — high grade", family: "quality" },
  EM_HY: { id: "BAMLEMHBHYCRPIOAS", label: "EM corporate — high yield", family: "quality" },
  EM_AAA_A: { id: "BAMLEM1BRRAAA2ACRPIOAS", label: "EM corporate — AAA to A", family: "quality" },
  EM_BBB: { id: "BAMLEM2BRRBBBCRPIOAS", label: "EM corporate — BBB", family: "quality" },
  EM_BB: { id: "BAMLEM3BRRBBCRPIOAS", label: "EM corporate — BB", family: "quality" },
  EM_B_LOWER: { id: "BAMLEM4BRRBLCRPIOAS", label: "EM corporate — B and lower", family: "quality" },
  EM_XOVER: { id: "BAMLEM5BCOCRPIOAS", label: "EM corporate — crossover", family: "quality" },
  EM_FIN: { id: "BAMLEMFSFCRPIOAS", label: "EM corporate — private-sector financials", family: "sector" },
  EM_NONFIN: { id: "BAMLEMNSNFCRPIOAS", label: "EM corporate — non-financial", family: "sector" },
  EM_PUBLIC: { id: "BAMLEMPUPUBSLCRPIUSOAS", label: "EM corporate — public-sector issuers", family: "sector" },
  US_AAA: { id: "BAMLC0A1CAAA", label: "US corporate — AAA", family: "us" },
  US_AA: { id: "BAMLC0A2CAA", label: "US corporate — AA", family: "us" },
  US_A: { id: "BAMLC0A3CA", label: "US corporate — A", family: "us" },
  US_BBB: { id: "BAMLC0A4CBBB", label: "US corporate — BBB", family: "us" },
  US_HY: { id: "BAMLH0A0HYM2", label: "US high yield — master II", family: "us" },
  US_B: { id: "BAMLH0A2HYB", label: "US high yield — single B", family: "us" },
  US_CCC: { id: "BAMLH0A3HYC", label: "US high yield — CCC and lower", family: "us" },
};

/* ==================================================================== */
/* US credit-grade ladder — single source of truth                       */
/* ==================================================================== */
/**
 * Every endpoint that touches grades, expected loss or spread-minus-EL reads
 * these, so /api/forecast and /api/spreads can never disagree about what a
 * grade is or what its loss assumption is. Mirrors config.py.
 */
export const RATING_ORDER = ["AAA", "AA", "A", "BBB", "BB", "B", "CCC"];

export const US_GRADES = {
  AAA: { id: "BAMLC0A1CAAA", label: "ICE BofA AAA US corporate OAS", tier: "IG" },
  AA: { id: "BAMLC0A2CAA", label: "ICE BofA AA US corporate OAS", tier: "IG" },
  A: { id: "BAMLC0A3CA", label: "ICE BofA A US corporate OAS", tier: "IG" },
  BBB: { id: "BAMLC0A4CBBB", label: "ICE BofA BBB US corporate OAS", tier: "IG" },
  BB: { id: "BAMLH0A0HYM2", label: "ICE BofA US High Yield master II OAS", tier: "HY" },
  B: { id: "BAMLH0A2HYB", label: "ICE BofA Single-B US high-yield OAS", tier: "HY" },
  CCC: { id: "BAMLH0A3HYC", label: "ICE BofA CCC & lower US high-yield OAS", tier: "HY" },
};

/** config.PUBLISHED_LGD — loss given default per grade */
export const PUBLISHED_LGD = {
  AAA: 0.4, AA: 0.4, A: 0.414, BBB: 0.435, BB: 0.519, B: 0.621, CCC: 0.682,
};

/** config.FRED_DR_SERIES + DR_MAPPING — default-rate proxies */
export const DR_SERIES = { IG_proxy: "DRBLACBS", HY_proxy: "DRCCLACBS" };
export const DR_MAPPING = {
  AAA: "IG_proxy", AA: "IG_proxy", A: "IG_proxy", BBB: "IG_proxy",
  BB: "HY_proxy", B: "HY_proxy", CCC: "HY_proxy",
};

/** config.ADJACENT_PAIRS, restricted to the OAS-vs-OAS rungs */
export const ADJACENT_PAIRS = [
  ["AA", "AAA"], ["A", "AA"], ["BBB", "A"], ["BB", "BBB"], ["B", "BB"], ["CCC", "B"],
];
export const FORECAST_HIERARCHY = ADJACENT_PAIRS.map(([a, b]) => `${a} - ${b}`);

/**
 * Expected loss per grade, in the SAME units the caller asks for.
 * EL[grade] = latest default-rate proxy x published LGD.
 * A missing default-rate observation yields null, never 0 — a fabricated zero
 * would silently overstate compensation for that grade (engine/default_rates).
 */
export function expectedLossByGrade(drLatest, { asBps = false } = {}) {
  const out = {};
  for (const g of RATING_ORDER) {
    const dr = drLatest[DR_MAPPING[g]];
    if (!dr) {
      out[g] = null;
      continue;
    }
    const el = dr.v * PUBLISHED_LGD[g];
    out[g] = asBps ? Math.round(el * 10000 * 10000) / 10000 : Math.round(el * 1e8) / 1e8;
  }
  return out;
}

/** World Bank indicators (keyless, annual, explicitly lagged) */
export const WB_INDICATORS = {
  debtGdp: { id: "GC.DOD.TOTL.GD.ZS", label: "Central government debt (% of GDP)" },
  inflation: { id: "FP.CPI.TOTL.ZG", label: "Consumer price inflation (% a year)" },
  lendingRate: { id: "FR.INR.LEND", label: "Domestic lending interest rate (%)" },
  riskPremium: { id: "FR.INR.RISK", label: "Risk premium on lending (lending rate minus treasury bill rate, %)" },
};

export const DURATION = 8.5; // config DEFAULT_DURATION (engine/atlas.py)
export const CREDIT_SPREAD_DURATION = 4.5; // EM corporate index spread duration
