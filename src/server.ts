import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { fileURLToPath } from "node:url";
// Trips are stored per-device in localStorage — no server-side storage.
import { drivingRoute, geocode, optimizedTrip, reverse, suggest } from "./geo.ts";
import { hasGoogleKey } from "./google.ts";
import {
  record, recordError, getStats, startPruneLoop, loadPersisted,
  serverCounters, type EventKind,
} from "./analytics.ts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const pub = path.join(root, "public");
const PORT = Number(process.env.PORT || 3860);

function lanIPs() {
  const ips: string[] = [];
  const nets = os.networkInterfaces();
  for (const addrs of Object.values(nets)) {
    for (const a of addrs || []) {
      if (a.family === "IPv4" && !a.internal) ips.push(a.address);
    }
  }
  return ips;
}

function lanIPv4() {
  const ips = lanIPs();
  return ips.find((ip) => ip.startsWith("192.168.")) || ips.find((ip) => ip.startsWith("10.")) || ips[0] || "127.0.0.1";
}

function send(res: http.ServerResponse, status: number, body: unknown, type = "application/json") {
  const buf = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": `${type}; charset=utf-8`,
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(buf);
}

async function readBody(req: http.IncomingMessage) {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > 2_000_000) throw new Error("Body too large");
    chunks.push(c as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
  ".ico": "image/x-icon",
};

async function staticFile(urlPath: string, res: http.ServerResponse) {
  let rel = decodeURIComponent(urlPath.split("?")[0] || "/");
  if (rel === "/") rel = "/index.html";
  const fp = path.normalize(path.join(pub, rel));
  if (!fp.startsWith(pub)) return send(res, 403, { error: "Forbidden" });
  try {
    const st = await fs.stat(fp);
    if (!st.isFile()) return send(res, 404, { error: "Not found" });
    const ext = path.extname(fp);
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": ext === ".html" ? "no-store" : "no-cache",
    });
    createReadStream(fp).pipe(res);
  } catch {
    send(res, 404, { error: "Not found" });
  }
}


const ADMIN_PASS = process.env.ADMIN_PASS || "trips-admin";

function checkAdminAuth(req: http.IncomingMessage): boolean {
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Basic ")) return false;
  const decoded = Buffer.from(auth.slice(6), "base64").toString("utf8");
  const [, pass] = decoded.split(":");
  return pass === ADMIN_PASS;
}

const server = http.createServer(async (req, res) => {
  serverCounters.requests++;
  try {
    const u = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      });
      res.end();
      return;
    }

    if (u.pathname === "/health" && req.method === "GET") {
      return send(res, 200, { ok: true, googlePlaces: hasGoogleKey() });
    }

    if (u.pathname === "/api/lan" && req.method === "GET") {
      return send(res, 200, { lan: `http://${lanIPv4()}:${PORT}`, port: PORT });
    }

    if (u.pathname === "/api/reverse" && req.method === "GET") {
      const lat = Number(u.searchParams.get("lat"));
      const lon = Number(u.searchParams.get("lon"));
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return send(res, 400, { error: "Need lat/lon" });
      const hit = await reverse(lat, lon);
      return send(res, 200, { hit });
    }

    if (u.pathname === "/api/suggest" && req.method === "GET") {
      serverCounters.suggests++;
      const q = u.searchParams.get("q") || "";
      const lat = Number(u.searchParams.get("lat"));
      const lon = Number(u.searchParams.get("lon"));
      const hits = await suggest(q, Number.isFinite(lat) ? lat : undefined, Number.isFinite(lon) ? lon : undefined);
      return send(res, 200, { hits });
    }

    if (u.pathname === "/api/geocode" && req.method === "POST") {
      serverCounters.geocodes++;
      const body = await readBody(req);
      const lines: string[] = Array.isArray(body.lines)
        ? body.lines.map((x: unknown) => String(x || "").trim()).filter(Boolean)
        : String(body.q || "")
            .split(/\r?\n/)
            .map((s: string) => s.trim())
            .filter(Boolean);
      const lat = Number(body.lat);
      const lon = Number(body.lng ?? body.lon);
      const biasLat = Number.isFinite(lat) ? lat : undefined;
      const biasLon = Number.isFinite(lon) ? lon : undefined;
      const chunk = lines.slice(0, 200);
      const results: { query: string; hit: Awaited<ReturnType<typeof geocode>> }[] = new Array(chunk.length);
      let i = 0;
      const workers = Array.from({ length: Math.min(2, chunk.length) }, async () => {
        while (i < chunk.length) {
          const idx = i++;
          const line = chunk[idx];
          try {
            results[idx] = { query: line, hit: await geocode(line, biasLat, biasLon) };
          } catch {
            results[idx] = { query: line, hit: null };
          }
        }
      });
      await Promise.all(workers);
      return send(res, 200, { results });
    }

    if (u.pathname === "/api/route" && req.method === "POST") {
      serverCounters.routes++;
      const body = await readBody(req);
      const pts = (body.points || []).filter(
        (p: { lat?: number; lng?: number }) => Number.isFinite(p.lat) && Number.isFinite(p.lng),
      );
      if (pts.length < 2) return send(res, 400, { error: "Add at least two places" });
      const roundtrip = !!body.roundtrip;
      const optimize = !!body.optimize;
      if (optimize) serverCounters.optimises++;
      const lockStart = !!body.lockStart;
      try {
        const result = optimize
          ? await optimizedTrip(pts, {
              roundtrip,
              lockStart,
              avoidTolls: !!body.avoidTolls,
              avoidFerries: !!body.avoidFerries,
            })
          : await drivingRoute(roundtrip ? [...pts, pts[0]] : pts, {
              avoidTolls: !!body.avoidTolls,
              avoidFerries: !!body.avoidFerries,
            });
        return send(res, 200, result);
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        recordError("server", raw, "/api/route");
        return send(res, 502, {
          error: /busy|abort|timeout|fetch|ECONN|Upstream/i.test(raw)
            ? "Couldn't build the drive. Try again."
            : raw,
        });
      }
    }

    // ── Analytics ping (client events) ──────────────
    if (u.pathname === "/api/ping" && req.method === "POST") {
      const body = await readBody(req);
      const sid  = String(body.sid  || "").slice(0, 64);
      const did  = String(body.did  || "").slice(0, 64);
      const kind = String(body.kind || "session") as EventKind;
      const meta = body.meta && typeof body.meta === "object" ? body.meta as Record<string, unknown> : undefined;
      if (sid && did) record(kind, sid, did, meta);
      return send(res, 200, { ok: true });
    }

    // ── Client error reporting ───────────────────────
    if (u.pathname === "/api/error" && req.method === "POST") {
      const body = await readBody(req);
      recordError("client", String(body.message || "unknown"), String(body.path || ""));
      return send(res, 200, { ok: true });
    }

    // ── Stats API (password protected) ──────────────
    if (u.pathname === "/api/stats" && req.method === "GET") {
      if (!checkAdminAuth(req)) {
        return send(res, 401, { error: "Unauthorised" });
      }
      return send(res, 200, getStats({ googlePlaces: hasGoogleKey() }));
    }

    // Trip CRUD — trips live on-device (localStorage). Server returns empty stubs.
    if (u.pathname === "/api/trips" && req.method === "GET") {
      return send(res, 200, { records: [] });
    }
    const one = u.pathname.match(/^\/api\/trips\/([^/]+)$/);
    if (one && (req.method === "PUT" || req.method === "DELETE")) {
      return send(res, 200, { ok: true });
    }

    if ((u.pathname === "/admin" || u.pathname === "/admin.html") && req.method === "GET") {
      return staticFile("/admin.html", res);
    }

    if (req.method === "GET") return staticFile(u.pathname, res);
    send(res, 404, { error: "Not found" });
  } catch (err) {
    recordError("server", err instanceof Error ? err.message : String(err));
    send(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
});

startPruneLoop();
loadPersisted().catch(() => {});
server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Trip planner listening on 0.0.0.0:${PORT}`);
  if (!hasGoogleKey()) {
    console.warn("GOOGLE_MAPS_API_KEY not set — search uses OpenStreetMap (limited business names).");
  } else {
    console.log("Google Places search enabled.");
  }
  if (!process.env.RENDER) {
    const ip = lanIPv4();
    console.log(`  Phone (same Wi‑Fi):  http://${ip}:${PORT}`);
    for (const extra of lanIPs().filter((x) => x !== ip)) {
      console.log(`  Also:                 http://${extra}:${PORT}`);
    }
    console.log(`  This PC:             http://127.0.0.1:${PORT}`);
  }
});
