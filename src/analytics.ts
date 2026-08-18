/**
 * Self-hosted analytics. Privacy-first: no cookies, no PII.
 * Unique users (device ids) and counters live on disk so a restart
 * does not wipe history. Event detail rolls for 30 days.
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const EVENT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const ACTIVE_MS = 5 * 60 * 1000;
const TZ = "Australia/Sydney";
const MAX_EVENTS = 25_000;
const MAX_ERRORS = 2_000;
const MAX_DEVICES = 20_000;

export type EventKind =
  | "session"
  | "route"
  | "optimise"
  | "navigate"
  | "share"
  | "paste"
  | "new_trip"
  | "open_trip"
  | "delete"
  | "reverse"
  | "error";

export type RangeKey = "24h" | "7d" | "30d" | "all";

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

interface Device {
  did: string;
  firstSeen: number;
  lastSeen: number;
  sessions: number;
  routes: number;
  navigates: number;
  events: number;
  platform?: string;
  standalone?: boolean;
  tz?: string;
  lang?: string;
}

interface Lifetime {
  uniqueUsers: number;
  sessions: number;
  routes: number;
  optimise: number;
  navigate: number;
  share: number;
  paste: number;
  new_trip: number;
  open_trip: number;
  delete: number;
  reverse: number;
  errors: number;
  events: number;
}

const KINDS: EventKind[] = [
  "session", "route", "optimise", "navigate", "share", "paste",
  "new_trip", "open_trip", "delete", "reverse", "error",
];

function emptyLifetime(): Lifetime {
  return {
    uniqueUsers: 0, sessions: 0, routes: 0, optimise: 0, navigate: 0,
    share: 0, paste: 0, new_trip: 0, open_trip: 0, delete: 0, reverse: 0,
    errors: 0, events: 0,
  };
}

const events: Event[] = [];
const errors: ErrorEvent[] = [];
const sessions = new Map<string, number>();
const devices = new Map<string, Device>();
let peakActive = 0;
let firstBootAt = Date.now();
let lastBootAt = Date.now();
let bootCount = 1;
let loaded = false;
const BOOT_TS = Date.now();
const lifetime: Lifetime = emptyLifetime();

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

function rangeMs(range: RangeKey) {
  if (range === "24h") return 86_400_000;
  if (range === "7d") return 7 * 86_400_000;
  if (range === "30d") return 30 * 86_400_000;
  return Number.POSITIVE_INFINITY;
}

function prune() {
  const cutoff = Date.now() - EVENT_WINDOW_MS;
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

function bumpLifetime(kind: EventKind) {
  lifetime.events++;
  if (kind in lifetime) (lifetime as unknown as Record<string, number>)[kind]++;
}

function touchDevice(did: string, ts: number, kind: EventKind, meta?: Record<string, unknown>) {
  let d = devices.get(did);
  const isNew = !d;
  if (!d) {
    if (devices.size >= MAX_DEVICES) {
      const oldest = [...devices.values()].sort((a, b) => a.lastSeen - b.lastSeen)[0];
      if (oldest) devices.delete(oldest.did);
    }
    d = { did, firstSeen: ts, lastSeen: ts, sessions: 0, routes: 0, navigates: 0, events: 0 };
    devices.set(did, d);
    lifetime.uniqueUsers = devices.size;
  }
  d.lastSeen = Math.max(d.lastSeen, ts);
  d.firstSeen = Math.min(d.firstSeen, ts);
  d.events++;
  if (kind === "session") d.sessions++;
  if (kind === "route") d.routes++;
  if (kind === "navigate") d.navigates++;
  const plat = String(meta?.platform || "");
  if (plat) d.platform = plat.slice(0, 24);
  if (typeof meta?.standalone === "boolean") d.standalone = meta.standalone;
  const tz = String(meta?.tz || "");
  if (tz) d.tz = tz.slice(0, 64);
  const lang = String(meta?.lang || "");
  if (lang) d.lang = lang.slice(0, 16);
  return isNew;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSave() {
  if (!loaded) return;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    persist().catch(() => {});
  }, 1500);
}

async function persist() {
  if (!loaded) return;
  prune();
  const { dir, file } = dataFile();
  await fs.mkdir(dir, { recursive: true });
  const payload = JSON.stringify({
    version: 2,
    savedAt: Date.now(),
    firstBootAt,
    lastBootAt,
    bootCount,
    peakActive,
    lifetime,
    counters: serverCounters,
    devices: [...devices.values()],
    events: events.slice(-MAX_EVENTS),
    errors: errors.slice(-MAX_ERRORS),
    sessions: [...sessions.entries()],
  });
  const tmp = file + ".tmp";
  await fs.writeFile(tmp, payload);
  try {
    await fs.rename(tmp, file);
  } catch {
    await fs.copyFile(tmp, file);
    await fs.unlink(tmp).catch(() => {});
  }
}

export async function flushPersist() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  await persist();
}

export async function loadPersisted() {
  try {
    const raw = JSON.parse(await fs.readFile(dataFile().file, "utf8"));
    if (typeof raw.firstBootAt === "number") firstBootAt = raw.firstBootAt;
    else if (typeof raw.savedAt === "number") firstBootAt = raw.savedAt;
    if (typeof raw.bootCount === "number") bootCount = raw.bootCount + 1;
    lastBootAt = Date.now();
    if (typeof raw.peakActive === "number") peakActive = raw.peakActive;
    if (raw.lifetime && typeof raw.lifetime === "object") {
      Object.assign(lifetime, emptyLifetime(), raw.lifetime);
    }
    if (raw.counters && typeof raw.counters === "object") {
      for (const k of Object.keys(serverCounters) as (keyof typeof serverCounters)[]) {
        const n = Number(raw.counters[k]);
        if (Number.isFinite(n) && n >= 0) serverCounters[k] = n;
      }
    }
    if (Array.isArray(raw.devices)) {
      devices.clear();
      for (const row of raw.devices) {
        if (!row?.did) continue;
        devices.set(String(row.did), {
          did: String(row.did),
          firstSeen: Number(row.firstSeen) || Date.now(),
          lastSeen: Number(row.lastSeen) || Date.now(),
          sessions: Number(row.sessions) || 0,
          routes: Number(row.routes) || 0,
          navigates: Number(row.navigates) || 0,
          events: Number(row.events) || 0,
          platform: row.platform ? String(row.platform) : undefined,
          standalone: typeof row.standalone === "boolean" ? row.standalone : undefined,
          tz: row.tz ? String(row.tz) : undefined,
          lang: row.lang ? String(row.lang) : undefined,
        });
      }
    }
    if (Array.isArray(raw.events)) {
      events.length = 0;
      events.push(...raw.events);
      for (const e of events) {
        sessions.set(e.sid, Math.max(sessions.get(e.sid) || 0, e.ts));
        const existing = devices.get(e.did);
        if (!existing) {
          touchDevice(e.did, e.ts, e.kind, e.meta);
        } else {
          existing.lastSeen = Math.max(existing.lastSeen, e.ts);
          existing.firstSeen = Math.min(existing.firstSeen, e.ts);
        }
      }
    }
    if (Array.isArray(raw.sessions)) {
      for (const pair of raw.sessions) {
        if (Array.isArray(pair) && pair[0]) sessions.set(String(pair[0]), Number(pair[1]) || 0);
      }
    }
    if (Array.isArray(raw.errors)) {
      errors.length = 0;
      errors.push(...raw.errors);
    }
    lifetime.uniqueUsers = devices.size;
    if (!lifetime.events) lifetime.events = events.length;
    prune();
  } catch {
    firstBootAt = Date.now();
    lastBootAt = Date.now();
    bootCount = 1;
  } finally {
    loaded = true;
    persist().catch(() => {});
  }
}

export function record(kind: EventKind, sid: string, did: string, meta?: Record<string, unknown>) {
  const ts = Date.now();
  const safeKind = KINDS.includes(kind) ? kind : "session";
  events.push({ ts, kind: safeKind, sid, did, meta });
  sessions.set(sid, ts);
  touchDevice(did, ts, safeKind, meta);
  bumpLifetime(safeKind);
  activeCount(ts);
  if (events.length > MAX_EVENTS + 2000) events.splice(0, 2000);
  scheduleSave();
}

export function recordError(source: "client" | "server", message: string, path?: string) {
  errors.push({ ts: Date.now(), source, message: String(message).slice(0, 500), path });
  serverCounters.errors++;
  lifetime.errors++;
  if (errors.length > MAX_ERRORS) errors.splice(0, 200);
  scheduleSave();
}

export function clearErrors() {
  errors.length = 0;
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

function relTime(ts: number, now = Date.now()) {
  const d = now - ts;
  if (d < 60_000) return "Just now";
  if (d < 3600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86400_000) return `${Math.floor(d / 3600_000)}h ago`;
  if (d < 7 * 86400_000) return `${Math.floor(d / 86400_000)}d ago`;
  return new Date(ts).toLocaleDateString("en-AU", { day: "numeric", month: "short", timeZone: TZ });
}

function inRange(ts: number, since: number) {
  return ts >= since;
}

export function getStats(extra: Record<string, unknown> = {}, range: RangeKey = "24h") {
  prune();
  const now = Date.now();
  const ms = rangeMs(range);
  const since = Number.isFinite(ms) ? now - ms : 0;
  const slice = events.filter((e) => inRange(e.ts, since));
  const last24 = events.filter((e) => e.ts >= now - 86_400_000);

  const activeSessions = activeCount(now);
  const uniqueDevices24h = new Set(last24.map((e) => e.did)).size;
  const uniqueSessions24h = new Set(last24.map((e) => e.sid)).size;

  const usersInRange = [...devices.values()].filter((d) => d.lastSeen >= since);
  const newInRange = usersInRange.filter((d) => d.firstSeen >= since);
  const returning = usersInRange.length - newInRange.length;

  const uniqueSessions = new Set(slice.map((e) => e.sid)).size;
  const uniqueUsers = range === "all" ? devices.size : new Set(slice.map((e) => e.did)).size;

  const byKind: Record<string, number> = {};
  for (const e of slice) byKind[e.kind] = (byKind[e.kind] || 0) + 1;

  const hourly: { hour: string; sessions: number; routes: number; navigates: number; users: number }[] = [];
  for (let h = 23; h >= 0; h--) {
    const hStart = now - (h + 1) * 3_600_000;
    const hEnd = now - h * 3_600_000;
    const hourSlice = last24.filter((e) => e.ts >= hStart && e.ts < hEnd);
    hourly.push({
      hour: hourLabel(hStart),
      sessions: new Set(hourSlice.map((e) => e.sid)).size,
      routes: hourSlice.filter((e) => e.kind === "route" || e.kind === "optimise").length,
      navigates: hourSlice.filter((e) => e.kind === "navigate").length,
      users: new Set(hourSlice.map((e) => e.did)).size,
    });
  }

  const daily: { day: string; sessions: number; routes: number; devices: number; nav: number }[] = [];
  for (let d = 6; d >= 0; d--) {
    const start = now - (d + 1) * 86_400_000;
    const end = now - d * 86_400_000;
    const daySlice = events.filter((e) => e.ts >= start && e.ts < end);
    daily.push({
      day: new Date(end - 1).toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short", timeZone: TZ }),
      sessions: new Set(daySlice.map((e) => e.sid)).size,
      routes: daySlice.filter((e) => e.kind === "route" || e.kind === "optimise").length,
      devices: new Set(daySlice.map((e) => e.did)).size,
      nav: daySlice.filter((e) => e.kind === "navigate").length,
    });
  }

  const daily30: { day: string; sessions: number; routes: number; devices: number }[] = [];
  for (let d = 29; d >= 0; d--) {
    const start = now - (d + 1) * 86_400_000;
    const end = now - d * 86_400_000;
    const daySlice = events.filter((e) => e.ts >= start && e.ts < end);
    daily30.push({
      day: new Date(end - 1).toLocaleDateString("en-AU", { day: "numeric", month: "short", timeZone: TZ }),
      sessions: new Set(daySlice.map((e) => e.sid)).size,
      routes: daySlice.filter((e) => e.kind === "route" || e.kind === "optimise").length,
      devices: new Set(daySlice.map((e) => e.did)).size,
    });
  }

  const routes = slice.filter((e) => e.kind === "route");
  const avgStops = routes.length
    ? Math.round((routes.reduce((n, e) => n + Number(e.meta?.stops || 0), 0) / routes.length) * 10) / 10
    : 0;
  const avgKm = routes.length
    ? Math.round(routes.reduce((n, e) => n + Number(e.meta?.km || 0), 0) / routes.length)
    : 0;
  const totalKm = routes.reduce((n, e) => n + Number(e.meta?.km || 0), 0);

  const stopBuckets = { "2": 0, "3": 0, "4–6": 0, "7–10": 0, "11+": 0 };
  for (const e of routes) {
    const n = Number(e.meta?.stops || 0);
    if (n <= 2) stopBuckets["2"]++;
    else if (n === 3) stopBuckets["3"]++;
    else if (n <= 6) stopBuckets["4–6"]++;
    else if (n <= 10) stopBuckets["7–10"]++;
    else stopBuckets["11+"]++;
  }

  const funnel = {
    sessions: uniqueSessions,
    routes: byKind.route || 0,
    optimise: byKind.optimise || 0,
    navigate: byKind.navigate || 0,
    share: byKind.share || 0,
    paste: byKind.paste || 0,
    new_trip: byKind.new_trip || 0,
    open_trip: byKind.open_trip || 0,
    delete: byKind.delete || 0,
    reverse: byKind.reverse || 0,
    routeRate: uniqueSessions ? Math.round(((byKind.route || 0) / uniqueSessions) * 100) : 0,
    navRate: uniqueSessions ? Math.round(((byKind.navigate || 0) / uniqueSessions) * 100) : 0,
    optRate: uniqueSessions ? Math.round(((byKind.optimise || 0) / uniqueSessions) * 100) : 0,
  };

  const platforms: Record<string, number> = {};
  for (const d of usersInRange) {
    const p = d.platform || "Unknown";
    platforms[p] = (platforms[p] || 0) + 1;
  }
  const pwaUsers = usersInRange.filter((d) => d.standalone).length;

  const userList = [...devices.values()]
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .slice(0, 50)
    .map((d) => ({
      id: d.did.slice(-6).toUpperCase(),
      lastSeen: relTime(d.lastSeen, now),
      lastTs: d.lastSeen,
      firstSeen: relTime(d.firstSeen, now),
      new: d.firstSeen >= since,
      platform: d.platform || "Unknown",
      standalone: !!d.standalone,
      sessions: d.sessions,
      routes: d.routes,
      navigates: d.navigates,
      tz: d.tz || "",
      lang: d.lang || "",
    }));

  const feed = [...slice].slice(-60).reverse().map((e) => ({
    time: fmtTime(e.ts, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }),
    kind: e.kind,
    user: e.did.slice(-6).toUpperCase(),
    detail:
      e.kind === "route" && e.meta
        ? `${e.meta.stops || "?"} stops · ${e.meta.km || "?"} km`
        : e.kind === "optimise" && e.meta
          ? `${e.meta.stops || "?"} stops`
          : e.kind === "paste" && e.meta
            ? `${e.meta.lines || "?"} lines`
            : e.kind === "navigate" && e.meta
              ? `${e.meta.stops || "?"} stops`
              : e.meta?.platform
                ? String(e.meta.platform)
                : "",
  }));

  const recentErrors = errors.slice(-80).reverse().map((e) => ({
    time: fmtTime(e.ts, { hour: "2-digit", minute: "2-digit", hour12: false }),
    day: fmtTime(e.ts, { weekday: "short", day: "numeric", month: "short" }),
    source: e.source,
    message: e.message,
    path: e.path,
  }));
  const errors24h = errors.filter((e) => e.ts >= now - 86_400_000).length;
  const errorsInRange = errors.filter((e) => e.ts >= since).length;

  const uptimeSec = Math.floor((now - BOOT_TS) / 1000);
  const uptime =
    uptimeSec < 3600
      ? `${Math.floor(uptimeSec / 60)}m ${uptimeSec % 60}s`
      : uptimeSec < 86400
        ? `${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m`
        : `${Math.floor(uptimeSec / 86400)}d ${Math.floor((uptimeSec % 86400) / 3600)}h`;

  const mem = process.memoryUsage();
  const load = os.loadavg?.() || [0, 0, 0];

  return {
    range,
    activeSessions,
    peakActive: Math.max(peakActive, activeSessions),
    uniqueSessions24h,
    uniqueDevices24h,
    uniqueUsers24h: uniqueDevices24h,
    uniqueUsersAllTime: devices.size,
    uniqueUsers,
    uniqueSessions,
    newUsers: newInRange.length,
    returningUsers: Math.max(0, returning),
    pwaUsers,
    totalEvents24h: last24.length,
    totalEvents7d: events.filter((e) => e.ts >= now - 7 * 86_400_000).length,
    totalEventsRange: slice.length,
    totalEventsStored: events.length,
    byKind,
    hourly,
    daily,
    daily30,
    funnel,
    avgStops,
    avgKm,
    totalKm: Math.round(totalKm),
    stopBuckets,
    platforms,
    users: userList,
    feed,
    recentErrors,
    errors24h,
    errorsInRange,
    lifetime: { ...lifetime, uniqueUsers: devices.size },
    server: { ...serverCounters },
    persisted: true,
    savedAt: fmtTime(now),
    dataSince: fmtTime(firstBootAt, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }),
    health: {
      uptime,
      uptimeSec,
      memoryMb: Math.round(mem.rss / 1024 / 1024),
      heapMb: Math.round(mem.heapUsed / 1024 / 1024),
      node: process.version,
      host: os.hostname(),
      platform: `${os.type()} ${os.release()}`,
      cpus: os.cpus()?.length || 0,
      load: load[0] ? load[0].toFixed(2) : "0",
      bootCount,
      firstBootAt: fmtTime(firstBootAt, { day: "numeric", month: "short", year: "numeric" }),
      lastBootAt: fmtTime(lastBootAt, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }),
      devicesStored: devices.size,
      eventsStored: events.length,
      errorsStored: errors.length,
      ...extra,
    },
    generatedAt: fmtTime(now),
  };
}

export function exportPayload() {
  prune();
  return {
    version: 2,
    exportedAt: Date.now(),
    firstBootAt,
    bootCount,
    peakActive,
    lifetime: { ...lifetime, uniqueUsers: devices.size },
    counters: { ...serverCounters },
    devices: [...devices.values()],
    events: events.slice(),
    errors: errors.slice(),
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
