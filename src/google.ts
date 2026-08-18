import type { SuggestHit } from "./geo.ts";

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

  const ids = (data.suggestions || [])
    .map((s) => s.placePrediction?.placeId || s.placePrediction?.place?.replace(/^places\//, ""))
    .filter(Boolean)
    .slice(0, 6) as string[];

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

  const [auto, text] = await Promise.allSettled([googleAutocomplete(query, lat, lon), googleTextSearch(query, lat, lon)]);
  const merged = dedupeHits([
    ...(auto.status === "fulfilled" ? auto.value : []),
    ...(text.status === "fulfilled" ? text.value : []),
  ]);
  return merged.slice(0, 8);
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
