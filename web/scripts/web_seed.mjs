/** Generates web/public/data/bundle.json — the committed seed snapshot.
 * The site prefers the live /api/* functions; this bundle is the offline
 * fallback (7-day refresh cadence is fine; data itself is recalibrated
 * each run). Also snapshots the IV accrual history into api/iv_history.json
 * (read by /api/status — Vercel bundles api/* into the functions) and
 * public/data/status.json (offline fallback for the Signals page).
 * scripts/accrue_iv_daily.sh re-runs this after every daily accrual so the
 * Signals cards stay current and auto-go-live on schedule.
 * Usage: node scripts/web_seed.mjs */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { computeStatus } from "../api/status.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(root, "..");
const atlasPath = resolve(repo, "data", "atlas.json");
const ivPath = resolve(repo, "data", "iv_history.json");

if (!existsSync(atlasPath)) {
  console.error("data/atlas.json missing — run the pipeline once to seed the fallback bundle.");
  process.exit(1);
}

const atlas = JSON.parse(readFileSync(atlasPath, "utf8"));
const bundle = {
  generated: atlas.generated || new Date().toISOString(),
  schema: "bundle.v1",
  note: "Seed snapshot generated from the local pipeline. The live /api/atlas endpoint refreshes automatically when deployed; this file is only the offline fallback.",
  countries: atlas.countries || {},
  regions: atlas.regions || {},
};

writeFileSync(resolve(root, "public", "data", "bundle.json"), JSON.stringify(bundle, null, 1));
console.log(`bundle.json written (${Object.keys(bundle.countries).length} countries)`);

if (existsSync(ivPath)) {
  const iv = JSON.parse(readFileSync(ivPath, "utf8"));
  writeFileSync(resolve(root, "api", "iv_history.json"), JSON.stringify(iv, null, 1));
  writeFileSync(resolve(root, "public", "data", "status.json"), JSON.stringify(computeStatus(iv), null, 1));
  const ticks = Object.fromEntries(Object.entries(iv).map(([t, d]) => [t, Object.keys(d || {}).length]));
  console.log(`iv_history.json snapshot copied to api/ (${JSON.stringify(ticks)})`);
  console.log(`status.json written (${computeStatus(iv).features.length} gated features)`);
} else {
  console.log("data/iv_history.json missing — Signals snapshot left as-is");
}