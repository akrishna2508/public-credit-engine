/**
 * Custom legend: every entry shows the FULL asset name plus a subtitle of
 * what it stands for, and clicking toggles exactly that line (or asset) on
 * and off. Never uses the default ECharts legend so the descriptions always
 * render.
 */
export function buildLegend(container, items, { onToggle, initialHidden = new Set() } = {}) {
  const el = container;
  el.classList.add("pc-legend");
  el.innerHTML = "";
  const hidden = new Set(initialHidden);

  const itemEls = items.map((it) => {
    const row = document.createElement("div");
    row.className = "pc-legend-item" + (hidden.has(it.id) ? " off" : "");
    row.dataset.legendItem = it.id;

    const swatch = document.createElement("span");
    swatch.className = "pc-legend-swatch";
    swatch.style.background = it.color;
    if (it.dashed) swatch.style.background =
      `repeating-linear-gradient(90deg, ${it.color} 0 8px, transparent 8px 12px)`;
    row.appendChild(swatch);

    const text = document.createElement("div");
    const name = document.createElement("div");
    name.className = "pc-legend-name";
    name.textContent = it.name;
    text.appendChild(name);
    if (it.standsFor) {
      const desc = document.createElement("div");
      desc.className = "pc-legend-desc";
      desc.textContent = it.standsFor;
      text.appendChild(desc);
    }
    row.appendChild(text);

    row.addEventListener("click", () => {
      if (hidden.has(it.id)) hidden.delete(it.id);
      else hidden.add(it.id);
      row.classList.toggle("off", hidden.has(it.id));
      onToggle(it.id, !hidden.has(it.id));
    });
    el.appendChild(row);
    return row;
  });

  return {
    hide(id) {
      hidden.add(id);
      itemEls.find((r) => r.dataset.legendItem === id)?.classList.add("off");
    },
    show(id) {
      hidden.delete(id);
      itemEls.find((r) => r.dataset.legendItem === id)?.classList.remove("off");
    },
    hidden: () => new Set(hidden),
  };
}