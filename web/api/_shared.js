/**
 * Shared helpers for the Public Credit serverless API (Vercel Node).
 *
 * Every numeric constant below is a mirror of the project's calibration
 * audit log (CONTEXT.md §6) — no new magic numbers. The one documented
 * approximation: the engine's GARCH-based shock mask is approximated by
 * rolling 21d realized vol at the same GARCH_SIGNAL_PERCENTILE = 90
 * (=~1 trading month), constant as before; RV==GARCH for the mask
 * percentile is a pure-vol simplification, labeled in the API payload.
 */
export const C = {
  TRADING_DAYS: 252,
  SHOCK_PERCENTILE: 90, // GARCH_SIGNAL_PERCENTILE (engine, config.py)
  DEALER_WINDOW: 90, // DEALER_PRICING_WINDOW
  RV_LOOKBACK: 21, // REALIZED_VOL_LOOKBACK
  DEALER_MARKUP_FLOOR: 1.05,
  DEALER_MARKUP_PREMIUM_SHARE: 0.3,
  PB_BASE_DISCOUNT: 0.05,
  PB_VOLUME_DISCOUNT_FACTOR: 0.05,
  PB_VOL_THRESHOLD_BPS: 100.0,
  PB_ILLIQUIDITY_DIVISOR: 1000.0,
  PB_DISCOUNT_CLIP: [0.0, 0.25],
  FRICTION_BASE_SPREAD_BPS: 0.5,
  FRICTION_GROWTH_RATE: 0.08,
  FRICTION_PERCENTILE: 90,
  DISTRESSED_GRADES: new Set(["B", "CCC", "Fallen_Angel"]),
  FALLEN_ANGEL_LIQUIDITY_PREMIUM: 1.05,
  TRADE_SIZE_M: 50.0,
};

/**
 * Observation-frequency profiles.
 *
 * RV_LOOKBACK=21 and DEALER_WINDOW=90 are counts of OBSERVATIONS, and the
 * engine only ever fed them daily series, so they read as "one month" and
 * "one business quarter or so". The euro country book is monthly, and both
 * the engine (engine/eur_country.py) and this port were passing the same
 * counts straight through — a 21-MONTH realized-vol window and a 90-MONTH
 * (seven and a half year) fee window. The consequence was visible in the
 * output: the average |12-month move| over a 90-month window spanning the
 * 2022 rate shock came out LARGER than the average move on the shock days
 * it was being charged against, so every euro sovereign priced as a
 * guaranteed loss for a reason that was purely an indexing artefact.
 *
 * The monthly profile keeps the roughly 1:4 ratio the daily constants encode
 * — one year of realized vol, four years of dealer pricing — which is the
 * shortest pair that still estimates a standard deviation and a 90th
 * percentile from monthly data. sqrt(periodsPerYear) annualizes.
 */
export const FREQ = {
  days: { rvLookback: 21, dealerWindow: 90, periodsPerYear: 252 },
  months: { rvLookback: 12, dealerWindow: 48, periodsPerYear: 12 },
};

export const UA = "Mozilla/5.0 (PublicCredit/1.0; research dashboard)";

/**
 * Bounded-concurrency map. The atlas fans out to ~90 upstream series; issuing
 * them sequentially cost ~7s warm and blew the function's wall clock cold,
 * while issuing all 90 at once gets us rate-limited (FRED 429s above ~10
 * concurrent). `limit` is the compromise and is the single knob for it.
 */
export async function pmap(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      try {
        out[i] = await fn(items[i], i);
      } catch (e) {
        out[i] = { unavailable: String(e && e.message ? e.message : e) };
      }
    }
  });
  await Promise.all(workers);
  return out;
}

export function cacheHeaders(seconds = 21600) {
  return {
    "Cache-Control": `public, s-maxage=${seconds}, stale-while-revalidate=86400`,
    "Content-Type": "application/json; charset=utf-8",
  };
}

export function json(res, data, status = 200, extra = {}) {
  res.statusCode = status;
  for (const [k, v] of Object.entries({ ...cacheHeaders(), ...extra })) {
    res.setHeader(k, v);
  }
  res.end(JSON.stringify(data));
}

export function unavailable(res, why, status = 200, rest = {}) {
  json(res, { status: "UNAVAILABLE", why, ...rest });
}

/* ------------------------------------------------------------------ */
/* JSON-file cache (rate-limit defense)                                */
/* ------------------------------------------------------------------ */
// Every upstream series (FRED/ECB/Yahoo) is persisted to
// web/public/data/cache/*.json and merged/appended on refresh, so
// (a) repeated fetches within the TTL window serve the file,
// (b) a rate-limited/errored fetch falls back to the stored data
//     (stale flag), and (c) the file grows over time — history is
// never lost. Bundle strategy: public/data/** is included in the
// Vercel function bundle (vercel.json), so cold instances start with
// the last-known data. Local runs (serve.mjs) persist the same files
// — running the system once populates the cache for every later user
// in the same window.
import { readFileSync, writeFileSync, renameSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// TTLs are sized so a COLD serverless instance is answered entirely from the
// snapshot bundled with the function, inside the platform's default 10s
// execution budget. The atlas alone touches ~90 upstream series; going live on
// even a third of them on every cold start does not fit in 10s.
//
// Nothing here is finer-grained than the data itself: every series below is
// published at most once a day (FRED daily closes, ECB monthly dataflows,
// Yahoo daily closes), so a 12h window cannot skip an observation — it only
// delays picking one up, and `npm run seed` re-cuts the snapshot on deploy.
// The option-chain TTL stays short because implied vol genuinely moves
// intraday and the accrual daemon wants a fresh read.
export const CACHE_TTL = {
  FRED: 12 * 3600 * 1000,
  ECB: 24 * 3600 * 1000,
  YAHOO_CHART: 12 * 3600 * 1000,
  YAHOO_ATMIV: 3 * 3600 * 1000,
};
// Two cache roots. SEED_ROOT is the committed snapshot shipped inside the
// function bundle (vercel.json includeFiles) — readable everywhere, but the
// Vercel function filesystem is READ-ONLY, so refreshed data can never be
// written back there. WRITE_ROOT is the only writable location on a serverless
// instance (/tmp, per-instance, survives warm invocations). Reads prefer the
// fresher of the two; writes always go to WRITE_ROOT. Locally both are the
// repo directory, so `npm run serve` still grows the committed snapshot.
const SEED_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data", "cache");
const ON_VERCEL = !!(process.env.VERCEL || process.env.NOW_REGION);
const WRITE_ROOT = ON_VERCEL ? "/tmp/pc-cache" : SEED_ROOT;
const inflight = new Map();

function cacheFile(root, kind, key) {
  return join(root, kind, key.replace(/[^A-Za-z0-9._-]/g, "__") + ".json");
}
function cachePath(kind, key) {
  return cacheFile(WRITE_ROOT, kind, key);
}

function readOne(root, kind, key) {
  try {
    const p = cacheFile(root, kind, key);
    return { mtime: statSync(p).mtimeMs, doc: JSON.parse(readFileSync(p, "utf8")) };
  } catch {
    return null;
  }
}

/** newest of {/tmp refresh, bundled seed}; ttlMs=0 means "any age" */
function readCached(kind, key, ttlMs) {
  const a = readOne(WRITE_ROOT, kind, key);
  const b = WRITE_ROOT === SEED_ROOT ? null : readOne(SEED_ROOT, kind, key);
  const best = !a ? b : !b ? a : a.mtime >= b.mtime ? a : b;
  if (!best) return null;
  if (ttlMs && Date.now() - best.mtime > ttlMs) return null;
  return best.doc;
}

function mergeRows(prev, rows) {
  // append-only by date: union, sorted ascending, deduped
  const seen = new Map((prev || []).map((r) => [r.date, r]));
  for (const r of rows) seen.set(r.date, r);
  return [...seen.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function writeCache(kind, key, data) {
  try {
    const p = cachePath(kind, key);
    mkdirSync(dirname(p), { recursive: true });
    const tmp = p + ".tmp";
    writeFileSync(tmp, JSON.stringify(data));
    renameSync(tmp, p);
  } catch { /* best effort */ }
}

/** fetch + store rows keyed by kind/key; ttlMs fresh window; returns
 * { rows, fromCache, stale, unavailable?, meta, appended? } */
export async function cachedRows(kind, key, ttlMs, fetchFn) {
  const hit = readCached(kind, key, ttlMs);
  if (hit) return { rows: hit.rows || [], fromCache: true, stale: false, meta: hit.meta };
  const inflightKey = kind + ":" + key;
  if (inflight.has(inflightKey)) return inflight.get(inflightKey);
  const job = (async () => {
    let rows, meta;
    try {
      const r = await fetchFn();
      if (!r || r.rows == null) {
        const old = readCached(kind, key, 0); // any age
        return old ? { rows: old.rows || [], fromCache: true, stale: true, deferred: r } : { fromCache: false, stale: false, unavailable: r };
      }
      rows = r.rows;
      meta = r.meta;
    } catch (e) {
      const old = readCached(kind, key, 0);
      return old ? { rows: old.rows || [], fromCache: true, stale: true, error: String(e) } : { fromCache: false, error: String(e), unavailable: true };
    }
    const prev = readCached(kind, key, 0) || { rows: [] };
    const merged = mergeRows(prev.rows || [], rows);
    writeCache(kind, key, { updated: new Date().toISOString(), kind, key, rows: merged, meta });
    return { rows: merged, fromCache: false, stale: false, appended: merged.length - (prev.rows || []).length };
  })();
  inflight.set(inflightKey, job);
  try { return await job; } finally { inflight.delete(inflightKey); }
}

/* ------------------------------------------------------------------ */
/* FRED                                                                */
/* ------------------------------------------------------------------ */

async function fetchWithRetry(url, opts, attempts = 3) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), opts.timeoutMs || 20000);
      const r = await fetch(url, { ...opts, signal: ctl.signal });
      clearTimeout(timer);
      if (r.status === 429 || r.status === 503) {
        lastErr = `HTTP ${r.status}`;
        await new Promise((res) => setTimeout(res, 800 * (i + 1)));
        continue;
      }
      return r;
    } catch (e) {
      lastErr = e.name || e.message;
      if (e.name === "AbortError") break;
      await new Promise((res) => setTimeout(res, 600 * (i + 1)));
    }
  }
  return { unavailable: true, why: lastErr };
}

export async function fredCsv(seriesId, { start = "2005-01-01" } = {}) {
  const cached = await cachedRows("fred", seriesId, CACHE_TTL.FRED, async () => {
    const key = process.env.FRED_API_KEY;
    if (!key) {
      return { unavailable: "FRED_API_KEY not configured on this deployment" };
    }
    // 2026-08-12 live finding: api.stlouisfed.org/fredgraph.csv now 404s for
    // every series_id form; the keyed JSON observations API is the live path.
    const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&api_key=${key}&file_type=json&observation_start=2005-01-01&sort_order=asc`;
    const r = await fetchWithRetry(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      timeoutMs: 25000,
    });
    if (r.unavailable) return { unavailable: `FRED ${seriesId}: ${r.why}` };
    if (!r.ok) return { unavailable: `FRED ${seriesId}: HTTP ${r.status}` };
    let j;
    try {
      j = await r.json();
    } catch (e) {
      return { unavailable: `FRED ${seriesId}: bad JSON (${e.name})` };
    }
    const rows = [];
    for (const o of j?.observations || []) {
      const v = Number(o.value);
      if (!o.date || !Number.isFinite(v) || o.value === ".") continue;
      rows.push({ date: o.date, v });
    }
    if (!rows.length) return { unavailable: `FRED ${seriesId}: no rows` };
    return { rows };
  });
  if (cached.unavailable) return { unavailable: cached.unavailable };
  const rows = (cached.rows || []).filter((r) => r.date >= start);
  if (!rows.length) return { unavailable: `FRED ${seriesId}: no rows in window` };
  return { rows };
}

/* ------------------------------------------------------------------ */
/* ECB SDW (keyless)                                                   */
/* ------------------------------------------------------------------ */

export async function ecbCsv(fullKey, { start = "2005-01-01" } = {}) {
  const cached = await cachedRows("ecb", fullKey, CACHE_TTL.ECB, async () => {
    // fullKey like "IRS/M.DE.L.L40.CI.0000.EUR.N.Z" (flow/series split) or
    // "YC/B.U2.EUR.4F.G_N_A.SV_C_YM.SR_10Y" (currency down to flow/series).
    const url = `https://data-api.ecb.europa.eu/service/data/${fullKey}?format=csvdata&startPeriod=2005-01-01`;
    const r = await fetchWithRetry(url, {
      headers: { Accept: "text/csv" },
      timeoutMs: 25000,
    });
    if (r.unavailable) return { unavailable: `ECB ${fullKey}: ${r.why}` };
    if (!r.ok) return { unavailable: `ECB ${fullKey}: HTTP ${r.status}` };
    const text = await r.text();
    const lines = text.trim().split("\n");
    // header-driven column mapping (unquoted CSV): KEY,FREQ,REF_AREA,...,TIME_PERIOD,OBS_VALUE,...
    const header = (lines[0] || "").replace(/^("KEY"|KEY)/, "KEY").split(",").map((h) => h.replace(/^"|"$/g, ""));
    const iTime = header.indexOf("TIME_PERIOD");
    const iObs = header.indexOf("OBS_VALUE");
    const rows = [];
    for (const line of lines.slice(1)) {
      if (!line || line.startsWith("KEY,")) continue;
      const cols = line.split(",");
      const date = cols[iTime];
      const v = Number(cols[iObs]);
      if (!date || !Number.isFinite(v) || cols[iObs] === ".") continue;
      rows.push({ date: date.slice(0, 10), v });
    }
    if (!rows.length) return { unavailable: `ECB ${fullKey}: no rows` };
    return { rows };
  });
  if (cached.unavailable) return { unavailable: cached.unavailable };
  const rows = (cached.rows || []).filter((r) => r.date >= start);
  if (!rows.length) return { unavailable: `ECB ${fullKey}: no rows in window` };
  return { rows };
}

/* ------------------------------------------------------------------ */
/* Yahoo v8 chart + v7 options (server-side; no SDK, no auth)          */
/* ------------------------------------------------------------------ */

export async function yahooChart(symbol, { range = "15y", interval = "1d" } = {}) {
  const cached = await cachedRows("yahoo", `${symbol}|${interval}`, CACHE_TTL.YAHOO_CHART, async () => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&events=div%2Csplit`;
    const r = await fetchWithRetry(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      timeoutMs: 20000,
    });
    if (r.unavailable) return { unavailable: `Yahoo ${symbol}: ${r.why}` };
    if (!r.ok) return { unavailable: `Yahoo ${symbol}: HTTP ${r.status}` };
    try {
      const j = await r.json();
      const res = j?.chart?.result?.[0];
      if (!res || !res.timestamp) return { unavailable: `Yahoo ${symbol}: empty payload` };
      const closes = res.indicators?.quote?.[0]?.close || [];
      const out = [];
      for (let i = 0; i < res.timestamp.length; i++) {
        const v = closes[i];
        if (Number.isFinite(v) && v > 0) {
          out.push({ date: new Date(res.timestamp[i] * 1000).toISOString().slice(0, 10), v: Number(v) });
        }
      }
      if (!out.length) return { unavailable: `Yahoo ${symbol}: no closes` };
      return { rows: out };
    } catch (e) {
      return { unavailable: `Yahoo ${symbol}: ${e.name}` };
    }
  });
  if (cached.unavailable) return { unavailable: cached.unavailable };
  return { rows: cached.rows, fromCache: cached.fromCache, stale: cached.stale };
}

export async function yahooAtmIv(symbol) {
  const cached = await cachedRows("atmiv", symbol, CACHE_TTL.YAHOO_ATMIV, async () => {
    const url = `https://query1.finance.yahoo.com/v7/finance/options/${encodeURIComponent(symbol)}`;
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 15000);
      const r = await fetch(url, {
        signal: ctl.signal,
        headers: { "User-Agent": UA, Accept: "application/json" },
      });
      clearTimeout(timer);
      if (!r.ok) return { unavailable: `Yahoo options ${symbol}: HTTP ${r.status}` };
      const j = await r.json();
      const chain = j?.optionChain?.result?.[0];
      const options = chain?.options || [];
      const ivs = [];
      for (const o of options) {
        for (const q of o.quotes || []) {
          if (Number.isFinite(q.impliedVolatility) && q.impliedVolatility > 0.02 && q.impliedVolatility < 2.0) {
            ivs.push(q.impliedVolatility);
          }
        }
        if (ivs.length) break;
      }
      if (!ivs.length) return { unavailable: `Yahoo options ${symbol}: no IV quotes` };
      ivs.sort((a, b) => a - b);
      return { atmIv: ivs[Math.floor(ivs.length / 2)] };
    } catch (e) {
      return { unavailable: `Yahoo options ${symbol}: ${e.name}` };
    }
  });
  if (cached.unavailable) return { unavailable: cached.unavailable };
  // cached.rows contains daily IV snapshots {date, v} (merged by date)
  const last = cached.rows[cached.rows.length - 1];
  return { atmIv: last?.v, fromCache: cached.fromCache, stale: cached.stale };
}

/* ------------------------------------------------------------------ */
/* World Bank (keyless, free) — structural credit context              */
/* ------------------------------------------------------------------ */
// Annual and lagged 1-2 years by design: this is the structural leg
// (leverage, inflation, lending risk premium), never presented as live.
export const WB_TTL = 7 * 24 * 3600 * 1000;

export async function worldBank(indicator, iso3List) {
  const key = `${indicator}|${iso3List.join("-")}`;
  const cached = await cachedRows("worldbank", key, WB_TTL, async () => {
    const url = `https://api.worldbank.org/v2/country/${iso3List.join(";")}/indicator/${indicator}?format=json&per_page=2000&date=2015:2026`;
    const r = await fetchWithRetry(url, { headers: { Accept: "application/json" }, timeoutMs: 20000 });
    if (r.unavailable) return { unavailable: `WorldBank ${indicator}: ${r.why}` };
    if (!r.ok) return { unavailable: `WorldBank ${indicator}: HTTP ${r.status}` };
    let j;
    try {
      j = await r.json();
    } catch (e) {
      return { unavailable: `WorldBank ${indicator}: bad JSON` };
    }
    const rows = [];
    for (const o of j?.[1] || []) {
      if (o?.value == null || !o?.date) continue;
      // one row per (country, year); `date` key keeps the cache merge honest
      rows.push({ date: `${o.date}-12-31|${o.countryiso3code}`, v: Number(o.value), iso3: o.countryiso3code });
    }
    if (!rows.length) return { unavailable: `WorldBank ${indicator}: no rows` };
    return { rows };
  });
  if (cached.unavailable) return { unavailable: cached.unavailable };
  // latest non-null observation per country
  const latest = new Map();
  for (const r of cached.rows || []) {
    const iso3 = r.iso3 || r.date.split("|")[1];
    const year = r.date.slice(0, 4);
    const prev = latest.get(iso3);
    if (!prev || year > prev.year) latest.set(iso3, { year, v: r.v });
  }
  return { latest, stale: cached.stale };
}

/* ------------------------------------------------------------------ */
/* Series helpers shared by the atlas / opportunities / forecast legs   */
/* ------------------------------------------------------------------ */

/** % return between the close `back` observations ago and the last close */
export function pctReturn(rows, back) {
  if (!rows || rows.length <= back) return null;
  const a = rows[rows.length - 1 - back]?.v;
  const b = rows[rows.length - 1]?.v;
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0) return null;
  return Math.round((b / a - 1) * 10000) / 100;
}

/** rolling z-score of the last observation over `window` observations */
export function zLast(rows, window = 126, minObs = 24) {
  if (!rows || rows.length < minObs) return null;
  const vals = rows.slice(-window).map((r) => r.v).filter(Number.isFinite);
  if (vals.length < minObs) return null;
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
  if (!Number.isFinite(sd) || sd <= 0) return null;
  return Math.round(((vals[vals.length - 1] - mean) / sd) * 1000) / 1000;
}

/** inner join two date-keyed series -> [{date, a, b}] */
export function joinByDate(a, b) {
  const bm = new Map(b.map((x) => [x.date, x.v]));
  const out = [];
  for (const x of a) {
    const y = bm.get(x.date);
    if (y != null) out.push({ date: x.date, a: x.v, b: y });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Math (faithful port of engine/volatility.py)                        */
/* ------------------------------------------------------------------ */

function percentile(arr, p) {
  if (!arr.length) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  const idx = (s.length - 1) * (p / 100);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

function rollingStd(values, window, minPeriods) {
  // rolling population std (ddof=0) — mirrors pandas .std(ddof=0)
  const out = new Array(values.length).fill(NaN);
  const ws = new Array(window).fill(NaN);
  for (let i = 0; i < values.length; i++) {
    ws[i % window] = values[i];
    const n = Math.min(i + 1, window);
    if (n < minPeriods) continue;
    let mean = 0;
    for (let k = 0; k < n; k++) mean += ws[k];
    mean /= n;
    let sq = 0;
    for (let k = 0; k < n; k++) sq += (ws[k] - mean) ** 2;
    out[i] = Math.sqrt(sq / n);
  }
  return out;
}

function rollingMean(values, window, minPeriods = 1) {
  // pandas-like: non-finite values are skipped, not averaged in — a leading
  // NaN (dealer vol day 0) must not poison the running mean
  const out = new Array(values.length).fill(NaN);
  const q = [];
  let acc = 0;
  let fins = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    const fin = Number.isFinite(v);
    q.push(fin ? v : NaN);
    if (fin) {
      acc += v;
      fins++;
    }
    if (q.length > window) {
      const old = q.shift();
      if (Number.isFinite(old)) {
        acc -= old;
        fins--;
      }
    }
    if (fins < minPeriods) continue;
    out[i] = acc / fins;
  }
  return out;
}

/**
 * pandas `.ffill().bfill()`.
 *
 * Every vol series the engine builds ends with `.reindex(index).ffill().bfill()`
 * — get_dealer_volatility, fit_garch_volatility's fallback and
 * get_empirical_move_fee all do it. This port left the leading NaNs in place,
 * and returnCurve skips any shock period whose fee or friction is NaN, so
 * shock periods inside a series' first dealer-window were silently discarded.
 *
 * That is not a rounding difference. Portugal and Ireland have their entire
 * volatility history in the 2011-12 sovereign crisis, inside the first 48
 * monthly observations, so every one of their shock periods was dropped and
 * both countries returned a curve of nulls that read on the page as "no data".
 * More insidiously, every other series lost its earliest shocks — a bias
 * toward calm early history that no label disclosed.
 *
 * The back-fill does hand the first observations a volatility estimated from
 * slightly later data. The engine accepts that (it is an estimate of the
 * series' own regime, not a trading signal), and this port now matches it.
 */
function ffillBfill(values) {
  const out = values.slice();
  let last = NaN;
  for (let i = 0; i < out.length; i++) {
    if (Number.isFinite(out[i])) last = out[i];
    else if (Number.isFinite(last)) out[i] = last;
  }
  let next = NaN;
  for (let i = out.length - 1; i >= 0; i--) {
    if (Number.isFinite(out[i])) next = out[i];
    else if (Number.isFinite(next)) out[i] = next;
  }
  return out;
}

/**
 * Rolling realized vol of FIRST DIFFERENCES, annualized — the shock-mask
 * input.
 *
 * This mirrors the engine: fit_garch_volatility and get_dealer_volatility both
 * feed on `series.diff()`. The previous port took log returns of the LEVEL
 * instead, which is wrong twice over. It is not what the engine measures, and
 * it silently requires the level to be strictly positive — `Math.log(b/a)`
 * with a<=0 yields NaN, so any series that goes negative or crosses zero
 * produced an all-NaN mask, zero shock days and a curve of nulls. That is
 * exactly what a long-short P&L index does, so no relative-value leg could
 * ever have been evaluated.
 *
 * Differences also make the measure scale-covariant and level-independent,
 * which is what lets a spread index, a yield index and a log-price index go
 * through the same code path.
 */
export function realizedVolSeries(series, freq = FREQ.days) {
  const diffs = [];
  for (let i = 1; i < series.length; i++) {
    const a = series[i - 1];
    const b = series[i];
    diffs.push(Number.isFinite(a) && Number.isFinite(b) ? b - a : NaN);
  }
  const sd = rollingStd(diffs, freq.rvLookback, Math.floor(freq.rvLookback / 2));
  // diffs[j] is the move INTO observation j+1, so the vol series has to be
  // shifted back onto the observation index with a leading NaN — otherwise
  // every shock flag sat one period early, a one-period look-ahead. pandas
  // gets this for free because .diff() keeps the original index.
  const aligned = [NaN, ...sd.map((v) => (Number.isFinite(v) ? v * Math.sqrt(freq.periodsPerYear) : NaN))];
  return ffillBfill(aligned);
}

export function dealerVolBpsSeries(bpsSeries, freq = FREQ.days) {
  // engine get_dealer_volatility (volatility.py:34): rolling 90d std of the
  // first differences of the bps series (units: bps), shifted 1 step — the
  // vol of day t is only known at t+1 (no look-ahead). The legacy port
  // computed relative-move*1e4 on the percentage series, which inflated the
  // level ~100x and blew up the exponential friction term.
  const diffs = [];
  for (let i = 1; i < bpsSeries.length; i++) {
    const a = bpsSeries[i - 1];
    const b = bpsSeries[i];
    diffs.push(Number.isFinite(a) && Number.isFinite(b) ? b - a : NaN);
  }
  const sd = rollingStd(diffs, freq.dealerWindow, freq.dealerWindow);
  // [NaN, ...] realigns diffs onto the observation index; slice drops the last
  // to give pandas' .shift(1) — the vol of period t is only known at t+1
  return ffillBfill([NaN, ...sd.slice(0, sd.length - 1)]);
}

/**
 * Execution friction in bps: base cost growing exponentially with how
 * UNUSUAL the current volatility is.
 *
 * The engine writes this as base*exp(0.08*(v - p90)) with v in bps, which
 * makes 0.08 carry units of 1/bps. That is only meaningful on series whose
 * volatility sits at the scale it was fitted on — US credit spreads, whose
 * dealer vol peaks about 1 bp above its own 90th percentile. Feed it a
 * log-price index, whose dealer vol peaks 140 bps above its 90th percentile
 * in March 2020, and the exponent reaches e^11 : ANGL priced at 44,000 bps
 * of execution cost and EM high yield at 477,000 bps, i.e. a 4,700% round
 * trip. Those were the -65,000 and -675,000 bps net returns the page showed.
 *
 * Measuring the excess in units of the series' OWN dispersion (p90 - p50)
 * makes the exponent dimensionless and the constant transferable. It is a
 * generalization, not a re-calibration: on the BBB OAS series the implied
 * absolute growth rate is 0.080, the config value to three decimals, and
 * across the seven US grades the median is the same 0.08. Peak friction
 * across every series in the book lands between 0.50 and 0.85 bps, which is
 * the order of magnitude a round trip in liquid credit actually costs.
 */
export function executionFrictionSeries(dealerVol) {
  const finite = dealerVol.filter(Number.isFinite);
  const p90 = percentile(finite, C.FRICTION_PERCENTILE);
  const p50 = percentile(finite, 50);
  // degenerate dispersion (a flat or near-constant vol series) leaves the
  // base cost rather than dividing by ~0 and producing Infinity
  const scale = Number.isFinite(p90 - p50) && p90 - p50 > 0 ? p90 - p50 : null;
  return dealerVol.map((v) => {
    if (!Number.isFinite(v)) return NaN;
    if (scale == null) return C.FRICTION_BASE_SPREAD_BPS;
    return C.FRICTION_BASE_SPREAD_BPS * Math.exp((C.FRICTION_GROWTH_RATE * Math.max(0, v - p90)) / scale);
  });
}

/**
 * Return curve port of engine/volatility.return_curve: for hold T=1..holdMax,
 * grossT = mean |x[t+T]-x[t]| over shock days; fee = rolling mean |ΔT|
 * shifted by T (no look-ahead); net = gross - fee*markup - friction.
 * `seriesBps` = values in bps. Returns {T, gross, hf, ret} rows + annualized
 * edge at holdMax.
 */
export function returnCurve(seriesBps, { holdMax = 21, percentileVs = null, atmIv = null, name = "asset", unit = "days", pnlScale = 1 } = {}) {
  const n = seriesBps.length;
  const freq = FREQ[unit] || FREQ.days;
  if (n < 120) return null;
  const rv = realizedVolSeries(seriesBps, freq);
  const threshold = percentile(rv.filter(Number.isFinite), C.SHOCK_PERCENTILE);
  const shock = rv.map((v) => Number.isFinite(v) && v >= threshold);
  const dealerVol = dealerVolBpsSeries(seriesBps, freq);
  const friction = executionFrictionSeries(dealerVol);
  // markup: 1 + share*(IV/RV - 1), floor 1.05; distressed exact grades +1.05
  const rvNow = floatOr(rv[n - 1], 0.0001);
  const distressed = C.DISTRESSED_GRADES.has(name);
  let base = C.DEALER_MARKUP_FLOOR;
  if (atmIv && Number.isFinite(rvNow) && rvNow > 0.0004) {
    base = Math.max(C.DEALER_MARKUP_FLOOR, 1 + C.DEALER_MARKUP_PREMIUM_SHARE * (atmIv / rvNow - 1));
  }
  if (distressed) base *= C.FALLEN_ANGEL_LIQUIDITY_PREMIUM;
  // PB_VOL_THRESHOLD_BPS is an absolute number of basis points of ANNUAL RISK,
  // so the vol it is compared against has to be in bps of P&L and annualized
  // at the series' own frequency. Both were wrong: the raw observable vol was
  // compared without pnlScale (a duration-4.5 CCC position carries 4.5x the
  // risk its spread quote suggests) and monthly series were annualized by
  // sqrt(252) as though they were daily, inflating them ~4.6x. The clip keeps
  // the result bounded either way, which is why this never showed up as an
  // absurd number the way the friction term did.
  const perVolBps = floatOr(dealerVol[n - 1], 0) * pnlScale;
  const annVolBps = perVolBps * Math.sqrt(freq.periodsPerYear);
  let discount = C.PB_BASE_DISCOUNT + Math.log10(Math.max(1, C.TRADE_SIZE_M)) * C.PB_VOLUME_DISCOUNT_FACTOR;
  discount -= Math.max(0, (annVolBps - C.PB_VOL_THRESHOLD_BPS) / C.PB_ILLIQUIDITY_DIVISOR);
  discount = Math.min(C.PB_DISCOUNT_CLIP[1], Math.max(C.PB_DISCOUNT_CLIP[0], discount));
  const hfMarkup = base * (1 - discount);

  const rows = [];
  for (let T = 1; T <= holdMax; T++) {
    const grossVals = [];
    const hfVals = [];
    const retVals = [];
    // fee = rolling mean |ΔT| over the FULL window, shifted by T (known at t+T)
    const muBase = [];
    for (let i = 0; i < n - T; i++) muBase.push(Math.abs(seriesBps[i + T] - seriesBps[i]));
    const feeMean = ffillBfill(rollingMean(muBase, freq.dealerWindow, 10)); // length n-T
    for (let i = 0; i < n; i++) {
      if (!shock[i]) continue;
      const g = Math.abs(seriesBps[i + T] - seriesBps[i]);
      if (!Number.isFinite(g)) continue;
      // the fee known for a move ending at i sits at window index i-T; below T
      // the engine's back-fill hands back the first valid value, so clamp
      const fIdx = Math.max(0, i - T);
      const fee = feeMean[fIdx] !== undefined ? feeMean[fIdx] : NaN;
      if (!Number.isFinite(fee)) continue;
      const pen = friction[i] === undefined ? NaN : friction[i];
      if (!Number.isFinite(pen)) continue;
      grossVals.push(g);
      hfVals.push(g - fee * hfMarkup - pen);
      retVals.push(g - fee * base - pen);
    }
    if (!grossVals.length) {
      rows.push({ T, gross: null, hf: null, ret: null });
      continue;
    }
    const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
    // pnlScale converts a move in the OBSERVABLE series into basis points of
    // P&L (spread or yield x duration; a log-price index is already P&L, so 1).
    // Costs are calibrated on the observable — the engine's friction constants
    // were fitted against spreads in bps and its exponential term is not
    // scale-free — so the scaling is applied once, at the end, to gross and
    // net alike.
    rows.push({
      T,
      gross: round2(mean(grossVals) * pnlScale),
      hf: round2(mean(hfVals) * pnlScale),
      ret: round2(mean(retVals) * pnlScale),
    });
  }
  const last = rows[rows.length - 1];
  // a curve row is the payout of ONE holdMax-long trade, so the number of
  // such trades in a year is the frequency divided by the hold length
  const tradesPerYear = freq.periodsPerYear / holdMax;
  const edge = (v) => (v == null ? null : round4(v * tradesPerYear)); // annualized bps
  return {
    unit,
    holdMax,
    rows,
    edge: { gross: edge(last.gross), hf: edge(last.hf), ret: edge(last.ret) },
    markupNote: atmIv
      ? `dealer markup from live ATM IV vs realized vol (share ${
          C.DEALER_MARKUP_PREMIUM_SHARE
        } of the IV-RV premium, floor ${C.DEALER_MARKUP_FLOOR})`
      : `dealer markup at the ${C.DEALER_MARKUP_FLOOR} floor (no listed options chain)`,
  };
}

function floatOr(v, dflt) {
  return Number.isFinite(v) ? v : dflt;
}
function round2(v) {
  return Math.round(v * 100) / 100;
}
function round4(v) {
  return Math.round(v * 10000) / 10000;
}

/* ------------------------------------------------------------------ */
/* observable series and their P&L scale                               */
/* ------------------------------------------------------------------ */
/**
 * returnCurve measures |S(t+T) - S(t)| in the units of S, then multiplies by
 * `pnlScale` to express the answer in basis points of P&L. Two things have to
 * be kept apart, and previously were not:
 *
 *   S — the OBSERVABLE series, in the units the market quotes and the units
 *       the engine's cost model was calibrated against. Spreads and yields
 *       are quoted in basis points; a listed price becomes 10000*ln(P), whose
 *       differences are log returns in basis points already.
 *
 *   pnlScale — how many basis points of profit one unit of move in S is
 *       worth. A 1 bp move on a spread-duration-4.5 index is 4.5 bps of P&L;
 *       on a duration-8.5 government bond, 8.5 bps; on a log-price index, 1.
 *
 * The old code multiplied duration into S itself. That inflated the input to
 * the dealer-friction term, whose exponential is not scale-free and was fitted
 * against spreads in bps, so the cost of a trade changed when its duration
 * changed for no economic reason. Applying the scale once at the end leaves
 * costs calibrated where they were fitted and scales gross and net alike.
 *
 * The old code also negated spreads and yields to make "up" mean profit. The
 * curve only ever looks at |ΔS| and at rolling standard deviations, both sign
 * invariant, so the negation bought nothing and cost the direction of the
 * underlying series in every debug trace. It is gone.
 *
 * The one rule this leaves: a relative-value pair may only be formed from two
 * legs with the SAME observable units and the SAME pnlScale. A credit spread
 * in bps minus a log-price index in bps is not a trade, it is two different
 * quantities subtracted.
 */
export const SPREAD_DURATION = 4.5; // EM/US corporate index spread duration
export const BOND_DURATION = 8.5; // 10Y government bond duration (engine/atlas)
export const PRICE_SCALE = 1; // a log-price index is already P&L in bps

/** FRED/ECB percent level -> the same level in basis points */
export function toBps(rows) {
  return rows.map((r) => (Number.isFinite(r.v) ? r.v * 100 : NaN));
}

/**
 * listed price -> log-price index in bps. Its difference over any horizon is
 * exactly the log return in basis points, independent of the price level,
 * which is what makes a $12 ETF and a $95 ETF directly comparable. Without
 * this, price*100 read a $95 ETF as 9,500 "bps" and a 1% move as 95 bps.
 */
export function logPriceBps(rows) {
  return rows.map((r) => (Number.isFinite(r.v) && r.v > 0 ? 10000 * Math.log(r.v) : NaN));
}

/**
 * Align two same-unit observable series by date and difference them (long a,
 * short b). Both legs must carry the same pnlScale — see the note above.
 */
export function alignedDiff(aRows, bRows, transform) {
  const av = transform(aRows);
  const bv = transform(bRows);
  const bm = new Map(bRows.map((r, i) => [r.date, bv[i]]));
  const out = [];
  aRows.forEach((r, i) => {
    const other = bm.get(r.date);
    if (other == null || !Number.isFinite(av[i]) || !Number.isFinite(other)) return;
    out.push({ date: r.date, v: av[i] - other });
  });
  return out;
}