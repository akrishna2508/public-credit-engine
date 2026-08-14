/**
 * Normalises the world basemap so India renders as one contiguous country
 * including Jammu & Kashmir, Ladakh and the Siachen Glacier.
 *
 * The Natural Earth basemap that ships with ECharts breaks the region out as
 * separate polygons — one named "Siachen Glacier" and two with an empty name —
 * because the territory is disputed between India, Pakistan and China. Left
 * alone they render as unlabelled grey holes north of India: they match no
 * country in the atlas, so they take the "no coverage" colour and the map
 * looks like India has been cut in half.
 *
 * This merges those polygons into the India feature, which is the Republic of
 * India's official cartographic convention. It is a display decision about a
 * disputed boundary, recorded here so it is not mistaken for a data error.
 *
 * Idempotent: re-running after the merge is a no-op. Run it whenever
 * public/data/world.json is regenerated.
 *
 * Usage: node scripts/fix_basemap.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const paths = [resolve(root, "public", "data", "world.json")];

/** lon/lat window covering the whole disputed Kashmir region */
const KASHMIR = { lonMin: 71.5, lonMax: 80.5, latMin: 31.5, latMax: 37.5 };

function bbox(geometry) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const walk = (c) => {
    if (typeof c[0] === "number") {
      if (c[0] < minX) minX = c[0];
      if (c[0] > maxX) maxX = c[0];
      if (c[1] < minY) minY = c[1];
      if (c[1] > maxY) maxY = c[1];
      return;
    }
    for (const x of c) walk(x);
  };
  walk(geometry.coordinates);
  return { minX, minY, maxX, maxY };
}

const insideKashmir = (b) =>
  b.minX >= KASHMIR.lonMin && b.maxX <= KASHMIR.lonMax &&
  b.minY >= KASHMIR.latMin && b.maxY <= KASHMIR.latMax;

/** every feature's polygons as a flat list of Polygon coordinate arrays */
function polygonsOf(geometry) {
  if (geometry.type === "Polygon") return [geometry.coordinates];
  if (geometry.type === "MultiPolygon") return geometry.coordinates;
  return [];
}

for (const path of paths) {
  let doc;
  try {
    doc = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    console.error(`skip ${path}: ${e.message}`);
    continue;
  }
  const features = doc.features || [];
  const india = features.find((f) => f.properties?.name === "India");
  if (!india) {
    console.error(`skip ${path}: no India feature`);
    continue;
  }

  const absorb = [];
  for (const f of features) {
    if (f === india) continue;
    const name = f.properties?.name ?? "";
    const named = name.trim();
    // only unnamed polygons and the Siachen Glacier, and only when they
    // actually sit in the Kashmir window — never a real neighbouring country
    if (named && named !== "Siachen Glacier") continue;
    const b = bbox(f.geometry);
    if (!insideKashmir(b)) continue;
    absorb.push(f);
  }

  if (!absorb.length) {
    console.log(`${path}: nothing to merge (already normalised)`);
    continue;
  }

  const merged = [...polygonsOf(india.geometry)];
  for (const f of absorb) merged.push(...polygonsOf(f.geometry));

  india.geometry = { type: "MultiPolygon", coordinates: merged };
  doc.features = features.filter((f) => !absorb.includes(f));

  writeFileSync(path, JSON.stringify(doc));
  const labels = absorb.map((f) => (f.properties?.name || "(unnamed)")).join(", ");
  console.log(
    `${path}: merged ${absorb.length} polygon group(s) into India — ${labels}; ` +
      `India now has ${merged.length} polygons, ${doc.features.length} features remain`
  );
}
