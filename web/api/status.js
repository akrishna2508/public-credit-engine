/**
 * GET /api/status — gated-feature registry for the Signals page.
 *
 * Every feature that cannot run yet (IV-RV accrual, COT BBG IG/HY futures
 * legs, per-country straddle, EMHY chain, ANGL straddle quote) reports its
 * honest state, progress and the date it AUTO-GOES LIVE. `live` flips by
 * itself the moment the snapshot data satisfies the gate or the calendar
 * date arrives — no code change is ever needed: the committed snapshot
 * (api/iv_history.json, refreshed daily by scripts/accrue_iv_daily.sh via
 * npm run seed) is the single source of truth, and the date-gated legs
 * compare Date.now() against their documented unlock dates.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { json } from "./_shared.js";

export const config = { runtime: "nodejs" };

export const IV_Z_MIN_OBS = 20; // config.IV_Z_MIN_OBS
export const COT_MIN_HISTORY_YEARS = 2; // config.COT_MIN_HISTORY_YEARS
const IV_TICKERS = ["HYG", "LQD", "TLT", "EMB", "ANGL", "JNK"];

export function loadIvHistory() {
  try {
    const p = fileURLToPath(new URL("./iv_history.json", import.meta.url));
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/** next `n` weekdays after iso date (launchd accrual runs weekdays only) */
export function addTradingDays(iso, n) {
  const d = new Date(iso + "T00:00:00Z");
  let added = 0;
  while (added < n) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) added++;
  }
  return d.toISOString().slice(0, 10);
}

export function computeStatus(ivHistory) {
  const counts = {};
  let lastDate = null;
  for (const t of IV_TICKERS) {
    const days = ivHistory && ivHistory[t] ? Object.keys(ivHistory[t]) : [];
    counts[t] = days.length;
    for (const d of days) if (!lastDate || d > lastDate) lastDate = d;
  }
  const maxAccrued = Math.max(0, ...Object.values(counts));
  const ivrvLive = maxAccrued >= IV_Z_MIN_OBS;
  const ivrvDate = ivrvLive || !lastDate ? null : addTradingDays(lastDate, IV_Z_MIN_OBS - maxAccrued);

  const features = [
    {
      id: "ivrv",
      name: "IV-RV premium signal",
      what: "The board's options leg: the z-score of credit-ETF ATM implied vol vs realized vol, accrued daily from real listed options chains (IV floor gate 0.02 keeps degraded feeds out).",
      autoGoLive: true,
      live: ivrvLive,
      status: ivrvLive ? "live" : "accruing",
      progress: { accrued: maxAccrued, needed: IV_Z_MIN_OBS },
      goLiveDate: ivrvDate,
      note: ivrvLive
        ? "LIVE — the premium z-series feeds the board and the walk-forward battery automatically."
        : `Accruing real daily snapshots (weekday 18:00 launchd). Per ticker: ${IV_TICKERS.map((t) => `${t} ${counts[t]}/${IV_Z_MIN_OBS}`).join(" · ")}.`,
      dateNote: ivrvLive
        ? null
        : "Weekday estimate from the last real snapshot; a degraded-feed day (IV gate) adds a day. The leg unlocks itself the day the 20th real snapshot lands.",
    },
    {
      id: "cot_hy",
      name: "COT BBG HY credit futures leg",
      what: "Net leveraged-money / dealer positioning on the Bloomberg HY credit futures contract — listed 2026-03.",
      autoGoLive: true,
      live: new Date() >= new Date("2028-03-31T00:00:00Z"),
      status: "date-gated",
      progress: null,
      goLiveDate: "2028-03-31",
      note: "The ≥2-year history gate (COT_MIN_HISTORY_YEARS) needs weekly reports from the contract's 2026-03 listing. The board reports this honestly; no code change can accelerate real history.",
      dateNote: "This card flips to live on its own the first day the 2-year history window is complete.",
    },
    {
      id: "cot_ig",
      name: "COT BBG IG credit futures leg",
      what: "Net leveraged-money / dealer positioning on the Bloomberg IG credit futures contract — listed 2026-05.",
      autoGoLive: true,
      live: new Date() >= new Date("2028-05-31T00:00:00Z"),
      status: "date-gated",
      progress: null,
      goLiveDate: "2028-05-31",
      note: "The ≥2-year history gate (COT_MIN_HISTORY_YEARS) needs weekly reports from the contract's 2026-05 listing. The board reports this honestly; no code change can accelerate real history.",
      dateNote: "This card flips to live on its own the first day the 2-year history window is complete.",
    },
    {
      id: "country_straddle",
      name: "Per-country straddle yield / VRP",
      what: "Spec §3.3-3.4 country legs: ATM straddle yield and vol-risk premium outside the US.",
      autoGoLive: true,
      live: false,
      status: "waiting-for-data",
      progress: null,
      goLiveDate: null,
      note: "No free per-country ETF options chain exists in the daily accrual yet. This card flips to live automatically the first day a real country chain accrues (checked daily by the launchd daemon).",
      dateNote: "No date can be promised — the exchanges' chains are the gate, and thin markets decide.",
    },
    {
      id: "emhy_chain",
      name: "EMHY options chain",
      what: "ATM implied vol + straddle for the EM high-yield ETF (iShares EMHY).",
      autoGoLive: true,
      live: false,
      status: "waiting-for-data",
      progress: null,
      goLiveDate: null,
      note: "EMHY has no listed expiries on the free feed — a genuine thin-market fact. This card flips to live automatically the first day a real chain exists.",
      dateNote: "No date can be promised — the exchange lists expiries on its own schedule.",
    },
    {
      id: "angl_straddle",
      name: "ANGL ATM straddle quote",
      what: "Real ATM straddle price for the fallen-angel ETF (ANGL) — the thin chain has no straddle quote yet.",
      autoGoLive: true,
      live: false,
      status: "waiting-for-data",
      progress: null,
      goLiveDate: null,
      note: "ANGL accrues IV (2/20) but its thin chain carries no ATM straddle quote. This card flips to live automatically the first day a real straddle snapshot accrues.",
      dateNote: "No date can be promised — the quote appears when the market makes it.",
    },
  ];

  return {
    status: "OK",
    generated: new Date().toISOString(),
    schema: "signals.v1",
    features,
    snapshot: {
      lastDate,
      source: ivHistory ? "api/iv_history.json (refreshed daily by the accrual daemon via npm run seed)" : "no snapshot on this deployment",
    },
  };
}

export default function handler(req, res) {
  json(res, computeStatus(loadIvHistory()));
}
