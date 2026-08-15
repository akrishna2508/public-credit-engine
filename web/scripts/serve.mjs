/** Local dev/audit server: serves built dist/ statically and executes the
 * same api/*.js handlers the Vercel deployment uses. NOT part of the product.
 * Usage: node scripts/serve.mjs [port=8787] */
import { createServer } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(__dirname, "..");
const distRoot = join(webRoot, "dist");
const port = Number(process.argv[2] || process.env.PORT || 8787);

// minimal .env loader (repo root) — no external deps; real deployments
// (Vercel) inject FRED_API_KEY etc. as environment variables instead.
{
  const envPath = join(webRoot, "..", ".env");
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    }
  }
  console.log(`env: .env ${existsSync(envPath) ? "found" : "missing"}; FRED_API_KEY ${process.env.FRED_API_KEY ? "loaded" : "MISSING"}`);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

const handlers = {
  "/api/atlas": () => import("../api/atlas.js").then((m) => m.default),
  "/api/returns": () => import("../api/returns.js").then((m) => m.default),
  "/api/history": () => import("../api/history.js").then((m) => m.default),
  "/api/status": () => import("../api/status.js").then((m) => m.default),
  "/api/forecast": () => import("../api/forecast.js").then((m) => m.default),
  "/api/opportunities": () => import("../api/opportunities.js").then((m) => m.default),
  "/api/spreads": () => import("../api/spreads.js").then((m) => m.default),
  "/api/drivers": () => import("../api/drivers.js").then((m) => m.default),
  "/api/recommend": () => import("../api/recommend.js").then((m) => m.default),
};

const server = createServer(async (req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (pathname.startsWith("/api/")) {
    const load = handlers[pathname];
    if (!load) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    try {
      const handler = await load();
      await handler(req, res);
    } catch (e) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ status: "ERROR", error: e.stack || e.message }));
    }
    return;
  }

  let file = normalize(join(distRoot, pathname === "/" ? "index.html" : pathname));
  if (!file.startsWith(distRoot)) {
    res.statusCode = 403;
    res.end("forbidden");
    return;
  }
  // SPA fallback for ROUTES only. A missing /data/*.json or /assets/* must
  // 404 honestly — silently serving index.html in its place is exactly what
  // hid the missing seed bundle in production: the fetch saw HTTP 200 and
  // only failed later, inside JSON.parse.
  if (!existsSync(file) || statSync(file).isDirectory()) {
    const ext = extname(file);
    if (ext && ext !== ".html") {
      res.statusCode = 404;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ status: "NOT_FOUND", path: pathname }));
      return;
    }
    file = join(distRoot, "index.html");
  }
  res.setHeader("Content-Type", MIME[extname(file)] || "application/octet-stream");
  res.end(readFileSync(file));
});

server.listen(port, () => console.log(`serve http://127.0.0.1:${port}`));