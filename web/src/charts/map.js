/**
 * World map: atlas countries colored by opportunity heat over a light beige
 * basemap (world.json). Green = attractive opportunity (positive heat),
 * red = unattractive, beige = no data / neutral. Click a country to open its
 * drill-down page.
 */
import * as echarts from "echarts";

let worldJsonPromise = null;
function loadWorld() {
  if (!worldJsonPromise) {
    worldJsonPromise = fetch("/data/world.json").then((r) => {
      if (!r.ok) throw new Error("world.json missing");
      return r.json();
    });
  }
  return worldJsonPromise;
}

export function heatColor(heat) {
  if (heat == null) return "#f9f6f1";
  const t = Math.max(-1, Math.min(1, heat));
  // diverging: green (positive opportunity) -> beige (0) -> red
  if (t > 0) {
    const a = t; // mix beige -> green
    return `rgba(18,183,106,${0.15 + 0.85 * a})`;
  }
  const a = -t;
  return `rgba(240,68,56,${0.15 + 0.85 * a})`;
}

export async function buildMapChart(el, atlas, { onSelect } = {}) {
  const world = await loadWorld();
  const chart = echarts.init(el);
  echarts.registerMap("world", world);

  // atlas names -> basemap feature names (echarts@4 world.json)
  const NAME_ALIASES = { "South Korea": "Korea" };
  const countries = Object.values(atlas.countries || {});
  const byFeature = new Map(
    countries.map((c) => [NAME_ALIASES[c.name] || c.name, c])
  );
  const data = countries
    .filter((c) => byFeature.has(NAME_ALIASES[c.name] || c.name))
    .map((c) => ({ name: NAME_ALIASES[c.name] || c.name, value: c.heat == null ? null : c.heat, iso: c.iso }));

  chart.setOption({
    animation: false,
    tooltip: {
      trigger: "item",
      formatter: (p) => {
        const c = byFeature.get(p.name);
        if (!c) return `${p.name}<br/>No coverage in this atlas`;
        const heat = c.heat == null ? "n/a" : Number(c.heat).toFixed(3);
        const y = c.instruments?.bonds?.yield_pct;
        return `<div style="font-weight:600">${esc(c.name)}</div>
                <div style="font-variant-numeric:tabular-nums">Heat: ${heat}</div>
                ${y != null ? `<div>10Y yield: ${y.toFixed(2)}%</div>` : ""}
                <div style="font-size:11px;color:#98a2b3">Click for the full country view</div>`;
      },
    },
    visualMap: {
      show: false,
      type: "piecewise",
      pieces: [
        { min: 0.0001, label: "Opportunity", color: "#12b76a" },
        { value: 0, label: "Neutral", color: "#f9f6f1" },
        { max: -0.0001, label: "Unattractive", color: "#f04438" },
      ],
      inRange: { color: ["#f04438", "#f9f6f1", "#12b76a"] },
    },
    series: [
      {
        name: "Opportunity heat",
        type: "map",
        map: "world",
        roam: true,
        scaleLimit: { min: 0.8, max: 12 },
        emphasis: {
          itemStyle: { areaColor: "#d0d5dd", shadowBlur: 12, shadowColor: "rgba(0,0,0,0.25)" },
          label: { show: true, color: "#101828", fontWeight: 600 },
        },
        select: { itemStyle: { areaColor: "#98a2b3" } },
        label: { show: false },
        itemStyle: { borderColor: "#d0d5dd", borderWidth: 0.6 },
        data,
      },
    ],
  });

  chart.on("click", (p) => {
    const c = byFeature.get(p.name);
    if (c && onSelect) onSelect(c.iso);
  });

  const onResize = () => chart.resize();
  window.addEventListener("resize", onResize);
  return {
    chart,
    dispose() {
      window.removeEventListener("resize", onResize);
      chart.dispose();
    },
  };
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}