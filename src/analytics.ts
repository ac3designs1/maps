/**
 * Self-hosted analytics. Privacy-first: no cookies, no PII.
 * In-memory + JSON file so a restart doesn't wipe the last 7 days.
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const ACTIVE_MS = 5 * 60 * 1000;
const TZ = "Australia/Sydney";

export type EventKind =
  | "session"
  | "route"
  | "optimise"
  | "navigate"
  | "share"
  | "paste"
  | "error";

interface Event {
  ts: number;
  kind: EventKind;
  sid: string;
  did: string;
  meta?: Record<string, unknown>;
}

interface ErrorEvent {
  ts: number;
  source: "client" | "server";
  message: string;
  path?: string;
}

const events: Event[] = [];
const errors: ErrorEvent[] = [];
const sessions = new Map<string, number>();
let peakActive = 0;
const BOOT_TS = Date.now();

export const serverCounters = {
  requests: 0,
  suggests: 0,
  geocodes: 0,
  routes: 0,
  optimises: 0,
  errors: 0,
};

function dataFile() {
  const dir = process.env.DATA_DIR || path.join(process.cwd(), "data");
  return { dir, file: path.join(dir, "analytics.json") };
}

function prune() {
  const cutoff = Date.now() - WINDOW_MS;
  while (events.length && events[0].ts < cutoff) events.shift();
  while (errors.length && errors[0].ts < cutoff) errors.shift();
  for (const [sid, ts] of sessions) {
    if (ts < cutoff) sessions.delete(sid);
  }
}

function activeCount(now = Date.now()) {
  let n = 0;
  for (const ts of sessions.values()) if (now - ts <= ACTIVE_MS) n++;
  if (n > peakActive) peakActive = n;
  return n;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    persist().catch(() => {});
  }, 4000);
}

async function persist() {
  prune();
  const { dir, file } = dataFile();
  await fs.mkdir(dir, { recursive: true });
  const payload = JSON.stringify({
    savedAt: Date.now(),
    peakActive,
    events: events.slice(-8000),
    errors: errors.slice(-500),
    counters: serverCounters,
  });
  await fs.writeFile(file, payload);
}

export async function loadPersisted() {
  try {
    const raw = JSON.parse(await fs.readFile(dataFile().file, "utf8"));
    if (Array.isArray(raw.events)) {
      events.length = 0;
      events.push(...raw.events);
      for (const e of events) sessions.set(e.sid, Math.max(sessions.get(e.sid) || 0, e.ts));
    }
    if (Array.isArray(raw.errors)) {
      errors.length = 0;
      errors.push(...raw.errors);
    }
    if (typeof raw.peakActive === "number") peakActive = raw.peakActive;
    prune();
  } catch {
    /* first boot */
  }
}

export function record(kind: EventKind, sid: string, did: string, meta?: Record<string, unknown>) {
  const ts = Date.now();
  events.push({ ts, kind, sid, did, meta });
  sessions.set(sid, ts);
  activeCount(ts);
  if (events.length > 12_000) events.splice(0, 2000);
  scheduleSave();
}

export function recordError(source: "client" | "server", message: string, path?: string) {
  errors.push({ ts: Date.now(), source, message: String(message).slice(0, 500), path });
  serverCounters.errors++;
  if (errors.length > 2000) errors.splice(0, 200);
  scheduleSave();
}

function fmtTime(ts: number, opts?: Intl.DateTimeFormatOptions) {
  return new Date(ts).toLocaleString("en-AU", { timeZone: TZ, ...opts });
}

function hourLabel(ts: number) {
  return new Date(ts).toLocaleTimeString("en-AU", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: TZ,
  });
}

export function getStats(extra: Record<string, unknown> = {}) {
  prune();
  const now = Date.now();
  const dayAgo = now - 86_400_000;
  const last24 = events.filter((e) => e.ts >= dayAgo);

  const activeSessions = activeCount(now);
  const uniqueDevices24h = new Set(last24.map((e) => e.did)).size;
  const uniqueSessions24h = new Set(last24.map((e) => e.sid)).size;

  const byKind: Record<string, number> = {};
  for (const e of last24) byKind[e.kind] = (byKind[e.kind] || 0) + 1;

  const hourly: { hour: string; sessions: number; routes: number; navigates: number }[] = [];
  for (let h = 23; h >= 0; h--) {
    const hStart = now - (h + 1) * 3_600_000;
    const hEnd = now - h * 3_600_000;
    const slice = last24.filter((e) => e.ts >= hStart && e.ts < hEnd);
    hourly.push({
      hour: hourLabel(hStart),
      sessions: new Set(slice.map((e) => e.sid)).size,
      routes: slice.filter((e) => e.kind === "route" || e.kind === "optimise").length,
      navigates: slice.filter((e) => e.kind === "navigate").length,
    });
  }

  const daily: { day: string; sessions: number; routes: number; devices: number }[] = [];
  for (let d = 6; d >= 0; d--) {
    const start = now - (d + 1) * 86_400_000;
    const end = now - d * 86_400_000;
    const slice = events.filter((e) => e.ts >= start && e.ts < end);
    daily.push({
      day: new Date(end - 1).toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short", timeZone: TZ }),
      sessions: new Set(slice.map((e) => e.sid)).size,
      routes: slice.filter((e) => e.kind === "route" || e.kind === "optimise").length,
      devices: new Set(slice.map((e) => e.did)).size,
    });
  }

  const routes = last24.filter((e) => e.kind === "route");
  const avgStops = routes.length
    ? Math.round((routes.reduce((n, e) => n + Number(e.meta?.stops || 0), 0) / routes.length) * 10) / 10
    : 0;
  const avgKm = routes.length
    ? Math.round(routes.reduce((n, e) => n + Number(e.meta?.km || 0), 0) / routes.length)
    : 0;

  const funnel = {
    sessions: uniqueSessions24h,
    routes: byKind.route || 0,
    optimise: byKind.optimise || 0,
    navigate: byKind.navigate || 0,
    share: byKind.share || 0,
    paste: byKind.paste || 0,
    routeRate: uniqueSessions24h ? Math.round(((byKind.route || 0) / uniqueSessions24h) * 100) : 0,
    navRate: uniqueSessions24h ? Math.round(((byKind.navigate || 0) / uniqueSessions24h) * 100) : 0,
  };

  const feed = [...last24].slice(-40).reverse().map((e) => ({
    time: fmtTime(e.ts, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }),
    kind: e.kind,
    detail:
      e.kind === "route" && e.meta
        ? `${e.meta.stops || "?"} stops · ${e.meta.km || "?"} km`
        : e.kind === "optimise" && e.meta
          ? `${e.meta.stops || "?"} stops`
          : e.kind === "paste" && e.meta
            ? `${e.meta.lines || "?"} lines`
            : "",
  }));

  const recentErrors = errors.slice(-50).reverse().map((e) => ({
    time: fmtTime(e.ts, { hour: "2-digit", minute: "2-digit", hour12: false }),
    source: e.source,
    message: e.message,
    path: e.path,
  }));

  const uptimeSec = Math.floor((now - BOOT_TS) / 1000);
  const uptime =
    uptimeSec < 3600
      ? `${Math.floor(uptimeSec / 60)}m ${uptimeSec % 60}s`
      : `${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m`;

  const mem = process.memoryUsage();

  return {
    activeSessions,
    peakActive: Math.max(peakActive, activeSessions),
    uniqueSessions24h,
    uniqueDevices24h,
    totalEvents24h: last24.length,
    totalEvents7d: events.length,
    byKind,
    hourly,
    daily,
    funnel,
    avgStops,
    avgKm,
    feed,
    recentErrors,
    server: { ...serverCounters },
    health: {
      uptime,
      memoryMb: Math.round(mem.rss / 1024 / 1024),
      node: process.version,
      host: os.hostname(),
      ...extra,
    },
    generatedAt: fmtTime(now),
  };
}

let pruneTimer: ReturnType<typeof setInterval> | null = null;
export function startPruneLoop() {
  if (pruneTimer) return;
  pruneTimer = setInterval(() => {
    prune();
    persist().catch(() => {});
  }, 60_000);
}
