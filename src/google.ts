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

export type GoogleRoute = {
  distanceM: number;
  durationS: number;
  geometry: [number, number][];
  legs: { distanceM: number; durationS: number }[];
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
  const avoid = avoidParam(opts);
  if (avoid) u.searchParams.set("avoid", avoid);

  const data = (await googleFetch(u.toString(), {}, 18000)) as {
    status?: string;
    rows?: Array<{ elements?: Array<{ status?: string; duration?: { value?: number } }> }>;
  };
  if (data.status && data.status !== "OK") return null;
  const rows = data.rows || [];
  if (rows.length !== pts.length) return null;
  const out: number[][] = [];
  for (const row of rows) {
    const line: number[] = [];
    for (const el of row.elements || []) {
      const v = el.duration?.value;
      line.push(el.status === "OK" && Number.isFinite(v) ? (v as number) : 1e12);
    }
    if (line.length !== pts.length) return null;
    out.push(line);
  }
  return out;
}

/** Google Directions for an already-ordered list of stops. */
export async function googleDrivingRoute(
  pts: LatLng[],
  opts?: { avoidTolls?: boolean; avoidFerries?: boolean },
): Promise<GoogleRoute | null> {
  const key = googleKey();
  if (!key || pts.length < 2) return null;

  const origin = pts[0];
  const dest = pts[pts.length - 1];
  const mid = pts.slice(1, -1).slice(0, 23);

  const u = new URL("https://maps.googleapis.com/maps/api/directions/json");
  u.searchParams.set("origin", loc(origin));
  u.searchParams.set("destination", loc(dest));
  u.searchParams.set("mode", "driving");
  u.searchParams.set("region", "au");
  u.searchParams.set("units", "metric");
  u.searchParams.set("key", key);
  if (mid.length) u.searchParams.set("waypoints", mid.map(loc).join("|"));
  const avoid = avoidParam(opts);
  if (avoid) u.searchParams.set("avoid", avoid);

  const data = (await googleFetch(u.toString(), {}, 20000)) as {
    status?: string;
    error_message?: string;
    routes?: Array<{
      overview_polyline?: { points?: string };
      legs?: Array<{ distance?: { value?: number }; duration?: { value?: number } }>;
    }>;
  };
  if (data.status && data.status !== "OK") return null;
  const route = data.routes?.[0];
  if (!route) return null;
  const legs = (route.legs || []).map((l) => ({
    distanceM: l.distance?.value || 0,
    durationS: l.duration?.value || 0,
  }));
  return {
    distanceM: legs.reduce((s, l) => s + l.distanceM, 0),
    durationS: legs.reduce((s, l) => s + l.durationS, 0),
    geometry: decodePolyline(route.overview_polyline?.points || ""),
    legs,
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
