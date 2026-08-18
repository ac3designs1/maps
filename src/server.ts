import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { allTrips, deleteTrip, getTrip, listTrips, upsertTrip, type Trip } from "./trips.ts";
import { drivingRoute, geocode, optimizedTrip, reverse, suggest } from "./geo.ts";

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

function emptyTrip(): Trip {
  const now = Date.now();
  return {
    id: randomUUID(),
    title: "Untitled trip",
    roundtrip: false,
    keepEnds: true,
    createdAt: now,
    updatedAt: now,
    stops: [
      { id: randomUUID(), query: "", label: "", lat: null, lng: null },
      { id: randomUUID(), query: "", label: "", lat: null, lng: null },
    ],
  };
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end();
      return;
    }

    if (u.pathname === "/health" && req.method === "GET") {
      return send(res, 200, { ok: true });
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
      const q = u.searchParams.get("q") || "";
      const lat = Number(u.searchParams.get("lat"));
      const lon = Number(u.searchParams.get("lon"));
      const hits = await suggest(q, Number.isFinite(lat) ? lat : undefined, Number.isFinite(lon) ? lon : undefined);
      return send(res, 200, { hits });
    }

    if (u.pathname === "/api/geocode" && req.method === "POST") {
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
      const workers = Array.from({ length: Math.min(4, chunk.length) }, async () => {
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
      const body = await readBody(req);
      const pts = (body.points || []).filter(
        (p: { lat?: number; lng?: number }) => Number.isFinite(p.lat) && Number.isFinite(p.lng),
      );
      if (pts.length < 2) return send(res, 400, { error: "Add at least two places" });
      const roundtrip = !!body.roundtrip;
      const optimize = !!body.optimize;
      const keepEnds = body.keepEnds !== false;
      try {
        const result = optimize
          ? await optimizedTrip(pts, { roundtrip, keepEnds })
          : await drivingRoute(roundtrip ? [...pts, pts[0]] : pts);
        return send(res, 200, result);
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        return send(res, 502, {
          error: /busy|abort|timeout|fetch|ECONN|Upstream/i.test(raw)
            ? "Couldn't build the drive. Try again."
            : raw,
        });
      }
    }

    if (u.pathname === "/api/trips" && req.method === "GET") {
      const records = await allTrips();
      return send(res, 200, { trips: await listTrips(), records });
    }

    if (u.pathname === "/api/trips" && req.method === "POST") {
      const trip = emptyTrip();
      await upsertTrip(trip);
      return send(res, 200, { trip });
    }

    const one = u.pathname.match(/^\/api\/trips\/([^/]+)$/);
    if (one && req.method === "GET") {
      const trip = await getTrip(decodeURIComponent(one[1]));
      if (!trip) return send(res, 404, { error: "Not found" });
      return send(res, 200, { trip });
    }
    if (one && req.method === "PUT") {
      const id = decodeURIComponent(one[1]);
      const body = await readBody(req);
      const prev = (await getTrip(id)) || emptyTrip();
      const trip: Trip = {
        ...prev,
        ...(body.trip || {}),
        id,
        updatedAt: Date.now(),
      };
      await upsertTrip(trip);
      return send(res, 200, { trip });
    }
    if (one && req.method === "DELETE") {
      await deleteTrip(decodeURIComponent(one[1]));
      return send(res, 200, { ok: true });
    }

    if (req.method === "GET") return staticFile(u.pathname, res);
    send(res, 404, { error: "Not found" });
  } catch (err) {
    send(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
});

server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Trip planner listening on 0.0.0.0:${PORT}`);
  if (!process.env.RENDER) {
    const ip = lanIPv4();
    console.log(`  Phone (same Wi‑Fi):  http://${ip}:${PORT}`);
    for (const extra of lanIPs().filter((x) => x !== ip)) {
      console.log(`  Also:                 http://${extra}:${PORT}`);
    }
    console.log(`  This PC:             http://127.0.0.1:${PORT}`);
  }
});
