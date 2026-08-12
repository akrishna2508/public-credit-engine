/**
 * Signals page: honest gate registry for every feature that cannot run yet.
 * Each card shows the real reason it is gated and the date it AUTO-GOES
 * LIVE (or "when the gate data first exists" when no date can be promised).
 * `live` flips by itself — the snapshot/count comes from the committed
 * iv_history snapshot refreshed daily by the accrual daemon, and the
 * date-gated legs compare the calendar. No code change is ever needed for
 * a feature to go live; the card just switches to live data.
 */
import { loadStatus } from "../store.js";

const STATUS_META = {
  live: { label: "LIVE now", cls: "heat-pos" },
  accruing: { label: "Accruing", cls: "heat-zero" },
  "date-gated": { label: "Date-gated", cls: "neutral" },
  "waiting-for-data": { label: "Waiting for market data", cls: "neutral" },
};

const fmtDate = (iso) => {
  if (!iso) return null;
  const d = new Date(iso + "T00:00:00Z");
  return d.toUTCString().slice(0, 16);
};

export async function render(root) {
  const st = await loadStatus();
  if (!st?.features) {
    root.innerHTML = `<div class="pc-empty">Signal status is unavailable right now — check back shortly.</div>`;
    return { dispose() {} };
  }

  root.innerHTML = `
  <div class="grid-12">
    <div class="col-12">
      <div class="pc-card pc-card-pad">
        <div class="pc-card-title">Signals — what goes live next</div>
        <div class="pc-card-sub">Every feature below is built and running its data accrual. It flips to <b>LIVE</b> by itself the moment its gate is satisfied — no code change, no manual switch.</div>
        <div class="pc-note" style="margin-top:0;margin-bottom:14px">Snapshot source: ${st.snapshot?.source || "live accrual"}${st.snapshot?.lastDate ? ` · last real snapshot ${st.snapshot.lastDate}` : ""}. Generated ${new Date(st.generated).toUTCString().slice(0, 22)}.</div>
        <div id="signals-list"></div>
      </div>
    </div>
  </div>`;

  const list = root.querySelector("#signals-list");
  list.innerHTML = st.features
    .map((f) => {
      const meta = STATUS_META[f.status] || STATUS_META["waiting-for-data"];
      const progress =
        f.progress && f.progress.needed > 0
          ? `<div class="pc-sig-bar"><div class="pc-sig-bar-fill" style="width:${Math.min(100, (f.progress.accrued / f.progress.needed) * 100)}%"></div></div>
             <div class="pc-sig-progress">${f.progress.accrued} / ${f.progress.needed} ${f.progress.accrued === 1 ? "day" : "days"} accrued</div>`
          : "";
      const goLive = f.live
        ? `<div class="pc-sig-golive live">● Live now — data flowing. This card went live automatically.</div>`
        : f.goLiveDate
          ? `<div class="pc-sig-golive">► Auto-goes live on <b>${fmtDate(f.goLiveDate)}</b>${f.dateNote ? `<br><span class="pc-sig-faint">${f.dateNote}</span>` : ""}</div>`
          : `<div class="pc-sig-golive">► Auto-goes live the first day the gate data exists — no date can be promised. ${f.dateNote || ""}</div>`;
      const auto = f.autoGoLive ? `<span class="pc-sig-faint">auto-go-live wired</span>` : "";
      return `<div class="pc-sig-card">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          <b class="pc-sig-name">${f.name}</b>
          <span class="pc-badge ${meta.cls}">${meta.label}</span>
          ${auto}
        </div>
        <div class="pc-sig-what">${f.what}</div>
        ${goLive}
        ${progress}
        <div class="pc-sig-note">${f.note || ""}</div>
      </div>`;
    })
    .join("");

  return { dispose() {} };
}