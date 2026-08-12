/**
 * Data layer: live API first, committed seed bundle as fallback (works even
 * when the serverless functions are cold/rate-limited). Exposes a tiny pub/sub
 * hub for chart state (legend visibility, periods) and a debug handle for the
 * audit harness.
 */
const state = {
  atlas: null,
  returns: null,
  history: {},
  status: null,
  meta: null,
  generated: null,
};
const listeners = new Set();
const chartState = new Map(); // id -> { visible: Set<seriesId>, chart }

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function emit() {
  for (const fn of listeners) fn();
}

async function fetchJSON(url, fallback) {
  try {
    const ctl = new AbortController();
    // cold serverless + retry chains (e.g. the countries panel = 11 ECB
    // fetches) can exceed 25s on a first hit; 45s stays bounded
    const t = setTimeout(() => ctl.abort(), 45000);
    const r = await fetch(url, { signal: ctl.signal, headers: { Accept: "application/json" } });
    clearTimeout(t);
    if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
    const j = await r.json();
    if (j.status === "UNAVAILABLE") throw new Error(`${url} -> ${j.why || "unavailable"}`);
    return j;
  } catch (e) {
    if (!fallback) throw e;
    const r2 = await fetch(fallback);
    if (!r2.ok) throw e;
    return r2.json();
  }
}

export async function loadAtlas() {
  try {
    state.atlas = await fetchJSON("/api/atlas", "/data/bundle.json");
  } catch (e) {
    const r = await fetch("/data/bundle.json");
    state.atlas = r.ok ? await r.json() : null;
  }
  state.generated = state.atlas?.generated || null;
  emit();
  return state.atlas;
}

export async function loadReturns(market, mode) {
  const key = `returns:${market}:${mode}`;
  if (state.history[key]) return state.history[key];
  try {
    state.history[key] = await fetchJSON(`/api/returns?market=${market}&mode=${mode}`);
  } catch (e) {
    state.history[key] = null;
  }
  emit();
  return state.history[key];
}

export async function loadHistory(params) {
  const key = "history:" + new URLSearchParams(params).toString();
  if (state.history[key]) return state.history[key];
  try {
    state.history[key] = await fetchJSON(`/api/history?${new URLSearchParams(params)}`);
  } catch (e) {
    state.history[key] = null;
  }
  emit();
  return state.history[key];
}

export async function loadStatus() {
  if (state.status) return state.status;
  try {
    state.status = await fetchJSON("/api/status", "/data/status.json");
  } catch (e) {
    state.status = null;
  }
  emit();
  return state.status;
}

/* ---------- chart hub ---------- */
// registerChart(id, { chart, seriesIds, refresh }) — refresh() re-renders the
// chart's option from its own captured inputs + the visibility set.
export function registerChart(id, rec) {
  chartState.set(id, rec);
  return rec;
}
export function unregisterChart(id) {
  chartState.delete(id);
}
export function setSeriesVisible(id, seriesId, visible) {
  const rec = chartState.get(id);
  if (!rec) return;
  if (visible) rec.visible.add(seriesId);
  else rec.visible.delete(seriesId);
  rec.refresh();
  window.__pc?.pending?.();
}
export function isSeriesVisible(id, seriesId) {
  return chartState.get(id)?.visible.has(seriesId) ?? true;
}

/** audit handle (playwright + manual): window.__pc.state / .charts */
export function installAuditHandle() {
  window.__pc = {
    state,
    charts: () => {
      const out = {};
      for (const [id, rec] of chartState) {
        out[id] = {
          id,
          visibleCount: rec.visible.size,
          hasCanvas: !!rec.el.querySelector("canvas"),
          painted: (() => {
            // ground truth that series are actually drawn: count non-background
            // pixels on the chart canvas
            const canvas = rec.el.querySelector("canvas");
            if (!canvas || !canvas.width || !canvas.height) return false;
            try {
              const ctx = canvas.getContext("2d");
              const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
              let painted = 0;
              for (let i = 0; i < data.length; i += 400) {
                if (data[i + 3] > 0 && (data[i] < 245 || data[i + 1] < 245 || data[i + 2] < 245)) painted++;
              }
              return painted > 20;
            } catch (e) {
              return "err:" + String(e).slice(0, 40);
            }
          })(),
        };
      }
      return out;
    },
  };
}
