import type { SuggestHit } from "./geo.ts";
import { dedupeSuggestHits } from "./geo.ts";

const BIZ_TYPES = new Set([
  "establishment",
  "point_of_interest",
  "store",
  "food",
  "shopping_mall",
  "supermarket",
  "gas_station",
  "restaurant",
  "cafe",
  "lodging",
  "hospital",
  "doctor",
  "pharmacy",
  "school",
  "university",
  "gym",
  "bar",
  "night_club",
  "car_dealer",
  "car_repair",
  "home_goods_store",
  "department_store",
  "convenience_store",
]);

const AU = {
  minLng: 112.5,
  maxLng: 154.1,
  minLat: -44.1,
  maxLat: -9.5,
  biasLat: -33.8688,
  biasLng: 151.2093,
};

function inAustralia(lat: number, lng: number) {
  return lat >= AU.minLat && lat <= AU.maxLat && lng >= AU.minLng && lng <= AU.maxLng;
}

function biasPoint(lat?: number, lon?: number) {
  if (Number.isFinite(lat) && Number.isFinite(lon) && inAustralia(lat as number, lon as number)) {
    return { lat: lat as number, lon: lon as number };
  }
  return { lat: AU.biasLat, lon: AU.biasLng };
}

function googleKey() {
  return (process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_PLACES_API_KEY || "").trim();
}

export function hasGoogleKey() {
  return !!googleKey();
}

async function googleFetch(url: string, opts: RequestInit = {}, ms = 12000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const res = await fetch(url, { ...opts, signal: ac.signal });
    const text = await res.text();
    let data: Record<string, unknown> = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new Error("Google Places error");
    }
    if (!res.ok) {
      const err = data.error as { message?: string } | undefined;
      const msg = String(err?.message || data.error_message || "Google Places error");
      throw new Error(msg);
    }
    return data;
  } finally {
    clearTimeout(t);
  }
}

function kindFromTypes(types: string[] = []) {
  return types.some((t) => BIZ_TYPES.has(t)) ? "business" : "address";
}

function fmtPlace(name: string, formatted: string) {
  const n = name.trim();
  const f = formatted.trim();
  if (!f) return n;
  if (!n) return f;
  if (f.toLowerCase().startsWith(n.toLowerCase())) return f;
  return `${n}, ${f}`;
}

function dedupeHits(hits: SuggestHit[]) {
  return dedupeSuggestHits(hits);
}

async function googlePlaceDetails(placeId: string): Promise<SuggestHit | null> {
  const key = googleKey();
  const id = placeId.replace(/^places\//, "");
  const data = (await googleFetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(id)}`, {
    headers: {
      "X-Goog-Api-Key": key,
      "X-Goog-FieldMask": "displayName,formattedAddress,location,types",
    },
  })) as {
    displayName?: { text?: string };
    formattedAddress?: string;
    location?: { latitude?: number; longitude?: number };
    types?: string[];
  };

  const la = data.location?.latitude;
  const ln = data.location?.longitude;
  if (!Number.isFinite(la) || !Number.isFinite(ln) || !inAustralia(la as number, ln as number)) return null;
  const name = data.displayName?.text || "";
  return {
    label: fmtPlace(name, data.formattedAddress || ""),
    lat: la as number,
    lng: ln as number,
    kind: kindFromTypes(data.types || []),
    name,
  };
}

async function googleAutocomplete(query: string, lat?: number, lon?: number): Promise<SuggestHit[]> {
  const key = googleKey();
  const bias = biasPoint(lat, lon);
  const body = {
    input: query,
    includedRegionCodes: ["au"],
    locationBias: {
      circle: {
        center: { latitude: bias.lat, longitude: bias.lon },
        radius: 50000.0,
      },
    },
  };

  const data = (await googleFetch("https://places.googleapis.com/v1/places:autocomplete", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": key,
    },
    body: JSON.stringify(body),
  })) as {
    suggestions?: Array<{
      placePrediction?: {
        placeId?: string;
        place?: string;
        structuredFormat?: { mainText?: { text?: string }; secondaryText?: { text?: string } };
        types?: string[];
      };
    }>;
  };

  const ids = [...new Set(
    (data.suggestions || [])
      .map((s) => s.placePrediction?.placeId || s.placePrediction?.place?.replace(/^places\//, ""))
      .filter(Boolean) as string[],
  )].slice(0, 6);

  const hits = await Promise.all(ids.map((id) => googlePlaceDetails(id)));
  return hits.filter((h): h is SuggestHit => !!h);
}

async function googleTextSearch(query: string, lat?: number, lon?: number): Promise<SuggestHit[]> {
  const key = googleKey();
  const bias = biasPoint(lat, lon);
  const body = {
    textQuery: query,
    regionCode: "au",
    locationBias: {
      circle: {
        center: { latitude: bias.lat, longitude: bias.lon },
        radius: 50000.0,
      },
    },
    maxResultCount: 8,
  };

  const data = (await googleFetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": key,
      "X-Goog-FieldMask": "places.displayName,places.formattedAddress,places.location,places.types",
    },
    body: JSON.stringify(body),
  })) as {
    places?: Array<{
      displayName?: { text?: string };
      formattedAddress?: string;
      location?: { latitude?: number; longitude?: number };
      types?: string[];
    }>;
  };

  const hits: SuggestHit[] = [];
  for (const place of data.places || []) {
    const la = place.location?.latitude;
    const ln = place.location?.longitude;
    if (!Number.isFinite(la) || !Number.isFinite(ln) || !inAustralia(la as number, ln as number)) continue;
    const name = place.displayName?.text || "";
    const label = fmtPlace(name, place.formattedAddress || "");
    hits.push({
      label,
      lat: la as number,
      lng: ln as number,
      kind: kindFromTypes(place.types || []),
      name,
    });
  }
  return hits;
}

export async function googleSuggest(q: string, lat?: number, lon?: number): Promise<SuggestHit[]> {
  const key = googleKey();
  if (!key) return [];

  const query = q.trim();
  if (query.length < 2) return [];

  const autoHits = await googleAutocomplete(query, lat, lon);
  const textHits = autoHits.length >= 5 ? [] : await googleTextSearch(query, lat, lon);
  return dedupeSuggestHits([...autoHits, ...textHits]).slice(0, 8);
}

export async function googleGeocode(q: string, lat?: number, lon?: number): Promise<SuggestHit | null> {
  const key = googleKey();
  if (!key) return null;

  const query = q.trim();
  if (query.length < 2) return null;

  const bias = biasPoint(lat, lon);
  const u = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  u.searchParams.set("address", query);
  u.searchParams.set("components", "country:AU");
  u.searchParams.set("region", "au");
  u.searchParams.set("key", key);
  u.searchParams.set(
    "bounds",
    `${AU.minLat},${AU.minLng}|${AU.maxLat},${AU.maxLng}`,
  );
  u.searchParams.set("latlng", `${bias.lat},${bias.lon}`);

  const data = (await googleFetch(u.toString())) as {
    results?: Array<{
      formatted_address?: string;
      geometry?: { location?: { lat?: number; lng?: number } };
      types?: string[];
    }>;
    status?: string;
  };

  if (data.status && data.status !== "OK" && data.status !== "ZERO_RESULTS") {
    if (data.status === "REQUEST_DENIED") throw new Error("Google API key rejected — check billing & APIs");
    throw new Error(`Google geocode: ${data.status}`);
  }

  for (const r of data.results || []) {
    const la = r.geometry?.location?.lat;
    const ln = r.geometry?.location?.lng;
    if (!Number.isFinite(la) || !Number.isFinite(ln) || !inAustralia(la as number, ln as number)) continue;
    return {
      label: r.formatted_address || query,
      lat: la as number,
      lng: ln as number,
      kind: kindFromTypes(r.types || []),
      name: "",
    };
  }

  const fromSearch = await googleSuggest(query, lat, lon);
  return fromSearch[0] || null;
}

type LatLng = { lat: number; lng: number };

export type TrafficSpeed = "NORMAL" | "SLOW" | "TRAFFIC_JAM";

export type TrafficSegment = {
  speed: TrafficSpeed;
  geometry: [number, number][];
};

export type GoogleRoute = {
  distanceM: number;
  durationS: number;
  durationStaticS?: number;
  trafficDelayS?: number;
  traffic?: boolean;
  geometry: [number, number][];
  legs: { distanceM: number; durationS: number }[];
  segments?: TrafficSegment[];
};

function avoidParam(opts?: { avoidTolls?: boolean; avoidFerries?: boolean }) {
  const parts: string[] = [];
  if (opts?.avoidTolls) parts.push("tolls");
  if (opts?.avoidFerries) parts.push("ferries");
  return parts.join("|");
}

function loc(p: LatLng) {
  return `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;
}

function decodePolyline(str: string): [number, number][] {
  const pts: [number, number][] = [];
  if (!str) return pts;
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < str.length) {
    let b = 0;
    let shift = 0;
    let result = 0;
    do {
      b = str.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;
    shift = 0;
    result = 0;
    do {
      b = str.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;
    pts.push([lat / 1e5, lng / 1e5]);
  }
  return pts;
}

function appendPoly(target: [number, number][], encoded?: string) {
  const decoded = decodePolyline(encoded || "");
  if (target.length && decoded.length) {
    const a = target[target.length - 1];
    const b = decoded[0];
    if (a[0] === b[0] && a[1] === b[1]) decoded.shift();
  }
  target.push(...decoded);
}

function parseDurationS(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const m = String(v || "").match(/^([\d.]+)s$/);
  return m ? Number(m[1]) : 0;
}

function asSpeed(raw?: string): TrafficSpeed {
  if (raw === "SLOW" || raw === "TRAFFIC_JAM") return raw;
  return "NORMAL";
}

function intervalsToSegments(
  geometry: [number, number][],
  intervals?: Array<{ startPolylinePointIndex?: number; endPolylinePointIndex?: number; speed?: string }>,
): TrafficSegment[] {
  if (!intervals?.length || geometry.length < 2) return [];
  return intervals
    .map((iv) => {
      const start = Math.max(0, iv.startPolylinePointIndex ?? 0);
      const end = Math.min(geometry.length - 1, iv.endPolylinePointIndex ?? geometry.length - 1);
      return { speed: asSpeed(iv.speed), geometry: geometry.slice(start, end + 1) };
    })
    .filter((s) => s.geometry.length >= 2);
}

function withTraffic(route: GoogleRoute, liveS: number, staticS: number, usedLive: boolean): GoogleRoute {
  const durationStaticS = staticS > 0 ? staticS : liveS;
  return {
    ...route,
    durationS: liveS || route.durationS,
    durationStaticS,
    trafficDelayS: Math.max(0, (liveS || route.durationS) - durationStaticS),
    traffic: usedLive,
  };
}

const GOOGLE_MAX_PTS = 25;
let routesTrafficOk: boolean | null = null;

async function googleRoutesCompute(
  pts: LatLng[],
  opts?: { avoidTolls?: boolean; avoidFerries?: boolean },
  live = true,
): Promise<GoogleRoute | null> {
  const key = googleKey();
  const origin = pts[0];
  const dest = pts[pts.length - 1];
  const body: Record<string, unknown> = {
    origin: { location: { latLng: { latitude: origin.lat, longitude: origin.lng } } },
    destination: { location: { latLng: { latitude: dest.lat, longitude: dest.lng } } },
    travelMode: "DRIVE",
    routingPreference: live ? "TRAFFIC_AWARE" : "TRAFFIC_UNAWARE",
    polylineQuality: "HIGH_QUALITY",
    polylineEncoding: "ENCODED_POLYLINE",
    computeAlternativeRoutes: false,
    languageCode: "en-AU",
    regionCode: "AU",
    units: "METRIC",
  };
  if (live) body.departureTime = new Date(Date.now() + 5000).toISOString();
  const mid = pts.slice(1, -1);
  if (mid.length) {
    body.intermediates = mid.map((p) => ({
      location: { latLng: { latitude: p.lat, longitude: p.lng } },
    }));
  }
  const modifiers: Record<string, boolean> = {};
  if (opts?.avoidTolls) modifiers.avoidTolls = true;
  if (opts?.avoidFerries) modifiers.avoidFerries = true;
  if (Object.keys(modifiers).length) body.routeModifiers = modifiers;

  const data = (await googleFetch(
    "https://routes.googleapis.com/directions/v2:computeRoutes",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask":
          "routes.duration,routes.staticDuration,routes.distanceMeters,routes.polyline.encodedPolyline,routes.travelAdvisory.speedReadingIntervals,routes.legs.duration,routes.legs.staticDuration,routes.legs.distanceMeters,routes.legs.polyline.encodedPolyline,routes.legs.steps.polyline.encodedPolyline,routes.legs.travelAdvisory.speedReadingIntervals",
      },
      body: JSON.stringify(body),
    },
    20000,
  )) as {
    routes?: Array<{
      duration?: string;
      staticDuration?: string;
      distanceMeters?: number;
      polyline?: { encodedPolyline?: string };
      travelAdvisory?: {
        speedReadingIntervals?: Array<{
          startPolylinePointIndex?: number;
          endPolylinePointIndex?: number;
          speed?: string;
        }>;
      };
      legs?: Array<{
        duration?: string;
        staticDuration?: string;
        distanceMeters?: number;
        polyline?: { encodedPolyline?: string };
        travelAdvisory?: {
          speedReadingIntervals?: Array<{
            startPolylinePointIndex?: number;
            endPolylinePointIndex?: number;
            speed?: string;
          }>;
        };
        steps?: Array<{ polyline?: { encodedPolyline?: string } }>;
      }>;
    }>;
  };

  const route = data.routes?.[0];
  if (!route) return null;
  const geometry: [number, number][] = [];
  // Prefer the route polyline so traffic speed indexes line up
  if (live) appendPoly(geometry, route.polyline?.encodedPolyline);
  if (geometry.length < 2) {
    for (const leg of route.legs || []) {
      const steps = leg.steps || [];
      if (steps.length) {
        for (const step of steps) appendPoly(geometry, step.polyline?.encodedPolyline);
      } else {
        appendPoly(geometry, leg.polyline?.encodedPolyline);
      }
    }
  }
  if (geometry.length < 2) appendPoly(geometry, route.polyline?.encodedPolyline);
  const legs = (route.legs || []).map((l) => ({
    distanceM: l.distanceMeters || 0,
    durationS: parseDurationS(l.duration) || parseDurationS(l.staticDuration),
  }));
  if (geometry.length < 2) return null;
  const liveS = parseDurationS(route.duration) || legs.reduce((s, l) => s + l.durationS, 0);
  const staticS = parseDurationS(route.staticDuration);
  const segments = intervalsToSegments(geometry, route.travelAdvisory?.speedReadingIntervals);
  return withTraffic(
    {
      distanceM: route.distanceMeters || legs.reduce((s, l) => s + l.distanceM, 0),
      durationS: liveS,
      geometry,
      legs: legs.length ? legs : [{ distanceM: route.distanceMeters || 0, durationS: liveS }],
      segments: segments.length ? segments : undefined,
    },
    liveS,
    staticS,
    live,
  );
}

async function googleDirections(
  pts: LatLng[],
  opts?: { avoidTolls?: boolean; avoidFerries?: boolean },
  live = true,
): Promise<GoogleRoute | null> {
  const origin = pts[0];
  const dest = pts[pts.length - 1];
  const mid = pts.slice(1, -1);

  const u = new URL("https://maps.googleapis.com/maps/api/directions/json");
  u.searchParams.set("origin", loc(origin));
  u.searchParams.set("destination", loc(dest));
  u.searchParams.set("mode", "driving");
  u.searchParams.set("region", "au");
  u.searchParams.set("units", "metric");
  u.searchParams.set("key", googleKey());
  if (mid.length) u.searchParams.set("waypoints", mid.map(loc).join("|"));
  const avoid = avoidParam(opts);
  if (avoid) u.searchParams.set("avoid", avoid);
  if (live) {
    u.searchParams.set("departure_time", "now");
    u.searchParams.set("traffic_model", "best_guess");
  }

  const data = (await googleFetch(u.toString(), {}, 20000)) as {
    status?: string;
    routes?: Array<{
      overview_polyline?: { points?: string };
      legs?: Array<{
        distance?: { value?: number };
        duration?: { value?: number };
        duration_in_traffic?: { value?: number };
        steps?: Array<{ polyline?: { points?: string } }>;
      }>;
    }>;
  };
  if (data.status && data.status !== "OK") return null;
  const route = data.routes?.[0];
  if (!route) return null;
  const geometry: [number, number][] = [];
  for (const leg of route.legs || []) {
    const steps = leg.steps || [];
    if (steps.length) {
      for (const step of steps) appendPoly(geometry, step.polyline?.points);
    }
  }
  if (geometry.length < 2) appendPoly(geometry, route.overview_polyline?.points);
  const legs = (route.legs || []).map((l) => ({
    distanceM: l.distance?.value || 0,
    durationS: l.duration_in_traffic?.value || l.duration?.value || 0,
  }));
  if (geometry.length < 2) return null;
  const liveS = legs.reduce((s, l) => s + l.durationS, 0);
  const staticS = (route.legs || []).reduce((s, l) => s + (l.duration?.value || 0), 0);
  return withTraffic(
    {
      distanceM: legs.reduce((s, l) => s + l.distanceM, 0),
      durationS: liveS,
      geometry,
      legs,
    },
    liveS,
    staticS,
    live && staticS > 0,
  );
}

function goodRoute(r: GoogleRoute | null, n: number) {
  return !!(r && r.geometry.length > n);
}

async function oneGoogleRoute(
  pts: LatLng[],
  opts?: { avoidTolls?: boolean; avoidFerries?: boolean },
): Promise<GoogleRoute | null> {
  if (routesTrafficOk !== false) {
    try {
      const routed = await googleRoutesCompute(pts, opts, true);
      if (goodRoute(routed, pts.length)) {
        routesTrafficOk = true;
        return routed;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (/PERMISSION|403|routingPreference|TRAFFIC_AWARE|has not been used/i.test(msg)) {
        routesTrafficOk = false;
      }
    }
  }
  try {
    const directed = await googleDirections(pts, opts, true);
    if (goodRoute(directed, pts.length)) return directed;
  } catch {
    /* static fallback */
  }
  try {
    const routed = await googleRoutesCompute(pts, opts, false);
    if (goodRoute(routed, pts.length)) return routed;
  } catch {
    /* Directions static */
  }
  try {
    const directed = await googleDirections(pts, opts, false);
    if (goodRoute(directed, pts.length)) return directed;
  } catch {
    /* caller falls back to OSRM */
  }
  return null;
}

/** Driving duration seconds between every pair. Null if the key can't do Distance Matrix. */
export async function googleDurationMatrix(
  pts: LatLng[],
  opts?: { avoidTolls?: boolean; avoidFerries?: boolean },
): Promise<number[][] | null> {
  const key = googleKey();
  if (!key || pts.length < 2 || pts.length > 10) return null;

  const u = new URL("https://maps.googleapis.com/maps/api/distancematrix/json");
  u.searchParams.set("origins", pts.map(loc).join("|"));
  u.searchParams.set("destinations", pts.map(loc).join("|"));
  u.searchParams.set("mode", "driving");
  u.searchParams.set("region", "au");
  u.searchParams.set("units", "metric");
  u.searchParams.set("key", key);
  u.searchParams.set("departure_time", "now");
  const avoid = avoidParam(opts);
  if (avoid) u.searchParams.set("avoid", avoid);

  const data = (await googleFetch(u.toString(), {}, 18000)) as {
    status?: string;
    rows?: Array<{ elements?: Array<{ status?: string; duration?: { value?: number }; duration_in_traffic?: { value?: number } }> }>;
  };
  if (data.status && data.status !== "OK") return null;
  const rows = data.rows || [];
  if (rows.length !== pts.length) return null;
  const out: number[][] = [];
  for (const row of rows) {
    const line: number[] = [];
    for (const el of row.elements || []) {
      const v = el.duration_in_traffic?.value ?? el.duration?.value;
      line.push(el.status === "OK" && Number.isFinite(v) ? (v as number) : 1e12);
    }
    if (line.length !== pts.length) return null;
    out.push(line);
  }
  return out;
}

/** Google driving route that follows the roads (Routes API, then Directions steps). */
export async function googleDrivingRoute(
  pts: LatLng[],
  opts?: { avoidTolls?: boolean; avoidFerries?: boolean },
): Promise<GoogleRoute | null> {
  const key = googleKey();
  if (!key || pts.length < 2) return null;
  if (pts.length <= GOOGLE_MAX_PTS) return oneGoogleRoute(pts, opts);

  const geometry: [number, number][] = [];
  const legs: { distanceM: number; durationS: number }[] = [];
  const segments: TrafficSegment[] = [];
  let distanceM = 0;
  let durationS = 0;
  let durationStaticS = 0;
  let traffic = false;
  for (let i = 0; i < pts.length - 1; i += GOOGLE_MAX_PTS - 1) {
    const slice = pts.slice(i, Math.min(pts.length, i + GOOGLE_MAX_PTS));
    const part = await oneGoogleRoute(slice, opts);
    if (!part) return null;
    if (geometry.length && part.geometry.length) part.geometry.shift();
    geometry.push(...part.geometry);
    legs.push(...part.legs);
    if (part.segments) segments.push(...part.segments);
    distanceM += part.distanceM;
    durationS += part.durationS;
    durationStaticS += part.durationStaticS || part.durationS;
    if (part.traffic) traffic = true;
  }
  if (geometry.length <= pts.length) return null;
  return {
    distanceM,
    durationS,
    durationStaticS,
    trafficDelayS: Math.max(0, durationS - durationStaticS),
    traffic,
    geometry,
    legs,
    segments: segments.length ? segments : undefined,
  };
}

export async function googleReverse(lat: number, lon: number): Promise<SuggestHit | null> {
  const key = googleKey();
  if (!key) return null;

  const u = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  u.searchParams.set("latlng", `${lat},${lon}`);
  u.searchParams.set("key", key);
  u.searchParams.set("result_type", "street_address|route|premise|subpremise|neighborhood|locality");

  const data = (await googleFetch(u.toString(), {}, 8000)) as {
    results?: Array<{ formatted_address?: string; geometry?: { location?: { lat?: number; lng?: number } } }>;
    status?: string;
  };

  const r = data.results?.[0];
  if (!r?.geometry?.location) return { label: "Your location", lat, lng: lon, kind: "gps" };
  const la = r.geometry.location.lat;
  const ln = r.geometry.location.lng;
  if (!Number.isFinite(la) || !Number.isFinite(ln)) return { label: "Your location", lat, lng: lon, kind: "gps" };
  return { label: r.formatted_address || "Your location", lat: la as number, lng: ln as number, kind: "gps" };
}
