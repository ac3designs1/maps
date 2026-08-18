/* global L */
const $ = (id) => document.getElementById(id);

const state = {
  screen: "list",
  trips: [],
  records: [],
  trip: null,
  filter: "",
  bias: { lat: -33.8688, lng: 151.2093 },
  here: null,
  focusId: null,
  suggestTimer: 0,
  saveTimer: 0,
  route: null,
  map: null,
  line: null,
  markers: [],
};

function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add("hidden"), 2200);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random();
}

function filledStops(trip = state.trip) {
  return (trip?.stops || []).filter((s) => (s.label || s.query).trim());
}

function geocodedStops(trip = state.trip) {
  return (trip?.stops || []).filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lng));
}

function titleFromStops(trip) {
  const f = filledStops(trip);
  if (f.length < 2) return trip.title && trip.title !== "Untitled trip" ? trip.title : "Untitled trip";
  const a = (f[0].label || f[0].query).split(",")[0];
  const b = (f[f.length - 1].label || f[f.length - 1].query).split(",")[0];
  return `${a} to ${b}`;
}

function showList() {
  state.screen = "list";
  $("listScreen").classList.remove("hidden");
  $("tripScreen").classList.add("hidden");
}

function showTrip() {
  state.screen = "trip";
  $("listScreen").classList.add("hidden");
  $("tripScreen").classList.remove("hidden");
  requestAnimationFrame(() => state.map?.invalidateSize());
}

function fmtDur(s) {
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} hr ${r} min` : `${h} hr`;
}

function fmtKm(m) {
  if (m < 950) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(m >= 100000 ? 0 : 1)} km`;
}

function relTime(ts) {
  const d = Date.now() - ts;
  if (d < 60_000) return "Just now";
  if (d < 3600_000) return `${Math.floor(d / 60_000)} min ago`;
  if (d < 86400_000) return `${Math.floor(d / 3600_000)} hr ago`;
  return new Date(ts).toLocaleDateString();
}

function renderList() {
  const q = state.filter.trim().toLowerCase();
  const rows = state.trips.filter((t) => {
    if (!q) return true;
    return `${t.title} ${t.preview}`.toLowerCase().includes(q);
  });
  $("tripEmpty").classList.toggle("hidden", rows.length > 0);
  $("tripList").innerHTML = rows
    .map(
      (t) => `
      <button type="button" class="trip-row" data-id="${t.id}">
        <span class="pin">📍</span>
        <span>
          <strong>${esc(t.title || "Untitled trip")}</strong>
          <span>${esc(t.preview || `${t.stopCount} stops`)}</span>
        </span>
        <em>${relTime(t.updatedAt)}</em>
      </button>`,
    )
    .join("");
}

function esc(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/"/g, "&quot;");
}

function renderStops() {
  const trip = state.trip;
  if (!trip) return;
  $("tripTitle").value = trip.title || "";
  const n = trip.stops.length;
  $("stopList").innerHTML = trip.stops
    .map((s, i) => {
      const kind = i === 0 ? "origin" : i === n - 1 && !trip.roundtrip ? "dest" : "";
      const ph = i === 0 ? "Choose starting point" : i === n - 1 && !trip.roundtrip ? "Choose destination" : "Add stop";
      return `
        <div class="stop-row ${kind}" data-id="${s.id}">
          <div class="rail"><span class="dot"></span></div>
          <input data-id="${s.id}" value="${esc(s.query || s.label)}" placeholder="${ph}" autocomplete="off" autocorrect="on" spellcheck="true" />
          <button type="button" class="icon-tiny" data-act="swap" data-id="${s.id}" aria-label="Move down">↕</button>
          <button type="button" class="icon-tiny" data-act="del" data-id="${s.id}" aria-label="Remove">×</button>
        </div>`;
    })
    .join("");
  updateEta();
}

function updateEta() {
  const r = state.route;
  const n = geocodedStops().length;
  if (!r || n < 2) {
    $("etaMain").textContent = n < 2 ? "Add two places" : "Getting route…";
    $("etaSub").textContent = `${filledStops().length} stops · no 10-stop limit`;
    $("btnStart").disabled = true;
    return;
  }
  $("etaMain").textContent = `${fmtDur(r.durationS)} · ${fmtKm(r.distanceM)}`;
  $("etaSub").textContent = `${n} stops${state.trip.roundtrip ? " · round trip" : ""} · saved on this phone`;
  $("btnStart").disabled = false;
}

function hideSuggest() {
  $("suggestPop").classList.add("hidden");
  $("suggestPop").innerHTML = "";
}

function placeSuggest() {
  const card = $("planCard");
  const pop = $("suggestPop");
  pop.style.top = card.offsetTop + card.offsetHeight + 8 + "px";
}

const STORE_KEY = "maps.trips.v1";

function summarize(t) {
  const filled = (t.stops || []).filter((s) => s.label || s.query);
  return {
    id: t.id,
    title: t.title,
    updatedAt: t.updatedAt,
    createdAt: t.createdAt,
    stopCount: filled.length,
    preview: filled.slice(0, 3).map((s) => s.label || s.query).join(" → "),
  };
}

function readLocal() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORE_KEY) || "{\"trips\":[]}");
    return Array.isArray(parsed.trips) ? parsed.trips : [];
  } catch {
    return [];
  }
}

function writeLocal(trips) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ trips }));
  } catch {
    /* quota */
  }
}

function mergeTrips(a, b) {
  const map = new Map();
  for (const t of [...a, ...b]) {
    if (!t?.id) continue;
    const prev = map.get(t.id);
    if (!prev || (t.updatedAt || 0) >= (prev.updatedAt || 0)) map.set(t.id, t);
  }
  return [...map.values()].sort((x, y) => (y.updatedAt || 0) - (x.updatedAt || 0));
}

function emptyTrip() {
  const now = Date.now();
  return {
    id: uid(),
    title: "Untitled trip",
    roundtrip: false,
    keepEnds: true,
    createdAt: now,
    updatedAt: now,
    stops: [
      { id: uid(), query: "", label: "", lat: null, lng: null },
      { id: uid(), query: "", label: "", lat: null, lng: null },
    ],
  };
}

function setRecords(trips) {
  state.records = trips;
  writeLocal(trips);
  state.trips = trips.map(summarize);
}

async function loadTrips() {
  let records = readLocal();
  try {
    const data = await api("/api/trips");
    records = mergeTrips(records, data.records || []);
  } catch {
    /* offline / first load */
  }
  setRecords(records);
  renderList();
}

async function openTrip(id) {
  let trip = (state.records || readLocal()).find((t) => t.id === id) || null;
  if (!trip) {
    const data = await api(`/api/trips/${id}`);
    trip = data.trip;
  }
  state.trip = trip;
  state.route = null;
  renderStops();
  showTrip();
  drawMap();
  routeNow(false);
}

async function newTrip() {
  const trip = emptyTrip();
  setRecords([trip, ...(state.records || readLocal()).filter((t) => t.id !== trip.id)]);
  state.trip = trip;
  state.route = null;
  renderStops();
  showTrip();
  drawMap();
  renderList();
  api("/api/trips/" + trip.id, { method: "PUT", body: JSON.stringify({ trip }) }).catch(() => {});
  setTimeout(() => $("stopList").querySelector("input")?.focus(), 200);
}

function scheduleSave() {
  $("saveState").textContent = "Saving…";
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(saveTrip, 450);
}

async function saveTrip() {
  if (!state.trip) return;
  if (!state.trip.title || state.trip.title === "Untitled trip") {
    state.trip.title = titleFromStops(state.trip);
    $("tripTitle").value = state.trip.title;
  }
  state.trip.updatedAt = Date.now();
  const next = mergeTrips([state.trip], state.records || readLocal());
  setRecords(next);
  $("saveState").textContent = "Saved";
  renderList();
  try {
    await api(`/api/trips/${state.trip.id}`, {
      method: "PUT",
      body: JSON.stringify({ trip: state.trip }),
    });
  } catch {
    /* phone copy is already saved */
  }
}

async function lookup(q) {
  const u = new URL("/api/suggest", location.origin);
  u.searchParams.set("q", q);
  u.searchParams.set("lat", String(state.here?.lat ?? state.bias.lat));
  u.searchParams.set("lon", String(state.here?.lng ?? state.bias.lng));
  const data = await api(u.pathname + u.search);
  return data.hits || [];
}

function applyHit(stop, hit) {
  stop.query = hit.label;
  stop.label = hit.label;
  stop.lat = hit.lat;
  stop.lng = hit.lng;
}

async function onSuggestPick(hit) {
  const stop = state.trip.stops.find((s) => s.id === state.focusId);
  if (!stop) return;
  applyHit(stop, hit);
  hideSuggest();
  renderStops();
  scheduleSave();
  routeNow(false);
}

function bindStopInput(input) {
  const id = input.dataset.id;
  input.addEventListener("focus", () => {
    state.focusId = id;
    placeSuggest();
    if (state.here && state.trip.stops[0]?.id === id && !input.value) {
      $("suggestPop").innerHTML = `<button type="button" data-me="1"><strong>Your location</strong><small>Use current GPS position</small></button>`;
      $("suggestPop").classList.remove("hidden");
    }
  });
  input.addEventListener("input", () => {
    const stop = state.trip.stops.find((s) => s.id === id);
    if (!stop) return;
    stop.query = input.value;
    stop.lat = null;
    stop.lng = null;
    stop.label = "";
    clearTimeout(state.suggestTimer);
    const q = input.value.trim();
    if (q.length < 2) {
      hideSuggest();
      return;
    }
    state.suggestTimer = setTimeout(async () => {
      try {
        const hits = await lookup(q);
        if (state.focusId !== id) return;
        if (!hits.length) {
          hideSuggest();
          return;
        }
        $("suggestPop").innerHTML = hits
          .map(
            (h, i) =>
              `<button type="button" data-i="${i}"><strong>${esc(h.label.split(",")[0])}</strong><small>${esc(h.label)}</small></button>`,
          )
          .join("");
        $("suggestPop")._hits = hits;
        $("suggestPop").classList.remove("hidden");
        placeSuggest();
      } catch {
        hideSuggest();
      }
    }, 180);
  });
  input.addEventListener("keydown", async (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const q = input.value.trim();
    if (!q) return;
    try {
      const hits = await lookup(q);
      if (hits[0]) await onSuggestPick(hits[0]);
    } catch (err) {
      toast(err.message);
    }
  });
}

function wireStopList() {
  $("stopList").querySelectorAll("input").forEach(bindStopInput);
}

const _renderStops = renderStops;
renderStops = function () {
  _renderStops();
  wireStopList();
};

$("stopList").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const id = btn.dataset.id;
  const i = state.trip.stops.findIndex((s) => s.id === id);
  if (i < 0) return;
  if (btn.dataset.act === "del") {
    if (state.trip.stops.length <= 2) {
      state.trip.stops[i] = { id: uid(), query: "", label: "", lat: null, lng: null };
    } else {
      state.trip.stops.splice(i, 1);
    }
  }
  if (btn.dataset.act === "swap") {
    const j = i === state.trip.stops.length - 1 ? i - 1 : i + 1;
    if (j >= 0) {
      const tmp = state.trip.stops[i];
      state.trip.stops[i] = state.trip.stops[j];
      state.trip.stops[j] = tmp;
    }
  }
  renderStops();
  scheduleSave();
  routeNow(false);
});

$("suggestPop").addEventListener("click", async (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  if (btn.dataset.me) {
    if (!state.here) {
      toast("Location not available");
      return;
    }
    await onSuggestPick({
      label: "Your location",
      lat: state.here.lat,
      lng: state.here.lng,
    });
    return;
  }
  const hits = $("suggestPop")._hits || [];
  const hit = hits[Number(btn.dataset.i)];
  if (hit) await onSuggestPick(hit);
});

$("btnAddStop").onclick = () => {
  const stops = state.trip.stops;
  const last = stops[stops.length - 1];
  const destLike = last && !state.trip.roundtrip;
  const neu = { id: uid(), query: "", label: "", lat: null, lng: null };
  if (destLike && stops.length >= 2) stops.splice(stops.length - 1, 0, neu);
  else stops.push(neu);
  renderStops();
  scheduleSave();
  const inputs = $("stopList").querySelectorAll("input");
  (destLike ? inputs[inputs.length - 2] : inputs[inputs.length - 1])?.focus();
};

$("btnPaste").onclick = () => openSheet("Paste addresses", pasteBody());
$("btnBack").onclick = async () => {
  hideSuggest();
  await saveTrip();
  showList();
  loadTrips().catch(() => {});
};
$("tripTitle").addEventListener("input", () => {
  state.trip.title = $("tripTitle").value;
  scheduleSave();
});
$("tripSearch").addEventListener("input", (e) => {
  state.filter = e.target.value;
  renderList();
});
$("btnNew").onclick = () => newTrip().catch((e) => toast(e.message));
$("tripList").onclick = (e) => {
  const row = e.target.closest("[data-id]");
  if (row) openTrip(row.dataset.id).catch((err) => toast(err.message));
};

$("btnOptimize").onclick = () => {
  if (geocodedStops().length < 3) {
    toast("Add at least 3 places to optimize");
    return;
  }
  routeNow(true);
};
$("btnStart").onclick = () => startNav();
$("btnMore").onclick = () => openSheet("Trip options", moreBody());
$("sheetBack").onclick = closeSheet;

function openSheet(title, html) {
  $("sheetTitle").textContent = title;
  $("sheetBody").innerHTML = html;
  $("sheet").classList.remove("hidden");
  $("sheet").setAttribute("aria-hidden", "false");
}
function closeSheet() {
  $("sheet").classList.add("hidden");
  $("sheet").setAttribute("aria-hidden", "true");
}

function pasteBody() {
  return `
    <p class="hint">One address per line. They’ll auto-complete and drop onto the route — no 10-stop cap.</p>
    <textarea id="pasteBox" placeholder="12 Queen St, Brisbane&#10;200 George St, Sydney&#10;Federation Square, Melbourne"></textarea>
    <div class="bottom-row" style="margin-top:12px">
      <button type="button" class="btn primary" id="pasteGo">Add them</button>
      <button type="button" class="btn ghost" id="pasteCancel">Cancel</button>
    </div>`;
}

function moreBody() {
  const t = state.trip;
  return `
    <button type="button" class="sheet-btn" data-more="round">${t.roundtrip ? "✓ " : ""}Round trip</button>
    <button type="button" class="sheet-btn" data-more="ends">${t.keepEnds ? "✓ " : ""}Keep start &amp; end when optimizing</button>
    <button type="button" class="sheet-btn" data-more="apple">Open in Apple Maps</button>
    <button type="button" class="sheet-btn" data-more="google">Open in Google Maps (first 10 legs)</button>
    <button type="button" class="sheet-btn bad" data-more="del">Delete trip</button>`;
}

$("sheetBody").addEventListener("click", async (e) => {
  if (e.target.id === "pasteCancel") return closeSheet();
  if (e.target.id === "pasteGo") return pasteAddresses();
  const more = e.target.closest("[data-more]");
  if (!more) return;
  const act = more.dataset.more;
  if (act === "round") {
    state.trip.roundtrip = !state.trip.roundtrip;
    closeSheet();
    renderStops();
    scheduleSave();
    routeNow(false);
  }
  if (act === "ends") {
    state.trip.keepEnds = !state.trip.keepEnds;
    closeSheet();
    scheduleSave();
    toast(state.trip.keepEnds ? "Start and end stay put" : "Best overall order");
  }
  if (act === "apple") {
    closeSheet();
    openExternal("apple");
  }
  if (act === "google") {
    closeSheet();
    openExternal("google");
  }
  if (act === "del") {
    const id = state.trip.id;
    setRecords((state.records || readLocal()).filter((t) => t.id !== id));
    api(`/api/trips/${id}`, { method: "DELETE" }).catch(() => {});
    closeSheet();
    state.trip = null;
    showList();
    renderList();
  }
});

async function pasteAddresses() {
  const text = $("pasteBox")?.value || "";
  const lines = text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!lines.length) return;
  closeSheet();
  toast(`Finding ${lines.length} addresses…`);
  try {
    const data = await api("/api/geocode", {
      method: "POST",
      body: JSON.stringify({
        lines,
        lat: state.here?.lat ?? state.bias.lat,
        lng: state.here?.lng ?? state.bias.lng,
      }),
    });
    const existing = filledStops();
    const startEmpty = existing.length === 0;
    const built = (data.results || []).map((r) => ({
      id: uid(),
      query: r.hit?.label || r.query,
      label: r.hit?.label || r.query,
      lat: r.hit?.lat ?? null,
      lng: r.hit?.lng ?? null,
    }));
    if (startEmpty) state.trip.stops = built.length >= 2 ? built : [...built, { id: uid(), query: "", label: "", lat: null, lng: null }];
    else {
      const dest = state.trip.stops[state.trip.stops.length - 1];
      state.trip.stops.splice(state.trip.stops.length - 1, 0, ...built);
      if (!(dest.label || dest.query)) state.trip.stops.pop();
    }
    const missed = built.filter((s) => !s.lat).length;
    renderStops();
    scheduleSave();
    await routeNow(false);
    toast(missed ? `Added ${built.length}. ${missed} need a tap to fix.` : `Added ${built.length} stops`);
  } catch (err) {
    toast(err.message);
  }
}

async function routeNow(optimize) {
  const pts = geocodedStops();
  if (pts.length < 2) {
    state.route = null;
    drawMap();
    updateEta();
    return;
  }
  try {
    const data = await api("/api/route", {
      method: "POST",
      body: JSON.stringify({
        points: pts.map((p) => ({ lat: p.lat, lng: p.lng })),
        optimize,
        roundtrip: state.trip.roundtrip,
        keepEnds: state.trip.keepEnds !== false,
      }),
    });
    if (optimize && Array.isArray(data.order) && data.order.length === pts.length) {
      const ids = pts.map((p) => p.id);
      const nextIds = data.order.map((i) => ids[i]);
      const byId = Object.fromEntries(state.trip.stops.map((s) => [s.id, s]));
      const rest = state.trip.stops.filter((s) => !ids.includes(s.id));
      state.trip.stops = [...nextIds.map((id) => byId[id]), ...rest];
      renderStops();
      scheduleSave();
      toast("Stops reordered for a shorter drive");
    }
    state.route = data;
    drawMap();
    updateEta();
  } catch (err) {
    toast(err.message);
    updateEta();
  }
}

function ensureMap() {
  if (state.map) return;
  state.map = L.map("map", { zoomControl: false, attributionControl: true }).setView([state.bias.lat, state.bias.lng], 11);
  L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
    maxZoom: 20,
    attribution: "&copy; OSM &copy; CARTO",
  }).addTo(state.map);
}

function drawMap() {
  ensureMap();
  state.markers.forEach((m) => m.remove());
  state.markers = [];
  if (state.line) {
    state.line.remove();
    state.line = null;
  }
  const pts = geocodedStops();
  pts.forEach((s, i) => {
    const last = i === pts.length - 1 && !state.trip?.roundtrip;
    const cls = i === 0 ? "origin" : last ? "dest" : "";
    const icon = L.divIcon({
      className: "",
      html: `<div class="num-marker ${cls}">${i + 1}</div>`,
      iconSize: [26, 26],
      iconAnchor: [13, 13],
    });
    state.markers.push(L.marker([s.lat, s.lng], { icon }).addTo(state.map).bindTooltip(s.label || s.query));
  });
  if (state.route?.geometry?.length) {
    state.line = L.polyline(state.route.geometry, { color: "#1a73e8", weight: 5, opacity: 0.92 }).addTo(state.map);
    state.map.fitBounds(state.line.getBounds(), {
      paddingTopLeft: [24, 200],
      paddingBottomRight: [24, 180],
    });
  } else if (pts.length === 1) {
    state.map.setView([pts[0].lat, pts[0].lng], 14);
  } else if (pts.length > 1) {
    state.map.fitBounds(L.latLngBounds(pts.map((p) => [p.lat, p.lng])), {
      paddingTopLeft: [24, 200],
      paddingBottomRight: [24, 180],
    });
  }
  setTimeout(() => state.map.invalidateSize(), 80);
}

function mapsQuery(s) {
  if (Number.isFinite(s.lat) && Number.isFinite(s.lng)) return `${s.lat},${s.lng}`;
  return encodeURIComponent(s.label || s.query);
}

function startNav() {
  const pts = geocodedStops();
  if (pts.length < 2) return;
  const daddr = mapsQuery(pts[1]);
  const saddr = mapsQuery(pts[0]);
  location.href = `https://maps.apple.com/?saddr=${saddr}&daddr=${daddr}&dirflg=d`;
}

function openExternal(kind) {
  const pts = geocodedStops();
  if (pts.length < 2) return toast("Need a route first");
  if (kind === "apple") {
    const dests = pts.slice(1).map((p) => `daddr=${mapsQuery(p)}`).join("&");
    location.href = `https://maps.apple.com/?saddr=${mapsQuery(pts[0])}&${dests}&dirflg=d`;
    return;
  }
  const origin = mapsQuery(pts[0]);
  const dest = mapsQuery(pts[pts.length - 1]);
  const mid = pts.slice(1, -1).slice(0, 8).map((p) => mapsQuery(p)).join("|");
  const u = new URL("https://www.google.com/maps/dir/");
  u.searchParams.set("api", "1");
  u.searchParams.set("origin", origin);
  u.searchParams.set("destination", dest);
  u.searchParams.set("travelmode", "driving");
  if (mid) u.searchParams.set("waypoints", mid);
  location.href = u.toString();
}

$("tripScreen").addEventListener("scroll", hideSuggest, true);
document.addEventListener("click", (e) => {
  if (e.target.closest("#suggestPop") || e.target.closest(".stop-row input")) return;
  hideSuggest();
});

navigator.geolocation?.getCurrentPosition(
  (pos) => {
    state.here = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    state.bias = { ...state.here };
    if (!state.trip) ensureMap();
    if (state.map && geocodedStops().length < 2) state.map.setView([state.here.lat, state.here.lng], 12);
  },
  () => {},
  { enableHighAccuracy: true, timeout: 8000 },
);

ensureMap();
loadTrips().catch((e) => toast(e.message));
