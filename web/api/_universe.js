/**
 * The country universe, and for each country the free live sources that
 * genuinely cover it. Nothing here is a placeholder: a country appears with a
 * leg only when a real, free, keyless-or-FRED-keyed series was verified to
 * return data for it (probed 2026-08-13, 2026-08-18 — the 2026-08-18 pass
 * added 34 Africa / Central Asia markets, every FX cross verified live).
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
  centralasia: "Central Asia",
  mideast: "Middle East",
  africa: "Africa",
  asia: "Developed Asia",
  emasia: "Emerging Asia",
  seasia: "Southeast Asia",
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
  CR: { name: "Costa Rica", iso3: "CRI", region: "latam", yield: "CRIIRLTLT01STM", etf: null, fx: fxOf("CRC"), credit: "latam" },
  // 2026-08-18 additions: every leg below verified live (yfinance FX pairs +
  // country ETFs, 2026-08-18). No free 10Y series exists for these markets,
  // so they carry the bond leg UNAVAILABLE and are scored on the real legs.
  UY: { name: "Uruguay", iso3: "URY", region: "latam", yield: null, etf: null, fx: fxOf("UYU"), credit: "latam" },
  DO: { name: "Dominican Republic", iso3: "DOM", region: "latam", yield: null, etf: null, fx: fxOf("DOP"), credit: "latam" },
  GT: { name: "Guatemala", iso3: "GTM", region: "latam", yield: null, etf: null, fx: fxOf("GTQ"), credit: "latam" },
  HN: { name: "Honduras", iso3: "HND", region: "latam", yield: null, etf: null, fx: fxOf("HNL"), credit: "latam" },
  PY: { name: "Paraguay", iso3: "PRY", region: "latam", yield: null, etf: null, fx: fxOf("PYG"), credit: "latam" },
  // PA/EC/SV are dollarised economies — the local currency IS the dollar, so
  // there is no currency leg to quote and the credit leg is the honest signal.
  PA: { name: "Panama", iso3: "PAN", region: "latam", yield: null, etf: null, fx: null, credit: "latam" },
  EC: { name: "Ecuador", iso3: "ECU", region: "latam", yield: null, etf: null, fx: null, credit: "latam" },
  SV: { name: "El Salvador", iso3: "SLV", region: "latam", yield: null, etf: null, fx: null, credit: "latam" },

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
  // Iceland: no free 10Y series and no listed country ETF, but the ISK
  // cross is live — the currency leg is the one real country-specific price.
  IS: { name: "Iceland", iso3: "ISL", region: "europe", yield: null, etf: null, fx: fxOf("ISK"), credit: null },

  /* ---------------- Emerging Europe ---------------- */
  PL: { name: "Poland", iso3: "POL", region: "emeurope", yield: "IRLTLT01PLM156N", etf: "EPOL", fx: fxOf("PLN"), credit: "emea" },
  CZ: { name: "Czechia", iso3: "CZE", region: "emeurope", yield: "IRLTLT01CZM156N", etf: null, fx: fxOf("CZK"), credit: "emea" },
  HU: { name: "Hungary", iso3: "HUN", region: "emeurope", yield: "IRLTLT01HUM156N", etf: null, fx: fxOf("HUF"), credit: "emea" },
  TR: { name: "Turkey", iso3: "TUR", region: "emeurope", yield: null, etf: "TUR", fx: fxOf("TRY"), credit: "emea" },
  // Latvia and Lithuania are the only additions FRED publishes a long-term
  // rate for; they join the sovereign forecast book. The rest carry a
  // currency and World Bank structural leg only — no free source publishes a
  // 10-year curve for them (checked against FRED's complete 40-series OECD
  // long-term-rate family and the IMF MFS_IR bond-yield indicators).
  LV: { name: "Latvia", iso3: "LVA", region: "emeurope", yield: "LVAIRLTLT01STM", etf: null, fx: fxDirect("EUR"), credit: "emea" },
  LT: { name: "Lithuania", iso3: "LTU", region: "emeurope", yield: "LTUIRLTLT01STM", etf: null, fx: fxDirect("EUR"), credit: "emea" },
  EE: { name: "Estonia", iso3: "EST", region: "emeurope", yield: null, etf: null, fx: fxDirect("EUR"), credit: "emea" },
  HR: { name: "Croatia", iso3: "HRV", region: "emeurope", yield: null, etf: null, fx: fxDirect("EUR"), credit: "emea" },
  BG: { name: "Bulgaria", iso3: "BGR", region: "emeurope", yield: null, etf: null, fx: null, credit: "emea" },
  RO: { name: "Romania", iso3: "ROU", region: "emeurope", yield: null, etf: null, fx: fxOf("RON"), credit: "emea" },
  RS: { name: "Serbia", iso3: "SRB", region: "emeurope", yield: null, etf: null, fx: fxOf("RSD"), credit: "emea" },
  UA: { name: "Ukraine", iso3: "UKR", region: "emeurope", yield: null, etf: null, fx: fxOf("UAH"), credit: "emea" },
  AL: { name: "Albania", iso3: "ALB", region: "emeurope", yield: null, etf: null, fx: fxOf("ALL"), credit: "emea" },
  MK: { name: "North Macedonia", iso3: "MKD", region: "emeurope", yield: null, etf: null, fx: fxOf("MKD"), credit: "emea" },
  MD: { name: "Moldova", iso3: "MDA", region: "emeurope", yield: null, etf: null, fx: fxOf("MDL"), credit: "emea" },

  /* ---------------- Central Asia ---------------- */
  // Kazakhstan moved here from Emerging Europe (2026-08-18): it IS Central
  // Asia, and the region now has a group of its own. No free 10Y series and
  // no country ETF exist for any of these markets — currency + the regional
  // EMEA corporate credit index are the real signals.
  KZ: { name: "Kazakhstan", iso3: "KAZ", region: "centralasia", yield: null, etf: null, fx: fxOf("KZT"), credit: "emea" },
  // 2026-08-18 additions — every cross below verified live on yfinance.
  UZ: { name: "Uzbekistan", iso3: "UZB", region: "centralasia", yield: null, etf: null, fx: fxOf("UZS"), credit: "emea" },
  TM: { name: "Turkmenistan", iso3: "TKM", region: "centralasia", yield: null, etf: null, fx: fxOf("TMT"), credit: "emea" },
  AF: { name: "Afghanistan", iso3: "AFG", region: "centralasia", yield: null, etf: null, fx: fxOf("AFN"), credit: "emea" },

  /* ---------------- Middle East ---------------- */
  IL: { name: "Israel", iso3: "ISR", region: "mideast", yield: "IRLTLT01ILM156N", etf: null, fx: fxOf("ILS"), credit: "emea" },
  SA: { name: "Saudi Arabia", iso3: "SAU", region: "mideast", yield: null, etf: "KSA", fx: fxOf("SAR"), credit: "emea" },
  AE: { name: "United Arab Emirates", iso3: "ARE", region: "mideast", yield: null, etf: "UAE", fx: fxOf("AED"), credit: "emea" },
  QA: { name: "Qatar", iso3: "QAT", region: "mideast", yield: null, etf: "QAT", fx: fxOf("QAR"), credit: "emea" },
  // Gulf + Levant additions (2026-08-18): pegged-currency crosses are live on
  // yfinance; no free 10Y series covers them, so the regional EMEA corporate
  // credit index carries the signal alongside the (near-zero) FX leg.
  KW: { name: "Kuwait", iso3: "KWT", region: "mideast", yield: null, etf: null, fx: fxOf("KWD"), credit: "emea" },
  OM: { name: "Oman", iso3: "OMN", region: "mideast", yield: null, etf: null, fx: fxOf("OMR"), credit: "emea" },
  BH: { name: "Bahrain", iso3: "BHR", region: "mideast", yield: null, etf: null, fx: fxOf("BHD"), credit: "emea" },
  JO: { name: "Jordan", iso3: "JOR", region: "mideast", yield: null, etf: null, fx: fxOf("JOD"), credit: "emea" },

  /* ---------------- Africa ---------------- */
  ZA: { name: "South Africa", iso3: "ZAF", region: "africa", yield: "IRLTLT01ZAM156N", etf: "EZA", fx: fxOf("ZAR"), credit: "emea" },
  // South Africa is the only African sovereign FRED carries a long-term rate
  // for. NGE and EGPT, the Nigeria and Egypt ETFs, both stopped printing in
  // 2024 and are excluded rather than quoted from a dead tape.
  NG: { name: "Nigeria", iso3: "NGA", region: "africa", yield: null, etf: null, fx: fxOf("NGN"), credit: "emea" },
  EG: { name: "Egypt", iso3: "EGY", region: "africa", yield: null, etf: null, fx: fxOf("EGP"), credit: "emea" },
  KE: { name: "Kenya", iso3: "KEN", region: "africa", yield: null, etf: null, fx: fxOf("KES"), credit: "emea" },
  MA: { name: "Morocco", iso3: "MAR", region: "africa", yield: null, etf: null, fx: fxOf("MAD"), credit: "emea" },
  GH: { name: "Ghana", iso3: "GHA", region: "africa", yield: null, etf: null, fx: fxOf("GHS"), credit: "emea" },
  TN: { name: "Tunisia", iso3: "TUN", region: "africa", yield: null, etf: null, fx: fxOf("TND"), credit: "emea" },
  CI: { name: "Ivory Coast", iso3: "CIV", region: "africa", yield: null, etf: null, fx: fxOf("XOF"), credit: "emea" },
  SN: { name: "Senegal", iso3: "SEN", region: "africa", yield: null, etf: null, fx: fxOf("XOF"), credit: "emea" },
  ZM: { name: "Zambia", iso3: "ZMB", region: "africa", yield: null, etf: null, fx: fxOf("ZMW"), credit: "emea" },
  TZ: { name: "Tanzania", iso3: "TZA", region: "africa", yield: null, etf: null, fx: fxOf("TZS"), credit: "emea" },
  UG: { name: "Uganda", iso3: "UGA", region: "africa", yield: null, etf: null, fx: fxOf("UGX"), credit: "emea" },
  BW: { name: "Botswana", iso3: "BWA", region: "africa", yield: null, etf: null, fx: fxOf("BWP"), credit: "emea" },
  MU: { name: "Mauritius", iso3: "MUS", region: "africa", yield: null, etf: null, fx: fxOf("MUR"), credit: "emea" },
  NA: { name: "Namibia", iso3: "NAM", region: "africa", yield: null, etf: null, fx: fxOf("NAD"), credit: "emea" },
  ET: { name: "Ethiopia", iso3: "ETH", region: "africa", yield: null, etf: null, fx: fxOf("ETB"), credit: "emea" },
  // 2026-08-18 additions — Africa was the map's thinnest region; every FX
  // cross below was verified live on yfinance (n=260, current as of
  // 2026-08-18) before inclusion. CFA countries share the union-peg crosses
  // (XOF / XAF) — one currency, one real price. Probed and honestly EXCLUDED:
  // AOA/ERN/STN (single placeholder quote, no history), SS (dead), ZW (dead),
  // SL (USDSLL=X exists but the 2y-range chart the atlas uses returns a
  // single observation — no usable return series, so no FX leg).
  DZ: { name: "Algeria", iso3: "DZA", region: "africa", yield: null, etf: null, fx: fxOf("DZD"), credit: "emea" },
  LY: { name: "Libya", iso3: "LBY", region: "africa", yield: null, etf: null, fx: fxOf("LYD"), credit: "emea" },
  SD: { name: "Sudan", iso3: "SDN", region: "africa", yield: null, etf: null, fx: fxOf("SDG"), credit: "emea" },
  MR: { name: "Mauritania", iso3: "MRT", region: "africa", yield: null, etf: null, fx: fxOf("MRU"), credit: "emea" },
  ML: { name: "Mali", iso3: "MLI", region: "africa", yield: null, etf: null, fx: fxOf("XOF"), credit: "emea" },
  BF: { name: "Burkina Faso", iso3: "BFA", region: "africa", yield: null, etf: null, fx: fxOf("XOF"), credit: "emea" },
  NE: { name: "Niger", iso3: "NER", region: "africa", yield: null, etf: null, fx: fxOf("XOF"), credit: "emea" },
  BJ: { name: "Benin", iso3: "BEN", region: "africa", yield: null, etf: null, fx: fxOf("XOF"), credit: "emea" },
  TG: { name: "Togo", iso3: "TGO", region: "africa", yield: null, etf: null, fx: fxOf("XOF"), credit: "emea" },
  GW: { name: "Guinea-Bissau", iso3: "GNB", region: "africa", yield: null, etf: null, fx: fxOf("XOF"), credit: "emea" },
  GM: { name: "Gambia", iso3: "GMB", region: "africa", yield: null, etf: null, fx: fxOf("GMD"), credit: "emea" },
  GN: { name: "Guinea", iso3: "GIN", region: "africa", yield: null, etf: null, fx: fxOf("GNF"), credit: "emea" },
  LR: { name: "Liberia", iso3: "LBR", region: "africa", yield: null, etf: null, fx: fxOf("LRD"), credit: "emea" },
  CM: { name: "Cameroon", iso3: "CMR", region: "africa", yield: null, etf: null, fx: fxOf("XAF"), credit: "emea" },
  GA: { name: "Gabon", iso3: "GAB", region: "africa", yield: null, etf: null, fx: fxOf("XAF"), credit: "emea" },
  CG: { name: "Republic of the Congo", iso3: "COG", region: "africa", yield: null, etf: null, fx: fxOf("XAF"), credit: "emea" },
  CD: { name: "DR Congo", iso3: "COD", region: "africa", yield: null, etf: null, fx: fxOf("CDF"), credit: "emea" },
  TD: { name: "Chad", iso3: "TCD", region: "africa", yield: null, etf: null, fx: fxOf("XAF"), credit: "emea" },
  CF: { name: "Central African Republic", iso3: "CAF", region: "africa", yield: null, etf: null, fx: fxOf("XAF"), credit: "emea" },
  GQ: { name: "Equatorial Guinea", iso3: "GNQ", region: "africa", yield: null, etf: null, fx: fxOf("XAF"), credit: "emea" },
  BI: { name: "Burundi", iso3: "BDI", region: "africa", yield: null, etf: null, fx: fxOf("BIF"), credit: "emea" },
  RW: { name: "Rwanda", iso3: "RWA", region: "africa", yield: null, etf: null, fx: fxOf("RWF"), credit: "emea" },
  SO: { name: "Somalia", iso3: "SOM", region: "africa", yield: null, etf: null, fx: fxOf("SOS"), credit: "emea" },
  DJ: { name: "Djibouti", iso3: "DJI", region: "africa", yield: null, etf: null, fx: fxOf("DJF"), credit: "emea" },
  KM: { name: "Comoros", iso3: "COM", region: "africa", yield: null, etf: null, fx: fxOf("KMF"), credit: "emea" },
  MG: { name: "Madagascar", iso3: "MDG", region: "africa", yield: null, etf: null, fx: fxOf("MGA"), credit: "emea" },
  MW: { name: "Malawi", iso3: "MWI", region: "africa", yield: null, etf: null, fx: fxOf("MWK"), credit: "emea" },
  MZ: { name: "Mozambique", iso3: "MOZ", region: "africa", yield: null, etf: null, fx: fxOf("MZN"), credit: "emea" },
  SC: { name: "Seychelles", iso3: "SYC", region: "africa", yield: null, etf: null, fx: fxOf("SCR"), credit: "emea" },
  CV: { name: "Cape Verde", iso3: "CPV", region: "africa", yield: null, etf: null, fx: fxOf("CVE"), credit: "emea" },
  SZ: { name: "Eswatini", iso3: "SWZ", region: "africa", yield: null, etf: null, fx: fxOf("SZL"), credit: "emea" },

  /* ---------------- Developed Asia / Pacific ---------------- */
  JP: { name: "Japan", iso3: "JPN", region: "asia", yield: "IRLTLT01JPM156N", etf: "EWJ", fx: fxOf("JPY"), credit: null },
  KR: { name: "South Korea", iso3: "KOR", region: "asia", yield: "IRLTLT01KRM156N", etf: "EWY", fx: fxOf("KRW"), credit: "asia" },
  SG: { name: "Singapore", iso3: "SGP", region: "asia", yield: null, etf: "EWS", fx: fxOf("SGD"), credit: "asia" },
  TW: { name: "Taiwan", iso3: "TWN", region: "asia", yield: null, etf: "EWT", fx: fxOf("TWD"), credit: "asia" },
  HK: { name: "Hong Kong", iso3: "HKG", region: "asia", yield: null, etf: "EWH", fx: fxOf("HKD"), credit: "asia" },
  AU: { name: "Australia", iso3: "AUS", region: "apac", yield: "IRLTLT01AUM156N", etf: "EWA", fx: fxDirect("AUD"), credit: null },
  NZ: { name: "New Zealand", iso3: "NZL", region: "apac", yield: "IRLTLT01NZM156N", etf: null, fx: fxDirect("NZD"), credit: null },

  /* ---------------- Emerging Asia ---------------- */
  CN: { name: "China", iso3: "CHN", region: "emasia", yield: null, etf: "MCHI", fx: fxOf("CNY"), credit: "asia" },
  IN: { name: "India", iso3: "IND", region: "emasia", yield: "INDIRLTLT01STM", etf: "INDA", fx: fxOf("INR"), credit: "asia" },
  ID: { name: "Indonesia", iso3: "IDN", region: "seasia", yield: null, etf: "EIDO", fx: fxOf("IDR"), credit: "asia" },
  TH: { name: "Thailand", iso3: "THA", region: "seasia", yield: null, etf: "THD", fx: fxOf("THB"), credit: "asia" },
  MY: { name: "Malaysia", iso3: "MYS", region: "seasia", yield: null, etf: "EWM", fx: fxOf("MYR"), credit: "asia" },
  PH: { name: "Philippines", iso3: "PHL", region: "seasia", yield: null, etf: "EPHE", fx: fxOf("PHP"), credit: "asia" },
  VN: { name: "Vietnam", iso3: "VNM", region: "seasia", yield: null, etf: "VNM", fx: fxOf("VND"), credit: "asia" },
  KH: { name: "Cambodia", iso3: "KHM", region: "seasia", yield: null, etf: null, fx: fxOf("KHR"), credit: "asia" },
  LA: { name: "Laos", iso3: "LAO", region: "seasia", yield: null, etf: null, fx: fxOf("LAK"), credit: "asia" },
  MM: { name: "Myanmar", iso3: "MMR", region: "seasia", yield: null, etf: null, fx: fxOf("MMK"), credit: "asia" },
  BN: { name: "Brunei", iso3: "BRN", region: "seasia", yield: null, etf: null, fx: fxOf("BND"), credit: "asia" },
  BD: { name: "Bangladesh", iso3: "BGD", region: "emasia", yield: null, etf: null, fx: fxOf("BDT"), credit: "asia" },
  LK: { name: "Sri Lanka", iso3: "LKA", region: "emasia", yield: null, etf: null, fx: fxOf("LKR"), credit: "asia" },
  PK: { name: "Pakistan", iso3: "PAK", region: "emasia", yield: null, etf: null, fx: fxOf("PKR"), credit: "asia" },
};

/** ICE BofA EM corporate OAS indices (FRED, daily) used for the credit leg */
export const CREDIT_INDICES = {
  asia: { id: "BAMLEMRACRPIASIAOAS", label: "ICE BofA Asia Emerging Markets Corporate Plus OAS" },
  latam: { id: "BAMLEMRLCRPILAOAS", label: "ICE BofA Latin America Emerging Markets Corporate Plus OAS" },
  emea: { id: "BAMLEMRECRPIEMEAOAS", label: "ICE BofA EMEA Emerging Markets Corporate Plus OAS" },
};

/**
 * Fallen-angel ETFs used as the fallen-angel credit leg, one per market the
 * map can honestly proxy. All verified live on Yahoo (2026-08-18).
 *
 *   us   ANGL — VanEck Fallen Angel High Yield Bond ETF (USD). The same
 *        instrument engine/spreads.py uses for the US fallen-angel market.
 *   eur  EM1A.DE — VanEck US Fallen Angel High Yield Bond UCITS ETF A USD
 *        Acc, quoted on Xetra in EUR: the euro-area trading vehicle for the
 *        US fallen-angel market. Return is converted to USD with the EURUSD
 *        move like any other foreign-quoted leg.
 *   gbp  GFA.L — VanEck Global Fallen Angel High Yield Bond UCITS ETF
 *        (GBp): the GBP-quoted global fallen-angel market. Converted to USD
 *        with GBPUSD.
 *
 * No fallen-angel ETF covers emerging markets (EMHY is ordinary HY, not
 * fallen angels), so EM countries report the leg as UNAVAILABLE rather than
 * mislabeling a non-FA ETF.
 */
export const FALLEN_ANGEL_ETFS = {
  us: { ticker: "ANGL", ccy: "USD", fx: null, label: "VanEck Fallen Angel High Yield Bond ETF (ANGL) — US fallen-angel market" },
  eur: { ticker: "EM1A.DE", ccy: "EUR", fx: "EURUSD=X", label: "VanEck US Fallen Angel High Yield Bond UCITS ETF A USD Acc (EM1A.DE) — EUR-quoted wrapper on the US fallen-angel market" },
  gbp: { ticker: "GFA.L", ccy: "GBP", fx: "GBPUSD=X", label: "VanEck Global Fallen Angel High Yield Bond UCITS ETF (GFA.L) — GBP-quoted global fallen-angel market" },
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
