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

export const CACHE_TTL = {
  FRED: 6 * 3600 * 1000,       // daily close; 6h covers one update cycle
  ECB: 12 * 3600 * 1000,       // monthly dataflow
  YAHOO_CHART: 2 * 3600 * 1000, // daily closes (intraday tolerance)
  YAHOO_ATMIV: 3 * 3600 * 1000, // option chains move intraday
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

/** realized vol of log returns (annualized, ddof=0) — realized_vol_series */
export function realizedVolSeries(closes) {
  const logret = [];
  for (let i = 1; i < closes.length; i++) {
    const a = closes[i - 1];
    const b = closes[i];
    if (Number.isFinite(a) && Number.isFinite(b) && a > 0 && b > 0) {
      logret.push(Math.log(b / a));
    } else {
      logret.push(NaN);
    }
  }
  const sd = rollingStd(logret, C.RV_LOOKBACK, Math.floor(C.RV_LOOKBACK / 2));
  return sd.map((v) => (Number.isFinite(v) ? v * Math.sqrt(C.TRADING_DAYS) : NaN));
}

export function dealerVolBpsSeries(bpsSeries) {
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
  const sd = rollingStd(diffs, C.DEALER_WINDOW, C.DEALER_WINDOW);
  return [NaN, ...sd.slice(0, sd.length - 1)]; // shift(1)
}

/**
 * Return curve port of engine/volatility.return_curve: for hold T=1..holdMax,
 * grossT = mean |x[t+T]-x[t]| over shock days; fee = rolling mean |ΔT|
 * shifted by T (no look-ahead); net = gross - fee*markup - friction.
 * `seriesBps` = values in bps. Returns {T, gross, hf, ret} rows + annualized
 * edge at holdMax.
 */
export function returnCurve(seriesBps, { holdMax = 21, percentileVs = null, atmIv = null, name = "asset", unit = "days", monthsPerYear = 12 } = {}) {
  const n = seriesBps.length;
  if (n < 120) return null;
  const rv = realizedVolSeries(seriesBps.map((v) => (Number.isFinite(v) ? v / 100.0 : NaN))); // pct series
  const threshold = percentile(rv.filter(Number.isFinite), C.SHOCK_PERCENTILE);
  const shock = rv.map((v) => Number.isFinite(v) && v >= threshold);
  const dealerVol = dealerVolBpsSeries(seriesBps);
  const volPct = percentile(dealerVol.filter(Number.isFinite), C.FRICTION_PERCENTILE);
  const friction = dealerVol.map((v) =>
    Number.isFinite(v) ? C.FRICTION_BASE_SPREAD_BPS * Math.exp(C.FRICTION_GROWTH_RATE * Math.max(0, v - volPct)) : NaN
  );
  // markup: 1 + share*(IV/RV - 1), floor 1.05; distressed exact grades +1.05
  const rvNow = floatOr(rv[n - 1], 0.0001);
  const distressed = C.DISTRESSED_GRADES.has(name);
  let base = C.DEALER_MARKUP_FLOOR;
  if (atmIv && Number.isFinite(rvNow) && rvNow > 0.0004) {
    base = Math.max(C.DEALER_MARKUP_FLOOR, 1 + C.DEALER_MARKUP_PREMIUM_SHARE * (atmIv / rvNow - 1));
  }
  if (distressed) base *= C.FALLEN_ANGEL_LIQUIDITY_PREMIUM;
  const dailyVolBps = floatOr(dealerVol[n - 1], 0);
  const annVolBps = dailyVolBps * Math.sqrt(C.TRADING_DAYS);
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
    const feeMean = rollingMean(muBase, C.DEALER_WINDOW, 10); // length n-T
    for (let i = 0; i < n; i++) {
      if (!shock[i]) continue;
      const g = Math.abs(seriesBps[i + T] - seriesBps[i]);
      if (!Number.isFinite(g)) continue;
      const fIdx = i - T; // fee known for move ending at i is at window index i-T
      const fee = fIdx >= 0 && feeMean[fIdx] !== undefined ? feeMean[fIdx] : NaN;
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
    rows.push({
      T,
      gross: round2(mean(grossVals)),
      hf: round2(mean(hfVals)),
      ret: round2(mean(retVals)),
    });
  }
  const last = rows[rows.length - 1];
  const periodsPerYear = unit === "months" ? monthsPerYear : C.TRADING_DAYS / holdMax;
  const edge = (v) => (v == null ? null : round4(v * periodsPerYear)); // annualized bps
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

/** toBps: values in percent -> bps */
export function toBps(rows) {
  return rows.map((r) => r.v * 100);
}
export function yahooToBps(rows) {
  return rows.map((r) => r.v * 100);
}

/** monthly -> bps for yield series */
export function monthBpsFromPct(rows) {
  return rows.map((r) => r.v * 100);
}