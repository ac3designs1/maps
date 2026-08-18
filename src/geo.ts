const UA = "TripPlanner/1.0 (https://github.com/ac3designs1/maps)";

export type SuggestHit = {
  label: string;
  lat: number;
  lng: number;
  kind?: string;
  name?: string;
};

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
  const seen = new Set<string>();
  const out: SuggestHit[] = [];
  for (const h of hits) {
    const key = `${h.lat.toFixed(5)},${h.lng.toFixed(5)}|${h.label.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
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
    out.push({
      label: fmtPhoton(props, q),
      lat: latN,
      lng,
      kind: BIZ_KEYS.has(key) ? "business" : "address",
      name: String(props.name || ""),
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
    out.push({
      label: fmtNominatim(item) || q,
      lat: latN,
      lng,
      kind: biz ? "business" : "address",
      name: item.name || "",
    });
  }
  return out;
}

function rankHits(query: string, hits: SuggestHit[], lat?: number, lon?: number) {
  const q = query.toLowerCase();
  const bias = biasPoint(lat, lon);
  const scored = hits.map((h) => {
    const name = (h.name || h.label).toLowerCase();
    let score = 0;
    if (name === q) score += 120;
    else if (name.startsWith(q)) score += 80;
    else if (name.includes(q)) score += 40;
    if (h.kind === "business") score += 30;
    const dlat = h.lat - bias.lat;
    const dlng = h.lng - bias.lon;
    score -= Math.sqrt(dlat * dlat + dlng * dlng) * 8;
    return { h, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.h);
}

export async function suggest(q: string, lat?: number, lon?: number): Promise<SuggestHit[]> {
  const query = q.trim();
  if (query.length < 2) return [];
  const [photon, nomi] = await Promise.allSettled([
    photonSuggest(query, lat, lon),
    nominatimSuggest(query, lat, lon),
  ]);
  const merged = [
    ...(photon.status === "fulfilled" ? photon.value : []),
    ...(nomi.status === "fulfilled" ? nomi.value : []),
  ].filter((h) => inAustralia(h.lat, h.lng));
  return rankHits(query, dedupe(merged), lat, lon).slice(0, 8);
}

export async function geocode(q: string, lat?: number, lon?: number): Promise<SuggestHit | null> {
  const query = q.trim();
  if (query.length < 2) return null;
  try {
    const photon = (await photonSuggest(query, lat, lon)).filter((h) => inAustralia(h.lat, h.lng));
    if (photon[0]) return rankHits(query, photon, lat, lon)[0];
  } catch {
    /* fall through */
  }
  try {
    const nomi = (await nominatimSuggest(query, lat, lon)).filter((h) => inAustralia(h.lat, h.lng));
    return rankHits(query, nomi, lat, lon)[0] || null;
  } catch {
    return null;
  }
}

export async function reverse(lat: number, lon: number): Promise<SuggestHit | null> {
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
  geometry: [number, number][];
  order?: number[];
  legs: { distanceM: number; durationS: number }[];
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
  waypoints?: Array<{ waypoint_index?: number }>;
}): RouteResult {
  const r = json.routes?.[0] || json.trips?.[0];
  if (!r) throw new Error("No driving route found");
  const geometry: [number, number][] = (r.geometry?.coordinates || []).map((c) => [c[1], c[0]]);
  let order: number[] | undefined;
  if (json.waypoints?.length) {
    order = Array(json.waypoints.length);
    json.waypoints.forEach((w, i) => {
      const at = w.waypoint_index ?? i;
      if (at >= 0 && at < order!.length) order![at] = i;
    });
    if (order.some((n) => n == null)) order = undefined;
  }
  return {
    distanceM: r.distance || 0,
    durationS: r.duration || 0,
    geometry,
    order,
    legs: (r.legs || []).map((l) => ({ distanceM: l.distance || 0, durationS: l.duration || 0 })),
  };
}

async function routeOnce(pts: LngLat[]) {
  const url =
    `https://router.project-osrm.org/route/v1/driving/${coordStr(pts)}` +
    `?overview=full&geometries=geojson&alternatives=false`;
  return parseRoute(await getJson(url, 25000));
}

export async function drivingRoute(pts: LngLat[]): Promise<RouteResult> {
  if (pts.length < 2) throw new Error("Need two stops");
  if (pts.length <= 80) return routeOnce(pts);
  const geometry: [number, number][] = [];
  const legs: { distanceM: number; durationS: number }[] = [];
  let distanceM = 0;
  let durationS = 0;
  for (let i = 0; i < pts.length - 1; i += 70) {
    const slice = pts.slice(i, Math.min(pts.length, i + 71));
    const part = await routeOnce(slice);
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
  opts: { roundtrip: boolean; keepEnds: boolean },
): Promise<RouteResult> {
  if (pts.length < 2) throw new Error("Need two stops");
  if (pts.length > 80) throw new Error("Optimize works up to 80 stops — route still has no cap");
  const params = new URLSearchParams({
    overview: "full",
    geometries: "geojson",
    roundtrip: opts.roundtrip ? "true" : "false",
    source: "first",
  });
  params.set("destination", opts.roundtrip || !opts.keepEnds ? "any" : "last");
  const url = `https://router.project-osrm.org/trip/v1/driving/${coordStr(pts)}?${params}`;
  const trip = parseRoute(await getJson(url, 30000));
  if (!trip.order) return trip;
  const ordered = trip.order.map((i) => pts[i]).filter(Boolean);
  if (ordered.length >= 2) {
    try {
      const driven = await drivingRoute(opts.roundtrip ? [...ordered, ordered[0]] : ordered);
      driven.order = trip.order;
      return driven;
    } catch {
      return trip;
    }
  }
  return trip;
}
