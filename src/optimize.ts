import { googleDurationMatrix } from "./google.ts";

export type LatLng = { lat: number; lng: number };

const BIG = 1e12;

function haversineM(a: LatLng, b: LatLng) {
  const R = 6371000;
  const p1 = (a.lat * Math.PI) / 180;
  const p2 = (b.lat * Math.PI) / 180;
  const dp = ((b.lat - a.lat) * Math.PI) / 180;
  const dl = ((b.lng - a.lng) * Math.PI) / 180;
  const s = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

function haversineMatrix(pts: LatLng[]): number[][] {
  const n = pts.length;
  const m = Array.from({ length: n }, () => Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      // ~45 km/h driving estimate — only used if live tables fail
      m[i][j] = haversineM(pts[i], pts[j]) / 12.5;
    }
  }
  return m;
}

async function osrmTable(pts: LatLng[]): Promise<number[][] | null> {
  const coords = pts.map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(";");
  const url = `https://router.project-osrm.org/table/v1/driving/${coords}?annotations=duration`;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 12000);
  try {
    const res = await fetch(url, { signal: ac.signal, headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    const data = (await res.json()) as { durations?: Array<Array<number | null>> };
    if (!Array.isArray(data.durations) || data.durations.length !== pts.length) return null;
    return data.durations.map((row) =>
      (row || []).map((v) => (v == null || !Number.isFinite(v) || v < 0 ? BIG : v)),
    );
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function durationMatrix(pts: LatLng[], avoid?: { avoidTolls?: boolean; avoidFerries?: boolean }) {
  try {
    const g = await googleDurationMatrix(pts, avoid);
    if (g) return g;
  } catch {
    /* fall through */
  }
  const table = await osrmTable(pts);
  if (table) return table;
  return haversineMatrix(pts);
}

function tourCost(order: number[], cost: number[][], roundtrip: boolean) {
  let s = 0;
  for (let i = 0; i < order.length - 1; i++) s += cost[order[i]][order[i + 1]];
  if (roundtrip) s += cost[order[order.length - 1]][order[0]];
  return s;
}

function permute(arr: number[]): number[][] {
  if (arr.length <= 1) return [arr.slice()];
  const out: number[][] = [];
  for (let i = 0; i < arr.length; i++) {
    const rest = arr.slice(0, i).concat(arr.slice(i + 1));
    for (const p of permute(rest)) out.push([arr[i], ...p]);
  }
  return out;
}

function bruteOrder(n: number, cost: number[][], lockEnd: boolean, roundtrip: boolean) {
  const last = lockEnd && n > 1 ? n - 1 : -1;
  const mid = [];
  for (let i = 1; i < n; i++) if (i !== last) mid.push(i);
  let best: number[] = [0, ...mid, ...(last >= 0 ? [last] : [])];
  let bestC = tourCost(best, cost, roundtrip);
  for (const p of permute(mid)) {
    const order = last >= 0 ? [0, ...p, last] : [0, ...p];
    const c = tourCost(order, cost, roundtrip);
    if (c < bestC) {
      best = order;
      bestC = c;
    }
  }
  return best;
}

function nearestNeighbor(n: number, cost: number[][], lockEnd: boolean) {
  const last = lockEnd && n > 1 ? n - 1 : -1;
  const used = new Set<number>([0]);
  if (last >= 0) used.add(last);
  const order = [0];
  const target = n - (last >= 0 ? 1 : 0);
  while (order.length < target) {
    const cur = order[order.length - 1];
    let best = -1;
    let bestC = Infinity;
    for (let i = 0; i < n; i++) {
      if (used.has(i)) continue;
      if (cost[cur][i] < bestC) {
        bestC = cost[cur][i];
        best = i;
      }
    }
    if (best < 0) break;
    used.add(best);
    order.push(best);
  }
  if (last >= 0) order.push(last);
  return order;
}

function twoOpt(order: number[], cost: number[][], roundtrip: boolean, lockEnd: boolean) {
  const hi = lockEnd ? order.length - 2 : order.length - 1;
  let best = order.slice();
  let bestC = tourCost(best, cost, roundtrip);
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 1; i < hi; i++) {
      for (let k = i + 1; k <= hi; k++) {
        const next = best.slice(0, i).concat(best.slice(i, k + 1).reverse(), best.slice(k + 1));
        const c = tourCost(next, cost, roundtrip);
        if (c + 0.5 < bestC) {
          best = next;
          bestC = c;
          improved = true;
        }
      }
    }
  }
  return best;
}

/**
 * Shortest visiting order. Index 0 (Your location / start) always stays first.
 * If lockEnd, the last stop stays last. Everything in between is free to move.
 */
export async function bestStopOrder(
  pts: LatLng[],
  opts: { roundtrip?: boolean; keepEnds?: boolean; avoidTolls?: boolean; avoidFerries?: boolean },
): Promise<number[]> {
  const n = pts.length;
  if (n <= 2) return pts.map((_, i) => i);

  const lockEnd = !!opts.keepEnds && !opts.roundtrip;
  const cost = await durationMatrix(pts, opts);
  const movable = n - 1 - (lockEnd ? 1 : 0);

  let order =
    movable <= 8
      ? bruteOrder(n, cost, lockEnd, !!opts.roundtrip)
      : nearestNeighbor(n, cost, lockEnd);
  order = twoOpt(order, cost, !!opts.roundtrip, lockEnd);

  if (order.length !== n || new Set(order).size !== n) {
    return pts.map((_, i) => i);
  }
  return order;
}
