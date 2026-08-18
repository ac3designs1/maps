const UA = "TripPlanner/1.0 (iPhone PWA; local use)";

export type SuggestHit = {
  label: string;
  lat: number;
  lng: number;
};

function fmtPhoton(props: Record<string, unknown>, fallback: string) {
  const parts = [
    [props.housenumber, props.street].filter(Boolean).join(" "),
    props.name,
    props.city || props.town || props.village || props.locality,
    props.state,
    props.postcode,
    props.country,
  ]
    .flat()
    .map((x) => String(x || "").trim())
    .filter(Boolean);
  const uniq = [...new Set(parts)];
  return uniq.join(", ") || fallback;
}

async function getJson(url: string, ms = 8000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: { Accept: "application/json", "User-Agent": UA },
    });
    if (!res.ok) throw new Error(`Upstream ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

export async function suggest(q: string, lat?: number, lon?: number): Promise<SuggestHit[]> {
  const query = q.trim();
  if (query.length < 2) return [];
  const u = new URL("https://photon.komoot.io/api/");
  u.searchParams.set("q", query);
  u.searchParams.set("limit", "8");
  u.searchParams.set("lang", "en");
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    u.searchParams.set("lat", String(lat));
    u.searchParams.set("lon", String(lon));
  }
  const data = (await getJson(u.toString())) as {
    features?: Array<{
      geometry?: { coordinates?: number[] };
      properties?: Record<string, unknown>;
    }>;
  };
  const out: SuggestHit[] = [];
  for (const f of data.features || []) {
    const [lng, latN] = f.geometry?.coordinates || [];
    if (!Number.isFinite(latN) || !Number.isFinite(lng)) continue;
    out.push({
      label: fmtPhoton(f.properties || {}, query),
      lat: latN,
      lng,
    });
  }
  return out;
}

export async function geocode(q: string, lat?: number, lon?: number): Promise<SuggestHit | null> {
  const hits = await suggest(q, lat, lon);
  return hits[0] || null;
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
  if (!r) throw new Error("No route found");
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

export async function drivingRoute(pts: LngLat[]): Promise<RouteResult> {
  if (pts.length < 2) throw new Error("Need two stops");
  const url =
    `https://router.project-osrm.org/route/v1/driving/${coordStr(pts)}` +
    `?overview=full&geometries=geojson&alternatives=false`;
  return parseRoute(await getJson(url, 20000));
}

export async function optimizedTrip(
  pts: LngLat[],
  opts: { roundtrip: boolean; keepEnds: boolean },
): Promise<RouteResult> {
  if (pts.length < 2) throw new Error("Need two stops");
  const params = new URLSearchParams({
    overview: "full",
    geometries: "geojson",
    roundtrip: opts.roundtrip ? "true" : "false",
    source: "first",
  });
  params.set("destination", opts.roundtrip || !opts.keepEnds ? "any" : "last");
  const url = `https://router.project-osrm.org/trip/v1/driving/${coordStr(pts)}?${params}`;
  return parseRoute(await getJson(url, 25000));
}
