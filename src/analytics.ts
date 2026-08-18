/**
 * Self-hosted, privacy-first analytics.
 * No cookies. No PII. No third parties.
 * Rolling 24-hour in-memory store — resets on deploy (fine for a lightweight dashboard).
 */

const WINDOW_MS = 24 * 60 * 60 * 1000; // 24 h
const ACTIVE_MS =  5 * 60 * 1000;       // session considered "active" if pinged in last 5 min

export type EventKind =
  | "session"   // app opened / heartbeat
  | "route"     // route calculated
  | "optimise"  // optimise called
  | "navigate"  // Start navigation tapped
  | "share"     // share tapped
  | "paste"     // paste addresses used
  | "error";    // client or server error

interface Event {
  ts:      number;
  kind:    EventKind;
  sid:     string;   // anonymous session id (random, not tied to user)
  did:     string;   // anonymous device fingerprint hash (not reversible)
  meta?:   Record<string, unknown>;
}

interface ErrorEvent {
  ts:      number;
  source:  "client" | "server";
  message: string;
  path?:   string;
}

// Rolling stores
const events: Event[]      = [];
const errors: ErrorEvent[] = [];

// Active sessions: sid → last seen timestamp
const sessions = new Map<string, number>();

// Server-side request counters (since boot)
export const serverCounters = {
  requests:  0,
  suggests:  0,
  geocodes:  0,
  routes:    0,
  optimises: 0,
  errors:    0,
};

/* ── housekeeping ───────────────────────────────── */
function prune() {
  const cutoff = Date.now() - WINDOW_MS;
  while (events.length && events[0].ts < cutoff) events.shift();
  while (errors.length && errors[0].ts < cutoff) errors.shift();
  for (const [sid, ts] of sessions) {
    if (ts < cutoff) sessions.delete(sid);
  }
}

let pruneTimer: ReturnType<typeof setInterval> | null = null;
export function startPruneLoop() {
  if (pruneTimer) return;
  pruneTimer = setInterval(prune, 60_000);
}

/* ── record ─────────────────────────────────────── */
export function record(kind: EventKind, sid: string, did: string, meta?: Record<string, unknown>) {
  const ts = Date.now();
  events.push({ ts, kind, sid, did, meta });
  sessions.set(sid, ts);
  if (events.length > 50_000) events.splice(0, 1000); // safety cap
}

export function recordError(source: "client" | "server", message: string, path?: string) {
  errors.push({ ts: Date.now(), source, message: String(message).slice(0, 500), path });
  serverCounters.errors++;
  if (errors.length > 2000) errors.splice(0, 200);
}

/* ── stats ──────────────────────────────────────── */
export function getStats() {
  prune();
  const now = Date.now();

  // Active sessions (pinged in last 5 min)
  let activeSessions = 0;
  for (const ts of sessions.values()) {
    if (now - ts <= ACTIVE_MS) activeSessions++;
  }

  // Unique devices in last 24h
  const uniqueDevices24h = new Set(events.map(e => e.did)).size;

  // Unique sessions in last 24h
  const uniqueSessions24h = new Set(events.map(e => e.sid)).size;

  // Event counts by kind
  const byKind: Record<string, number> = {};
  for (const e of events) {
    byKind[e.kind] = (byKind[e.kind] || 0) + 1;
  }

  // Hourly activity (last 24h, bucketed by hour)
  const hourly: { hour: string; sessions: number; routes: number }[] = [];
  for (let h = 23; h >= 0; h--) {
    const hStart = now - (h + 1) * 3600_000;
    const hEnd   = now - h * 3600_000;
    const slice  = events.filter(e => e.ts >= hStart && e.ts < hEnd);
    const label  = new Date(hStart).toLocaleTimeString("en-AU", {
      hour: "2-digit", minute: "2-digit", timeZone: "Australia/Sydney",
    });
    hourly.push({
      hour:     label,
      sessions: new Set(slice.map(e => e.sid)).size,
      routes:   slice.filter(e => e.kind === "route" || e.kind === "optimise").length,
    });
  }

  // Recent errors (last 50)
  const recentErrors = errors.slice(-50).reverse().map(e => ({
    time:    new Date(e.ts).toLocaleTimeString("en-AU", { timeZone: "Australia/Sydney" }),
    source:  e.source,
    message: e.message,
    path:    e.path,
  }));

  // Uptime
  const uptimeSec = Math.floor((now - BOOT_TS) / 1000);
  const uptimeFmt = uptimeSec < 3600
    ? `${Math.floor(uptimeSec / 60)}m ${uptimeSec % 60}s`
    : `${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m`;

  return {
    activeSessions,
    uniqueSessions24h,
    uniqueDevices24h,
    totalEvents24h: events.length,
    byKind,
    hourly,
    recentErrors,
    server: { ...serverCounters },
    uptime: uptimeFmt,
    generatedAt: new Date().toLocaleString("en-AU", { timeZone: "Australia/Sydney" }),
  };
}

const BOOT_TS = Date.now();
