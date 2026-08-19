const UA = "TripPlanner/1.0 (https://github.com/ac3designs1/maps)";

export type SuggestHit = {
  label: string;
  lat: number | null;
  lng: number | null;
  kind?: string;
  name?: string;
  sub?: string;
  placeId?: string;
  distanceM?: number;
  searchQuery?: string;
};

export function queryTokens(q: string) {
  if (/^\d/.test(String(q).trim())) return [];
  return String(q)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 4);
}

export function hitCoversQuery(h: SuggestHit, tokens: string[]) {
  if (!tokens.length) return true;
  const hay = `${h.name || ""} ${h.sub || ""} ${h.label || ""} ${h.searchQuery || ""}`.toLowerCase();
  return tokens.every((t) => hay.includes(t));
}

export function tidyAddr(addr: string, name?: string) {
  let s = String(addr || "")
    .replace(/\s+/g, " ")
    .replace(/,?\s*Australia\s*$/i, "")
    .trim();
  const n = String(name || "").trim();
  if (n) {
    const low = s.toLowerCase();
    const nl = n.toLowerCase();
    if (low === nl) return "";
    if (low.startsWith(nl)) s = s.slice(n.length).replace(/^[\s,]+/, "");
  }
  return s;
}

export function placeLabel(name: string, addr: string) {
  const n = String(name || "").trim();
  const sub = tidyAddr(addr, n);
  return [n, sub].filter(Boolean).join(", ") || String(addr || "").trim() || n;
}

const AU = {
  minLng: 112.5,
  maxLng: 154.1,
  minLat: -44.1,
  maxLat: -9.5,
  biasLat: -33.8688,
  biasLng: 151.2093,
};

const BIZ_KEYS = new Set([
  "shop",
  "amenity",
  "office",
  "tourism",
  "craft",
  "leisure",
  "healthcare",
  "club",
  "brand",
  "aeroway",
]);

function inAustralia(lat: number, lng: number) {
  return lat >= AU.minLat && lat <= AU.maxLat && lng >= AU.minLng && lng <= AU.maxLng;
}

function biasPoint(lat?: number, lon?: number) {
  if (Number.isFinite(lat) && Number.isFinite(lon) && inAustralia(lat as number, lon as number)) {
    return { lat: lat as number, lon: lon as number };
  }
  return { lat: AU.biasLat, lon: AU.biasLng };
}

function isAusCountry(props: Record<string, unknown>) {
  const c = `${props.country || ""} ${props.countrycode || ""}`.toLowerCase();
  if (!c.trim()) return true;
  return /\baustralia\b|\bau\b|\baus\b/.test(c);
}

function uniqLabel(parts: unknown[]) {
  return [...new Set(parts.map((x) => String(x || "").trim()).filter(Boolean))].join(", ");
}

function fmtPhoton(props: Record<string, unknown>, fallback: string) {
  const key = String(props.osm_key || "");
  const biz = BIZ_KEYS.has(key);
  const street = [props.housenumber, props.street].filter(Boolean).join(" ");
  const name = String(props.name || "");
  const suburb = props.city || props.town || props.village || props.suburb || props.locality;
  if (biz && name) {
    return uniqLabel([name, street, suburb, props.state, props.postcode]) || fallback;
  }
  return (
    uniqLabel([
      street || name,
      street && name && name !== street ? name : "",
      suburb,
      props.state,
      props.postcode,
    ]) || fallback
  );
}

function fmtNominatim(item: {
  display_name?: string;
  address?: Record<string, string>;
  name?: string;
  class?: string;
  type?: string;
}) {
  const a = item.address || {};
  const street = [a.house_number, a.road].filter(Boolean).join(" ");
  const suburb = a.suburb || a.neighbourhood || a.hamlet;
  const city = a.city || a.town || a.village || a.municipality;
  const biz = item.name || a.shop || a.amenity || a.office || a.tourism;
  if (biz && (BIZ_KEYS.has(item.class || "") || biz !== street)) {
    return uniqLabel([biz, street, suburb, city, a.state, a.postcode]) || item.display_name || "";
  }
  return uniqLabel([street || biz, suburb, city, a.state, a.postcode]) || item.display_name || "";
}

async function getJson(url: string, ms = 10000, tries = 2) {
  let last = new Error("Network error");
  for (let i = 0; i < tries; i++) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), ms);
    try {
      const res = await fetch(url, {
        signal: ac.signal,
        headers: { Accept: "application/json", "User-Agent": UA },
      });
      if (res.status === 429 || res.status >= 500) {
        last = new Error("Maps is busy. Try again.");
        await new Promise((r) => setTimeout(r, 350 * (i + 1)));
        continue;
      }
      if (!res.ok) throw new Error("Couldn't load that place");
      return await res.json();
    } catch (err) {
      last = err instanceof Error ? err : new Error(String(err));
      if (i + 1 < tries) await new Promise((r) => setTimeout(r, 250));
    } finally {
      clearTimeout(t);
    }
  }
  throw last;
}

function dedupe(hits: SuggestHit[]) {
  return dedupeSuggestHits(hits);
}

function normText(s: string) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function distM(a: SuggestHit, b: SuggestHit) {
  if (!Number.isFinite(a.lat) || !Number.isFinite(a.lng) || !Number.isFinite(b.lat) || !Number.isFinite(b.lng)) {
    return Infinity;
  }
  const dlat = ((a.lat as number) - (b.lat as number)) * 111000;
  const dlng = ((a.lng as number) - (b.lng as number)) * 111000 * Math.cos(((a.lat as number) * Math.PI) / 180);
  return Math.sqrt(dlat * dlat + dlng * dlng);
}

export function isSamePlace(a: SuggestHit, b: SuggestHit) {
  if (a.placeId && b.placeId && a.placeId === b.placeId) return true;
  const labelA = normText(a.label);
  const labelB = normText(b.label);
  const nameA = normText(a.name || a.label.split(",")[0]);
  const nameB = normText(b.name || b.label.split(",")[0]);
  const dm = distM(a, b);
  if (!Number.isFinite(a.lat) || !Number.isFinite(b.lat)) {
    return !!(labelA && labelA === labelB) || !!(nameA && nameA === nameB);
  }
  if (dm < 35) return true;
  if (labelA && labelA === labelB) return true;
  if (dm < 80 && nameA && nameA === nameB) return true;
  return false;
}

export function dedupeSuggestHits(hits: SuggestHit[]) {
  const out: SuggestHit[] = [];
  for (const h of hits) {
    const i = out.findIndex((prev) => isSamePlace(prev, h));
    if (i < 0) {
      out.push(h);
      continue;
    }
    const prev = out[i];
    if (!Number.isFinite(prev.lat) && Number.isFinite(h.lat)) {
      out[i] = {
        ...prev,
        lat: h.lat,
        lng: h.lng,
        label: prev.label || h.label,
        name: prev.name || h.name,
        sub: prev.sub || h.sub,
        kind: prev.kind || h.kind,
        placeId: prev.placeId || h.placeId,
        distanceM: prev.distanceM ?? h.distanceM,
      };
    }
  }
  return out;
}

async function photonSuggest(q: string, lat?: number, lon?: number): Promise<SuggestHit[]> {
  const bias = biasPoint(lat, lon);
  const u = new URL("https://photon.komoot.io/api/");
  u.searchParams.set("q", q);
  u.searchParams.set("limit", "12");
  u.searchParams.set("lang", "en");
  u.searchParams.set("location_bias_scale", "0.2");
  u.searchParams.set("lat", String(bias.lat));
  u.searchParams.set("lon", String(bias.lon));
  u.searchParams.set("bbox", `${AU.minLng},${AU.minLat},${AU.maxLng},${AU.maxLat}`);
  const data = (await getJson(u.toString())) as {
    features?: Array<{
      geometry?: { coordinates?: number[] };
      properties?: Record<string, unknown>;
    }>;
  };
  const out: SuggestHit[] = [];
  for (const f of data.features || []) {
    const [lng, latN] = f.geometry?.coordinates || [];
    if (!Number.isFinite(latN) || !Number.isFinite(lng) || !inAustralia(latN, lng)) continue;
    const props = f.properties || {};
    if (!isAusCountry(props)) continue;
    const key = String(props.osm_key || "");
    const name = String(props.name || "");
    const label = fmtPhoton(props, q);
    out.push({
      label,
      lat: latN,
      lng,
      kind: BIZ_KEYS.has(key) ? "business" : "address",
      name: name || label.split(",")[0],
      sub: tidyAddr(label, name),
    });
  }
  return out;
}

async function nominatimSuggest(q: string, lat?: number, lon?: number): Promise<SuggestHit[]> {
  const bias = biasPoint(lat, lon);
  const u = new URL("https://nominatim.openstreetmap.org/search");
  u.searchParams.set("q", q);
  u.searchParams.set("format", "jsonv2");
  u.searchParams.set("addressdetails", "1");
  u.searchParams.set("countrycodes", "au");
  u.searchParams.set("limit", "8");
  u.searchParams.set("dedupe", "1");
  u.searchParams.set("viewbox", `${AU.minLng},${AU.maxLat},${AU.maxLng},${AU.minLat}`);
  u.searchParams.set("bounded", "0");
  u.searchParams.set("lat", String(bias.lat));
  u.searchParams.set("lon", String(bias.lon));
  const data = (await getJson(u.toString(), 9000)) as Array<{
    lat?: string;
    lon?: string;
    display_name?: string;
    name?: string;
    class?: string;
    type?: string;
    address?: Record<string, string>;
  }>;
  const out: SuggestHit[] = [];
  for (const item of data || []) {
    const latN = Number(item.lat);
    const lng = Number(item.lon);
    if (!Number.isFinite(latN) || !Number.isFinite(lng) || !inAustralia(latN, lng)) continue;
    const cc = `${item.address?.country || ""} ${item.address?.country_code || ""}`.toLowerCase();
    if (cc && !/\baustralia\b|\bau\b/.test(cc)) continue;
    const biz = BIZ_KEYS.has(item.class || "");
    const name = item.name || "";
    const label = fmtNominatim(item) || q;
    out.push({
      label,
      lat: latN,
      lng,
      kind: biz ? "business" : "address",
      name: name || label.split(",")[0],
      sub: tidyAddr(label, name),
    });
  }
  return out;
}

function rankHits(query: string, hits: SuggestHit[], lat?: number, lon?: number) {
  const q = query.toLowerCase();
  const looksStreet = /^\d+\s/.test(query.trim());
  const tokens = queryTokens(query);
  const bias = biasPoint(lat, lon);
  const scored = hits.map((h, i) => {
    const name = (h.name || h.label).toLowerCase();
    let score = 0;
    if (h.searchQuery) score += 90;
    if (name === q) score += 120;
    else if (name.startsWith(q)) score += 80;
    else if (name.includes(q)) score += 40;
    else if (h.label.toLowerCase().includes(q)) score += 18;
    if (tokens.length) {
      if (hitCoversQuery(h, tokens)) score += 55;
      else score -= 90;
    }
    if (h.kind === "business" && !looksStreet) score += 22;
    if (h.kind === "address" && looksStreet) score += 28;
    if (h.placeId) score += 6;
    score -= i * 0.4;
    if (Number.isFinite(h.distanceM)) score -= Math.min((h.distanceM as number) / 2500, 18);
    if (Number.isFinite(h.lat) && Number.isFinite(h.lng)) {
      const dlat = (h.lat as number) - bias.lat;
      const dlng = (h.lng as number) - bias.lon;
      score -= Math.sqrt(dlat * dlat + dlng * dlng) * (looksStreet ? 8 : 2.5);
    }
    return { h, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.h);
}

export async function suggest(q: string, lat?: number, lon?: number): Promise<SuggestHit[]> {
  const query = q.trim();
  if (query.length < 2) return [];

  const { googleSuggest, hasGoogleKey } = await import("./google.ts");
  if (hasGoogleKey()) {
    try {
      const google = await googleSuggest(query, lat, lon);
      if (google.length) {
        const ranked = rankHits(query, google, lat, lon);
        const tokens = queryTokens(query);
        if (tokens.length >= 2) {
          const tight = ranked.filter((h) => h.searchQuery || hitCoversQuery(h, tokens));
          if (tight.length) return tight.slice(0, 10);
        }
        return ranked.slice(0, 10);
      }
    } catch (err) {
      console.warn("Google suggest fallback:", err instanceof Error ? err.message : err);
    }
  }

  const [photon, nomi] = await Promise.allSettled([
    photonSuggest(query, lat, lon),
    nominatimSuggest(query, lat, lon),
  ]);
  const merged = [
    ...(photon.status === "fulfilled" ? photon.value : []),
    ...(nomi.status === "fulfilled" ? nomi.value : []),
  ].filter((h) => Number.isFinite(h.lat) && Number.isFinite(h.lng) && inAustralia(h.lat as number, h.lng as number));
  const tokens = queryTokens(query);
  const ranked = rankHits(query, dedupe(merged), lat, lon);
  if (tokens.length >= 2) return ranked.filter((h) => hitCoversQuery(h, tokens)).slice(0, 8);
  return ranked.slice(0, 8);
}

export async function geocode(q: string, lat?: number, lon?: number): Promise<SuggestHit | null> {
  const query = q.trim();
  if (query.length < 2) return null;

  const { googleGeocode, hasGoogleKey } = await import("./google.ts");
  const tokens = queryTokens(query);
  const usable = (h: SuggestHit | null) =>
    !!(h && !h.searchQuery && (h.placeId || Number.isFinite(h.lat as number)) && (tokens.length < 2 || hitCoversQuery(h, tokens)));

  if (hasGoogleKey()) {
    try {
      const hit = await googleGeocode(query, lat, lon);
      if (usable(hit)) return hit;
    } catch (err) {
      console.warn("Google geocode fallback:", err instanceof Error ? err.message : err);
    }
  }

  try {
    const photon = (await photonSuggest(query, lat, lon)).filter(
      (h) => Number.isFinite(h.lat) && Number.isFinite(h.lng) && inAustralia(h.lat as number, h.lng as number),
    );
    const best = rankHits(query, photon, lat, lon).find((h) => usable(h));
    if (best) return best;
  } catch {
    /* fall through */
  }
  try {
    const nomi = (await nominatimSuggest(query, lat, lon)).filter(
      (h) => Number.isFinite(h.lat) && Number.isFinite(h.lng) && inAustralia(h.lat as number, h.lng as number),
    );
    return rankHits(query, nomi, lat, lon).find((h) => usable(h)) || null;
  } catch {
    return null;
  }
}

export async function reverse(lat: number, lon: number): Promise<SuggestHit | null> {
  const { googleReverse, hasGoogleKey } = await import("./google.ts");
  if (hasGoogleKey()) {
    try {
      const hit = await googleReverse(lat, lon);
      if (hit) return hit;
    } catch (err) {
      console.warn("Google reverse fallback:", err instanceof Error ? err.message : err);
    }
  }

  const u = new URL("https://nominatim.openstreetmap.org/reverse");
  u.searchParams.set("lat", String(lat));
  u.searchParams.set("lon", String(lon));
  u.searchParams.set("format", "jsonv2");
  u.searchParams.set("addressdetails", "1");
  u.searchParams.set("zoom", "18");
  const data = (await getJson(u.toString(), 8000)) as {
    display_name?: string;
    name?: string;
    lat?: string;
    lon?: string;
    address?: Record<string, string>;
  };
  const la = Number(data.lat);
  const ln = Number(data.lon);
  if (!Number.isFinite(la) || !Number.isFinite(ln)) return { label: "Your location", lat, lng: lon, kind: "gps" };
  return { label: fmtNominatim(data) || "Your location", lat: la, lng: ln, kind: "gps" };
}

type LngLat = { lat: number; lng: number };

function coordStr(pts: LngLat[]) {
  return pts.map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(";");
}

export type RouteResult = {
  distanceM: number;
  durationS: number;
  durationStaticS?: number;
  trafficDelayS?: number;
  traffic?: boolean;
  geometry: [number, number][];
  order?: number[];
  legs: { distanceM: number; durationS: number }[];
  segments?: Array<{ speed: string; geometry: [number, number][] }>;
};

function parseRoute(json: {
  routes?: Array<{
    distance: number;
    duration: number;
    geometry?: { coordinates?: number[][] };
    legs?: Array<{ distance: number; duration: number }>;
  }>;
  trips?: Array<{
    distance: number;
    duration: number;
    geometry?: { coordinates?: number[][] };
    legs?: Array<{ distance: number; duration: number }>;
  }>;
  waypoints?: Array<{ waypoint_index?: number; trips_index?: number }>;
}): RouteResult {
  const r = json.routes?.[0] || json.trips?.[0];
  if (!r) throw new Error("No driving route found");
  const geometry: [number, number][] = (r.geometry?.coordinates || []).map((c) => [c[1], c[0]]);
  let order: number[] | undefined;
  if (json.waypoints?.length) {
    // OSRM trip API: waypoints[inputIdx].waypoint_index = optimised position for input stop inputIdx.
    // Build order[optimisedPos] = inputIdx so the client can reorder its stop array.
    const n = json.waypoints.length;
    const raw: (number | undefined)[] = new Array(n);
    json.waypoints.forEach((w, inputIdx) => {
      const optimisedPos = w.waypoint_index ?? inputIdx;
      if (optimisedPos >= 0 && optimisedPos < n) raw[optimisedPos] = inputIdx;
    });
    if (!raw.some((v) => v == null)) order = raw as number[];
  }
  return {
    distanceM: r.distance || 0,
    durationS: r.duration || 0,
    geometry,
    order,
    legs: (r.legs || []).map((l) => ({ distanceM: l.distance || 0, durationS: l.duration || 0 })),
  };
}

async function routeOnce(pts: LngLat[], extra = "") {
  const url =
    `https://router.project-osrm.org/route/v1/driving/${coordStr(pts)}` +
    `?overview=full&geometries=geojson&alternatives=false${extra}`;
  return parseRoute(await getJson(url, 25000));
}

function excludeQs(opts?: { avoidTolls?: boolean; avoidFerries?: boolean }) {
  const parts: string[] = [];
  if (opts?.avoidTolls) parts.push("toll");
  if (opts?.avoidFerries) parts.push("ferry");
  return parts.length ? `&exclude=${parts.join(",")}` : "";
}

export async function drivingRoute(
  pts: LngLat[],
  opts?: { avoidTolls?: boolean; avoidFerries?: boolean },
): Promise<RouteResult> {
  if (pts.length < 2) throw new Error("Need two stops");
  try {
    const { hasGoogleKey, googleDrivingRoute } = await import("./google.ts");
    if (hasGoogleKey()) {
      const g = await googleDrivingRoute(pts, opts);
      if (g && g.geometry.length > pts.length) return g;
    }
  } catch {
    /* OSRM fallback */
  }
  const extra = excludeQs(opts);
  if (pts.length <= 80) return routeOnce(pts, extra);
  const geometry: [number, number][] = [];
  const legs: { distanceM: number; durationS: number }[] = [];
  let distanceM = 0;
  let durationS = 0;
  for (let i = 0; i < pts.length - 1; i += 70) {
    const slice = pts.slice(i, Math.min(pts.length, i + 71));
    const part = await routeOnce(slice, extra);
    if (geometry.length && part.geometry.length) part.geometry.shift();
    geometry.push(...part.geometry);
    legs.push(...part.legs);
    distanceM += part.distanceM;
    durationS += part.durationS;
  }
  return { distanceM, durationS, geometry, legs };
}

export async function optimizedTrip(
  pts: LngLat[],
  opts: { roundtrip: boolean; lockStart?: boolean; keepEnds?: boolean; avoidTolls?: boolean; avoidFerries?: boolean },
): Promise<RouteResult> {
  if (pts.length < 2) throw new Error("Need two stops");
  if (pts.length > 80) throw new Error("Optimize works up to 80 stops — route still has no cap");

  const { bestStopOrder } = await import("./optimize.ts");
  const order = await bestStopOrder(pts, opts);
  const ordered = order.map((i) => pts[i]).filter(Boolean);
  const path = opts.roundtrip && ordered.length ? [...ordered, ordered[0]] : ordered;
  const driven = await drivingRoute(path, opts);
  driven.order = order;
  return driven;
}
