/**
 * World opportunity heat map.
 *
 * Countries are coloured by `heat` — the 1-month USD total-return proxy the
 * atlas reports — on a diverging red/neutral/green ramp with a live legend.
 * Countries outside the atlas keep the neutral basemap colour, so "no data"
 * never reads as "zero return".
 */
import * as echarts from "echarts";
import { cssVar, onThemeChange } from "../theme.js";

/* --------------------------------------------------------------------- */
/* basemap loading                                                        */
/* --------------------------------------------------------------------- */
let worldPromise = null;

async function fetchWorld() {
  const r = await fetch("/data/world.json", { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`world.json -> HTTP ${r.status}`);
  const ct = r.headers.get("content-type") || "";
  // A SPA rewrite that swallows a missing asset answers 200 text/html; parsing
  // that as JSON is what silently blanked the map in production. Fail loudly.
  if (!ct.includes("json")) {
    const head = (await r.text()).slice(0, 40).replace(/\s+/g, " ");
    throw new Error(`world.json served as "${ct}" (starts: ${head}) — the basemap is missing from this deployment`);
  }
  return r.json();
}

function loadWorld() {
  // never cache a rejected promise: a transient failure must not permanently
  // disable the map for the rest of the session
  if (!worldPromise) {
    worldPromise = fetchWorld().catch((e) => {
      worldPromise = null;
      throw e;
    });
  }
  return worldPromise;
}

/* --------------------------------------------------------------------- */
/* atlas name -> basemap feature name                                     */
/* --------------------------------------------------------------------- */
const NAME_ALIASES = {
  "South Korea": ["Korea", "Republic of Korea", "South Korea", "Korea, Rep."],
  "United States": ["United States", "United States of America", "USA"],
  "United Kingdom": ["United Kingdom", "Great Britain"],
  Czechia: ["Czech Rep.", "Czech Republic", "Czechia"],
  "United Arab Emirates": ["United Arab Emirates", "Utd. Arab Emir."],
  Vietnam: ["Vietnam", "Viet Nam"],
  "Bosnia and Herzegovina": ["Bosnia and Herz."],
  // the basemap uses pre-2019 or French forms for these
  "North Macedonia": ["Macedonia"],
  "Ivory Coast": ["Côte d'Ivoire", "Cote d'Ivoire"],
  Laos: ["Lao PDR", "Lao People's Democratic Republic"],
  // Natural Earth at this resolution carries no Taiwan polygon at all, so it
  // stays table-only however it is named — the coverage note says so
  "Euro Area": [],
};

const norm = (s) => String(s).toLowerCase().replace(/[^a-z]/g, "");

/** build featureName -> country node using name, aliases and normalised name */
function indexCountries(atlas, featureNames) {
  const byNorm = new Map();
  for (const f of featureNames) byNorm.set(norm(f), f);

  const map = new Map(); // featureName -> node
  const unmatched = [];
  for (const c of Object.values(atlas.countries || {})) {
    if (c.aggregate) continue; // the Euro Area is not a map feature
    const candidates = [c.name, ...(NAME_ALIASES[c.name] || [])];
    let hit = null;
    for (const cand of candidates) {
      if (featureNames.has(cand)) { hit = cand; break; }
      const n = byNorm.get(norm(cand));
      if (n) { hit = n; break; }
    }
    if (hit) map.set(hit, c);
    else unmatched.push(c.name);
  }
  return { map, unmatched };
}

/* --------------------------------------------------------------------- */
/* chart                                                                  */
/* --------------------------------------------------------------------- */

/** symmetric range that ignores single outliers (2nd..98th percentile) */
function heatRange(values) {
  if (!values.length) return 3;
  const s = [...values].sort((a, b) => a - b);
  const at = (p) => s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)))];
  const span = Math.max(Math.abs(at(0.02)), Math.abs(at(0.98)), 0.5);
  return Math.ceil(span * 2) / 2;
}

const fmt = (v, d = 2) => (v == null ? "—" : Number(v).toFixed(d));

export async function buildMapChart(el, atlas, { onSelect } = {}) {
  const world = await loadWorld();
  const featureNames = new Set((world.features || []).map((f) => f.properties?.name).filter(Boolean));
  const { map: byFeature, unmatched } = indexCountries(atlas, featureNames);

  echarts.registerMap("world", world);
  let chart = echarts.init(el, null, { renderer: "canvas" });

  const data = [...byFeature.entries()].map(([name, c]) => ({
    name,
    value: c.heat == null ? null : c.heat,
    iso: c.iso,
  }));
  const span = heatRange(data.map((d) => d.value).filter((v) => v != null));

  const legLabel = { bond: "Sovereign bond", equity: "Equity ETF", credit: "Regional credit" };

  const buildOption = () => ({
    animation: false,
    backgroundColor: "transparent",
    tooltip: {
      trigger: "item",
      backgroundColor: cssVar("--bg-card"),
      borderColor: cssVar("--border"),
      textStyle: { color: cssVar("--text-main"), fontSize: 12 },
      extraCssText: "box-shadow:0 8px 28px -10px rgba(0,0,0,.4);border-radius:10px;padding:10px 12px;",
      formatter: (p) => {
        const c = byFeature.get(p.name);
        if (!c) {
          return `<div style="font-weight:640">${esc(p.name)}</div>
                  <div style="color:${cssVar("--text-faint")};font-size:11px">Not covered by this atlas</div>`;
        }
        const b = c.instruments?.bonds || {};
        const legs = (c.heatLegs || [])
          .map(
            (l) =>
              `<tr><td style="color:${cssVar("--text-secondary")};padding-right:12px">${legLabel[l.leg] || l.leg}</td>
                   <td style="text-align:right;font-variant-numeric:tabular-nums;color:${l.value >= 0 ? cssVar("--green") : cssVar("--red")}">${l.value > 0 ? "+" : ""}${fmt(l.value)}%</td></tr>`
          )
          .join("");
        const heatColor = c.heat == null ? cssVar("--text-faint") : c.heat >= 0 ? cssVar("--green") : cssVar("--red");
        return `<div style="font-weight:640;margin-bottom:2px">${esc(c.name)}</div>
          <div style="font-size:10.5px;color:${cssVar("--text-faint")};margin-bottom:6px">${esc(c.regionLabel || c.region || "")}</div>
          <div style="font-size:19px;font-weight:700;color:${heatColor};font-variant-numeric:tabular-nums;line-height:1.1">
            ${c.heat == null ? "n/a" : (c.heat > 0 ? "+" : "") + fmt(c.heat, 2) + "%"}
          </div>
          <div style="font-size:10.5px;color:${cssVar("--text-faint")};margin-bottom:6px">1-month USD return proxy</div>
          <table style="border-collapse:collapse;font-size:11.5px">${legs}</table>
          ${b.yield_pct != null ? `<div style="font-size:11.5px;margin-top:6px;color:${cssVar("--text-secondary")}">10Y yield <b style="color:${cssVar("--text-main")}">${fmt(b.yield_pct)}%</b></div>` : ""}
          <div style="font-size:10.5px;color:${cssVar("--text-faint")};margin-top:6px">Click for the full country view</div>`;
      },
    },
    visualMap: {
      show: true,
      type: "continuous",
      min: -span,
      max: span,
      calculable: true,
      orient: "horizontal",
      left: 12,
      bottom: 8,
      itemWidth: 12,
      itemHeight: 132,
      precision: 1,
      text: [`+${span}%`, `−${span}%`],
      textStyle: { color: cssVar("--axis-text"), fontSize: 10 },
      inRange: {
        color: [
          cssVar("--heat-n3"), cssVar("--heat-n2"), cssVar("--heat-n1"),
          cssVar("--heat-0"),
          cssVar("--heat-p1"), cssVar("--heat-p2"), cssVar("--heat-p3"),
        ],
      },
      outOfRange: { color: [cssVar("--map-basemap")] },
    },
    series: [
      {
        name: "1-month USD return proxy",
        type: "map",
        map: "world",
        roam: true,
        scaleLimit: { min: 0.9, max: 14 },
        zoom: 1.15,
        center: [10, 22],
        selectedMode: false,
        itemStyle: {
          areaColor: cssVar("--map-basemap"),
          borderColor: cssVar("--map-stroke"),
          borderWidth: 0.5,
        },
        emphasis: {
          itemStyle: { borderColor: cssVar("--text-main"), borderWidth: 1.2, shadowBlur: 14, shadowColor: "rgba(0,0,0,.28)" },
          label: { show: true, color: cssVar("--text-main"), fontWeight: 600, fontSize: 11 },
        },
        label: { show: false },
        data,
      },
    ],
  });

  chart.setOption(buildOption());

  chart.on("click", (p) => {
    const c = byFeature.get(p.name);
    if (c && onSelect) onSelect(c.iso);
  });

  const onResize = () => chart.resize();
  window.addEventListener("resize", onResize);
  const offTheme = onThemeChange(() => chart.setOption(buildOption()));

  return {
    chart,
    matched: byFeature.size,
    unmatched,
    dispose() {
      window.removeEventListener("resize", onResize);
      offTheme();
      chart.dispose();
    },
  };
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
