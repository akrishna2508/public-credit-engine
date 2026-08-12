/**
 * Period controls shared by every chart: preset buttons (1M … 15Y) that move
 * the ECharts dataZoom window, plus the built-in wheel/pinch zoom (dataZoom
 * 'inside') — period buttons and gestures control the same state.
 */
export const PERIODS = [
  { label: "1M", months: 1 },
  { label: "3M", months: 3 },
  { label: "6M", months: 6 },
  { label: "1Y", months: 12 },
  { label: "2Y", months: 24 },
  { label: "5Y", months: 60 },
  { label: "10Y", months: 120 },
  { label: "15Y", months: 180 },
];

export function buildPeriodBar(container, { onSelect, initial = "15Y" } = {}) {
  container.classList.add("pc-controls", "pc-periods");
  container.innerHTML = "";
  const btn = document.createElement("button");
  btn.className = "pc-btn";
  btn.textContent = "↔ drag · wheel/pinch to zoom";
  btn.title = "The period presets move the zoom window; you can also drag the slider or use the mouse wheel / pinch gesture.";
  container.appendChild(btn);
  const seg = document.createElement("div");
  seg.className = "pc-seg";
  PERIODS.forEach((p) => {
    const b = document.createElement("button");
    b.textContent = p.label;
    b.dataset.period = p.months;
    if (p.label === initial) b.classList.add("active");
    b.addEventListener("click", () => {
      seg.querySelectorAll("button").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      onSelect(p);
    });
    seg.appendChild(b);
  });
  container.appendChild(seg);
  return {
    setActive(months) {
      seg.querySelectorAll("button").forEach((b) =>
        b.classList.toggle("active", Number(b.dataset.period) === months));
    },
  };
}

/** maps a preset to a dataZoom {startValue,endValue} window in months */
export function presetToWindow(preset, totalMonths, unit = "months") {
  const start = Math.max(1, totalMonths - preset.months + 1);
  return { startValue: unit === "months" ? start : totalMonths - preset.months + 1, endValue: totalMonths };
}

/** dataZoom config (shared): slider + inside (wheel/pinch) with value mode */
export function dataZoomConfig({ total = 180, unit = "months", startValue = 1, endValue = 180 } = {}) {
  return [
    { type: "inside", xAxisIndex: 0, zoomOnMouseWheel: true, moveOnMouseWheel: true, moveOnMouseMove: true, minValueSpan: 0.5 },
    { type: "slider", xAxisIndex: 0, startValue, endValue, minValueSpan: 0.5, height: 18, bottom: 6, borderColor: "#e4e7ec", backgroundColor: "#f6f7f9", fillerColor: "rgba(16,24,40,0.08)", moveHandleSize: 8 },
  ];
}