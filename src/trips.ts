import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = process.env.DATA_DIR || path.join(root, "data");
const file = path.join(dataDir, "trips.json");

export type Stop = {
  id: string;
  query: string;
  label: string;
  lat: number | null;
  lng: number | null;
};

export type Trip = {
  id: string;
  title: string;
  stops: Stop[];
  roundtrip: boolean;
  keepEnds: boolean;
  createdAt: number;
  updatedAt: number;
  distanceM?: number;
  durationS?: number;
};

type Store = { trips: Trip[] };

async function load(): Promise<Store> {
  try {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw) as Store;
    if (!Array.isArray(parsed.trips)) return { trips: [] };
    return parsed;
  } catch {
    return { trips: [] };
  }
}

async function save(store: Store) {
  await mkdir(dataDir, { recursive: true });
  await writeFile(file, JSON.stringify(store, null, 2), "utf8");
}

export async function allTrips() {
  const store = await load();
  return store.trips.slice().sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function listTrips() {
  const store = await load();
  return store.trips
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((t) => ({
      id: t.id,
      title: t.title,
      updatedAt: t.updatedAt,
      createdAt: t.createdAt,
      stopCount: t.stops.filter((s) => s.label || s.query).length,
      preview: t.stops
        .filter((s) => s.label || s.query)
        .slice(0, 3)
        .map((s) => s.label || s.query)
        .join(" → "),
      distanceM: t.distanceM || 0,
      durationS: t.durationS || 0,
    }));
}

export async function getTrip(id: string) {
  const store = await load();
  return store.trips.find((t) => t.id === id) || null;
}

export async function upsertTrip(trip: Trip) {
  const store = await load();
  const i = store.trips.findIndex((t) => t.id === trip.id);
  const next = { ...trip, updatedAt: Date.now() };
  if (i >= 0) store.trips[i] = next;
  else store.trips.unshift(next);
  await save(store);
  return next;
}

export async function deleteTrip(id: string) {
  const store = await load();
  store.trips = store.trips.filter((t) => t.id !== id);
  await save(store);
}
