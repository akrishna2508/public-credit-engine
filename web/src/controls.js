/**
 * Period controls shared by every chart: preset buttons (1M … 15Y) that move
 * the ECharts dataZoom window, alongside the built-in wheel/pinch zoom — the
 * buttons and the gestures drive the same state.
 */
import { cssVar } from "./theme.js";

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

export function buildPeriodBar(container, { onSelect, initial = "15Y", periods = PERIODS } = {}) {
  container.classList.add("pc-controls", "pc-periods");
  container.innerHTML = "";

  // a hint, not a control — this used to be a <button> that looked clickable
  // and did nothing
  const hint = document.createElement("span");
  hint.className = "pc-tag";
  hint.textContent = "↔ drag · wheel/pinch to zoom";
  hint.title = "The presets move the zoom window; you can also drag the slider or use the wheel / pinch gesture.";
  container.appendChild(hint);

  const seg = document.createElement("div");
  seg.className = "pc-seg";
  periods.forEach((p) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = p.label;
    b.dataset.period = String(p.months);
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
        b.classList.toggle("active", Number(b.dataset.period) === months)
      );
    },
    current() {
      const el = seg.querySelector("button.active");
      return el ? periods.find((p) => p.months === Number(el.dataset.period)) : null;
    },
  };
}

/**
 * Shared dataZoom pair (wheel/pinch + slider).
 *
 * `mode` matters and used to be wrong. A category or TIME axis has to be
 * windowed with the percentage form (start/end); passing the numeric
 * startValue/endValue form to a time axis is interpreted as epoch
 * milliseconds, so `startValue: 1, endValue: 180` asked for a 179-millisecond
 * window in January 1970 and the chart came back empty. Only a value axis
 * (the projection chart's 0-180 month horizon) takes the numeric form.
 */
export function dataZoomConfig({ mode = "percent", startValue = 0, endValue = 180, start = 0, end = 100 } = {}) {
  // The window must be set on BOTH components. They target the same axis, so
  // ECharts links them; giving it only to the slider let the `inside`
  // component's default full range win and the requested opening window was
  // silently discarded.
  const window_ = mode === "value" ? { startValue, endValue } : { start, end };
  return [
    {
      type: "inside",
      xAxisIndex: 0,
      zoomOnMouseWheel: true,
      moveOnMouseWheel: false,
      moveOnMouseMove: true,
      ...window_,
    },
    {
      type: "slider",
      xAxisIndex: 0,
      height: 18,
      bottom: 6,
      borderColor: cssVar("--border"),
      backgroundColor: cssVar("--bg-sunken"),
      fillerColor: "rgba(31,94,255,0.10)",
      handleStyle: { color: cssVar("--accent"), borderColor: cssVar("--accent") },
      moveHandleSize: 6,
      textStyle: { color: cssVar("--axis-text"), fontSize: 10 },
      ...window_,
    },
  ];
}
