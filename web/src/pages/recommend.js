/**
 * Recommendation page: unsupervised strong / neutral / weak classification.
 *
 * PCA and k-means over the metric matrix, run inside each asset class. Select
 * an instrument to see every metric it was scored on, what pushed it up and
 * what held it back.
 */
import { loadRecommend } from "../store.js";

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const CLASS_META = {
  strong: { label: "Strong", color: "var(--green)", note: "top cluster on the quality axis within its own pool" },
  neutral: { label: "Neutral", color: "var(--text-secondary)", note: "middle cluster" },
  weak: { label: "Weak", color: "var(--red)", note: "bottom cluster on the quality axis within its own pool" },
};

function fmt(v, meta) {
  if (v == null || !Number.isFinite(v)) return "—";
  const u = meta?.unit || "";
  const d = u === "bps" ? 0 : Math.abs(v) >= 100 ? 1 : 2;
  return `${v > 0 && (u === "%" || u === "bps") ? "+" : ""}${v.toFixed(d)}${u === "%" ? "%" : u === "bps" ? "" : u === "x" ? "×" : u === "σ" ? "σ" : ""}`;
}

function seg(container, options, { onChange, active } = {}) {
  container.classList.add("pc-seg");
  container.innerHTML = "";
  for (const o of options) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = o.label;
    if (o.value === active) b.classList.add("active");
    b.addEventListener("click", () => {
      container.querySelectorAll("button").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      onChange(o.value);
    });
    container.appendChild(b);
  }
}

export async function render(root) {
  const payload = await loadRecommend();
  if (!payload || payload.status !== "OK") {
    root.innerHTML = `<div class="pc-empty">
      <div style="font-weight:620;color:var(--text-main);margin-bottom:6px">Recommendation engine unavailable</div>
      ${esc(payload?.why || "The endpoint returned no classification.")}</div>`;
    return { dispose() {} };
  }

  const meta = payload.metricMeta;
  const pools = payload.model.pools;
  let pool = pools[0].id;
  let selected = null;

  root.innerHTML = `
  <div class="pc-hero">
    <h1>Recommendations</h1>
    <p>Every instrument is scored on ${payload.model.metricsComputed} performance and risk metrics, then classified by two <b>unsupervised</b> methods — principal component analysis for the quality axis and k-means for the grouping. There are no labels anywhere in the pipeline: the model groups the instruments, and the words <b>strong</b>, <b>neutral</b> and <b>weak</b> are attached afterwards by ranking the clusters. Select any instrument for its full metric sheet, the metrics driving it and the metrics blocking it.</p>
  </div>
  <div class="pc-card pc-card-pad">
    <div class="pc-controls"><div id="pool-seg"></div></div>
    <div id="model-card" style="margin-top:16px"></div>
    <div class="grid-12" style="margin-top:16px">
      <div class="col-5"><div id="list"></div></div>
      <div class="col-7"><div id="detail"></div></div>
    </div>
    <div class="pc-note" id="caveats" style="margin-top:18px"></div>
  </div>`;

  const listEl = root.querySelector("#list");
  const detailEl = root.querySelector("#detail");
  const modelEl = root.querySelector("#model-card");

  function drawDetail() {
    const it = payload.items.find((x) => x.id === selected);
    if (!it) {
      detailEl.innerHTML = `<div class="pc-empty" style="padding:40px">Select an instrument to see every metric it was scored on.</div>`;
      return;
    }
    const cm = CLASS_META[it.classification];
    const groups = {};
    for (const [k, v] of Object.entries(it.metrics)) {
      const m = meta[k];
      if (!m) continue;
      (groups[m.group] = groups[m.group] || []).push({ k, v, m, z: it.z[k] });
    }

    detailEl.innerHTML = `
      <div class="pc-card-head" style="margin-bottom:4px">
        <div>
          <div class="pc-card-title" style="margin:0">${esc(it.name)}</div>
          <div class="pc-card-sub">${esc(it.label)} · ${esc(it.group)} · as of ${esc(it.asOf)}</div>
        </div>
        <span class="pc-badge" style="background:${cm.color};color:#fff;font-size:12px;padding:3px 12px">${cm.label}</span>
      </div>
      <div class="pc-note" style="margin:6px 0 14px">Score ${it.score} on the quality axis, ranked against ${esc(it.poolLabel.toLowerCase())} only. ${esc(cm.note)}.</div>

      <div class="grid-12" style="margin-bottom:14px">
        <div class="col-6">
          <div class="pc-card-title" style="font-size:13px">Major drivers</div>
          ${it.drivers.length ? it.drivers.map((d) => `
            <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border)">
              <span style="font-size:12.5px">${esc(d.label)}</span>
              <span style="font-variant-numeric:tabular-nums;color:var(--green);font-weight:640">+${d.contribution}</span>
            </div>`).join("") : `<div class="pc-note">Nothing pushes this instrument above its peers.</div>`}
        </div>
        <div class="col-6">
          <div class="pc-card-title" style="font-size:13px">Major blockers</div>
          ${it.blockers.length ? it.blockers.map((d) => `
            <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border)">
              <span style="font-size:12.5px">${esc(d.label)}</span>
              <span style="font-variant-numeric:tabular-nums;color:var(--red);font-weight:640">${d.contribution}</span>
            </div>`).join("") : `<div class="pc-note">Nothing holds this instrument back against its peers.</div>`}
        </div>
      </div>

      ${Object.entries(groups).map(([g, rows]) => `
        <div class="pc-card-title" style="font-size:13px;margin-top:12px">${esc(g)}</div>
        <table class="pc-table">
          <thead><tr><th>Metric</th><th class="num">Value</th><th class="num">vs peers</th></tr></thead>
          <tbody>${rows.map((r) => `<tr>
            <td>${esc(r.m.label)}${r.m.scaleFree ? "" : `<span style="color:var(--text-faint);font-size:10.5px"> · shown only</span>`}</td>
            <td class="num"><b>${fmt(r.v, r.m)}</b></td>
            <td class="num">${r.z == null ? `<span style="color:var(--text-faint)">—</span>` : `<span style="color:${r.z > 0.3 ? "var(--green)" : r.z < -0.3 ? "var(--red)" : "var(--text-secondary)"}">${r.z > 0 ? "+" : ""}${r.z.toFixed(2)}σ</span>`}</td>
          </tr>`).join("")}</tbody>
        </table>`).join("")}`;
  }

  function draw() {
    const p = pools.find((x) => x.id === pool);
    modelEl.innerHTML = `
      <div class="pc-kpis">
        <div class="pc-kpi-cell"><div class="pc-kpi">
          <div class="pc-kpi-label">Instruments</div><div class="pc-kpi-value">${p.instruments}</div>
          <div class="pc-kpi-extra">${payload.model.metricsComputed} metrics each · ${p.metricsUsedToClassify} classify</div></div></div>
        <div class="pc-kpi-cell"><div class="pc-kpi">
          <div class="pc-kpi-label">Quality axis</div><div class="pc-kpi-value">${p.varianceExplainedPC1}%</div>
          <div class="pc-kpi-extra">variance on PC1 · ${p.componentsUsedForClustering} components clustered</div></div></div>
        <div class="pc-kpi-cell"><div class="pc-kpi">
          <div class="pc-kpi-label">Cluster separation</div>
          <div class="pc-kpi-value" style="color:${p.silhouette > 0.5 ? "var(--green)" : p.silhouette > 0.25 ? "var(--text-main)" : "var(--red)"}">${p.silhouette}</div>
          <div class="pc-kpi-extra">silhouette · ${p.kmeansRestarts} restarts</div></div></div>
        <div class="pc-kpi-cell"><div class="pc-kpi">
          <div class="pc-kpi-label">Groups found</div>
          <div class="pc-kpi-value" style="font-size:17px">${p.clusterSizes.strong || 0} / ${p.clusterSizes.neutral || 0} / ${p.clusterSizes.weak || 0}</div>
          <div class="pc-kpi-extra">strong / neutral / weak</div></div></div>
      </div>
      <div class="pc-note" style="margin-top:10px">Top loadings on the quality axis: ${(payload.loadings[pool] || []).slice(0, 5).map((l) => `${esc(l.label)} ${l.loading > 0 ? "+" : ""}${l.loading}`).join(" · ")}</div>`;

    const rows = payload.items.filter((x) => x.pool === pool);
    listEl.innerHTML = ["strong", "neutral", "weak"].map((c) => {
      const g = rows.filter((x) => x.classification === c);
      if (!g.length) return "";
      const cm = CLASS_META[c];
      return `<div class="pc-card-title" style="font-size:13px;color:${cm.color};margin-top:10px">${cm.label} · ${g.length}</div>
        ${g.map((x) => `<div class="pc-reco-row" data-id="${esc(x.id)}" style="display:flex;justify-content:space-between;align-items:center;padding:8px 10px;border-bottom:1px solid var(--border);cursor:pointer;border-left:3px solid ${cm.color};${x.id === selected ? "background:var(--bg-sunken)" : ""}">
            <div><div style="font-weight:600;font-size:12.5px">${esc(x.name)}</div>
                 <div style="font-size:10.5px;color:var(--text-faint)">${esc(x.drivers[0] ? "driver: " + x.drivers[0].label : "")}</div></div>
            <div style="text-align:right"><div style="font-variant-numeric:tabular-nums;font-weight:640">${x.score}</div>
                 <div style="font-size:10.5px;color:var(--text-faint)">Sharpe ${x.metrics.sharpe == null ? "—" : x.metrics.sharpe.toFixed(2)}</div></div>
          </div>`).join("")}`;
    }).join("");

    listEl.querySelectorAll(".pc-reco-row").forEach((el) =>
      el.addEventListener("click", () => { selected = el.dataset.id; draw(); })
    );
    drawDetail();
  }

  root.querySelector("#caveats").innerHTML = payload.caveats.map(esc).join("<br>");
  seg(root.querySelector("#pool-seg"), pools.map((p) => ({ value: p.id, label: p.label })), {
    active: pool,
    onChange: (v) => { pool = v; selected = null; draw(); },
  });
  draw();

  return { dispose() {} };
}
