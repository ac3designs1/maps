/* global L */
const $ = (id) => document.getElementById(id);
const STORE_KEY = "maps.trips.v1";
const PINS_KEY = "maps.pins.v1";
const LAST_KEY = "maps.lastTrip";

const state = {
  trips: [],
  records: [],
  trip: null,
  filter: "",
  bias: { lat: -33.8688, lng: 151.2093 },
  here: null,
  hereLabel: "Your location",
  focusId: null,
  suggestTimer: 0,
  suggestAc: null,
  saveTimer: 0,
  routeTimer: 0,
  routeSeq: 0,
  route: null,
  routing: false,
  map: null,
  line: null,
  markers: [],
  hereDot: null,
  snap: "mid",
  navI: 0,
  navigating: false,
  undo: null,
};

function buzz(ms = 8) {
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* ignore */
  }
}

function toast(msg, undoFn) {
  const el = $("toast");
  $("toastMsg").textContent = msg;
  const act = $("toastAct");
  if (undoFn) {
    state.undo = undoFn;
    act.classList.remove("hidden");
    act.textContent = "Undo";
  } else {
    state.undo = null;
    act.classList.add("hidden");
  }
  el.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    el.classList.add("hidden");
    state.undo = null;
    act.classList.add("hidden");
  }, undoFn ? 4500 : 2400);
}

$("toastAct").onclick = () => {
  if (state.undo) {
    state.undo();
    state.undo = null;
    $("toastAct").classList.add("hidden");
    $("toast").classList.add("hidden");
  }
};

async function api(path, opts = {}) {
  const ac = opts.signal || new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeout || 22000);
  try {
    const res = await fetch(path, {
      ...opts,
      signal: ac.signal,
      headers: { Accept: "application/json", "Content-Type": "application/json", ...(opts.headers || {}) },
    });
    const text = await res.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new Error("Server error");
    }
    if (!res.ok) throw new Error(data.error || "Something went wrong");
    return data;
  } catch (err) {
    if (err?.name === "AbortError") throw Object.assign(new Error("cancelled"), { cancelled: true });
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function filledStops(trip = state.trip) {
  return (trip?.stops || []).filter((s) => (s.label || s.query || "").trim());
}

function geocodedStops(trip = state.trip) {
  return (trip?.stops || []).filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lng));
}

function titleFromStops(trip) {
  const f = filledStops(trip);
  if (f.length < 2) return trip.title && trip.title !== "Untitled trip" ? trip.title : "Untitled trip";
  return `${(f[0].label || f[0].query).split(",")[0]} → ${(f[f.length - 1].label || f[f.length - 1].query).split(",")[0]}`;
}

function fmtDur(s) {
  if (!s) return "";
  const m = Math.round(s / 60);
  if (m < 1) return "<1 min";
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} hr ${r} min` : `${h} hr`;
}

function fmtKm(m) {
  if (!m && m !== 0) return "";
  if (m < 950) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(m >= 100000 ? 0 : 1)} km`;
}

function relTime(ts) {
  const d = Date.now() - ts;
  if (d < 60_000) return "Just now";
  if (d < 3600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86400_000) return `${Math.floor(d / 3600_000)}h ago`;
  return new Date(ts).toLocaleDateString();
}

function esc(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/"/g, "&quot;");
}

function dedupeClientHits(hits) {
  const out = [];
  for (const h of hits) {
    const dup = out.some((p) => {
      const dlat = (h.lat - p.lat) * 111000;
      const dlng = (h.lng - p.lng) * 111000 * Math.cos((h.lat * Math.PI) / 180);
      const dm = Math.sqrt(dlat * dlat + dlng * dlng);
      if (dm < 35) return true;
      const norm = (s) =>
        String(s || "")
          .toLowerCase()
          .replace(/[^\w\s]/g, " ")
          .replace(/\s+/g, " ")
          .trim();
      const a = norm(h.label);
      const b = norm(p.label);
      if (a && a === b) return true;
      const na = norm(h.name || h.label.split(",")[0]);
      const nb = norm(p.name || p.label.split(",")[0]);
      return dm < 80 && na && na === nb;
    });
    if (!dup) out.push(h);
  }
  return out;
}

function showList() {
  $("listScreen").classList.remove("hidden");
  $("tripScreen").classList.add("hidden");
  hideSuggest();
}

function showTrip() {
  $("listScreen").classList.add("hidden");
  $("tripScreen").classList.remove("hidden");
  setSnap(state.snap || "mid");
  requestAnimationFrame(() => {
    state.map?.invalidateSize();
    drawMap(true);
  });
}

function setSnap(which) {
  state.snap = which;
  const el = $("plannerSheet");
  el.classList.remove("snap-collapsed", "snap-mid", "snap-full");
  el.classList.add(`snap-${which}`);
  setTimeout(() => state.map?.invalidateSize(), 200);
  const previewBtn = $("btnPreview");
  if (previewBtn) {
    previewBtn.classList.toggle("active", which !== "full");
    previewBtn.innerHTML =
      which === "full"
        ? `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 9v12"/></svg> Map`
        : `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 9v12"/></svg> List`;
  }
}

function readPins() {
  try {
    return JSON.parse(localStorage.getItem(PINS_KEY) || "{}");
  } catch {
    return {};
  }
}

function writePins(pins) {
  try {
    localStorage.setItem(PINS_KEY, JSON.stringify(pins));
  } catch {
    /* ignore */
  }
}

function pinHit(key) {
  const p = readPins()[key];
  if (!p || !Number.isFinite(p.lat)) return null;
  return { label: p.label, lat: p.lat, lng: p.lng, kind: "pin", name: p.label.split(",")[0] };
}

function setPin(key, hit) {
  const pins = readPins();
  pins[key] = { label: hit.label, lat: hit.lat, lng: hit.lng };
  writePins(pins);
}

function summarize(t) {
  const filled = (t.stops || []).filter((s) => s.label || s.query);
  return {
    id: t.id,
    title: t.title,
    updatedAt: t.updatedAt,
    createdAt: t.createdAt,
    stopCount: filled.length,
    preview: filled.slice(0, 3).map((s) => s.label || s.query).join(" → "),
    distanceM: t.distanceM || 0,
    durationS: t.durationS || 0,
    starred: !!t.starred,
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
    avoidTolls: false,
    avoidFerries: false,
    starred: false,
    createdAt: now,
    updatedAt: now,
    stops: [
      { id: uid(), query: "", label: "", lat: null, lng: null },
      { id: uid(), query: "", label: "", lat: null, lng: null },
    ],
  };
}

function rememberLast(id) {
  try {
    if (id) localStorage.setItem(LAST_KEY, id);
  } catch {
    /* ignore */
  }
}

function renderContinue() {
  const card = $("continueCard");
  const lastId = localStorage.getItem(LAST_KEY);
  const trip = lastId && (state.records || []).find((t) => t.id === lastId);
  if (!trip || $("tripScreen").classList.contains("hidden") === false) {
    card.classList.add("hidden");
    return;
  }
  card.className = "continue";
  card.innerHTML = `<strong>Continue</strong><span>${esc(trip.title || "Untitled trip")} · ${filledStops(trip).length} stops</span>`;
  card.onclick = () => openTrip(trip.id);
  card.classList.remove("hidden");
}

function setRecords(trips) {
  state.records = trips;
  writeLocal(trips);
  state.trips = trips.map(summarize);
}

function renderList() {
  const q = state.filter.trim().toLowerCase();
  const rows = state.trips
    .filter((t) => !q || `${t.title} ${t.preview}`.toLowerCase().includes(q))
    .sort((a, b) => (a.starred ? 0 : 1) - (b.starred ? 0 : 1) || b.updatedAt - a.updatedAt);
  $("tripEmpty").classList.toggle("hidden", rows.length > 0);
  $("tripList").innerHTML = rows
    .map((t) => {
      const stats = t.durationS ? fmtDur(t.durationS) : relTime(t.updatedAt);
      const star = t.starred ? '<span class="star">★</span> ' : "";
      return `<button type="button" class="trip-row" data-id="${t.id}">
        <span class="pin">${t.stopCount || 0}</span>
        <span>
          <strong>${star}${esc(t.title || "Untitled trip")}</strong>
          <span class="preview">${esc(t.preview || "No stops yet")}</span>
        </span>
        <span class="meta">${esc(stats)}<br>${t.stopCount || 0} stops</span>
        <span class="chev">›</span>
      </button>`;
    })
    .join("");
  renderContinue();
}

async function loadTrips() {
  let records = readLocal();
  try {
    const data = await api("/api/trips");
    records = mergeTrips(records, data.records || []);
  } catch {
    /* offline is fine */
  }
  setRecords(records);
  renderList();
}

function openTrip(id) {
  const raw = (state.records || readLocal()).find((t) => t.id === id);
  if (!raw) return toast("Trip not found");
  const base = emptyTrip();
  state.trip = {
    ...base,
    ...raw,
    stops: raw.stops?.length ? raw.stops : base.stops,
  };
  state.route = null;
  state.navigating = false;
  state.navI = 0;
  rememberLast(id);
  syncStops(true);
  showTrip();
  scheduleRoute(false);
}

function newTrip() {
  buzz();
  const trip = emptyTrip();
  setRecords([trip, ...(state.records || readLocal()).filter((t) => t.id !== trip.id)]);
  state.trip = trip;
  state.route = null;
  state.navigating = false;
  syncStops(true);
  renderList();
  showTrip();
  setSnap("full");
  api("/api/trips/" + trip.id, { method: "PUT", body: JSON.stringify({ trip }) }).catch(() => {});
  setTimeout(() => $("stopList").querySelector("input")?.focus(), 220);
}

function scheduleSave() {
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(saveTrip, 400);
}

function saveTrip() {
  if (!state.trip) return;
  if (!state.trip.title || state.trip.title === "Untitled trip") state.trip.title = titleFromStops(state.trip);
  if (state.route) {
    state.trip.distanceM = state.route.distanceM;
    state.trip.durationS = state.route.durationS;
  }
  state.trip.updatedAt = Date.now();
  setRecords(mergeTrips([state.trip], state.records || readLocal()));
  renderList();
  rememberLast(state.trip.id);
  api(`/api/trips/${state.trip.id}`, { method: "PUT", body: JSON.stringify({ trip: state.trip }) }).catch(() => {});
}

function hideSuggest() {
  $("suggestPop").classList.add("hidden");
  $("suggestPop").innerHTML = "";
  $("tripScreen").classList.remove("suggest-open");
}

function activeStopInput() {
  if (state.focusId) return $("stopList").querySelector(`input[data-id="${state.focusId}"]`);
  const active = document.activeElement;
  return active?.matches?.(".stop-row input") ? active : null;
}

function scrollStopForSuggest(input) {
  const list = $("stopList");
  const row = input?.closest(".stop-row");
  if (!list || !row) return;
  const listRect = list.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  const target = rowRect.top - listRect.top + list.scrollTop - 6;
  list.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
}

function placeSuggest() {
  const pop = $("suggestPop");
  const input = activeStopInput();
  if (!input || pop.classList.contains("hidden")) return;

  scrollStopForSuggest(input);

  requestAnimationFrame(() => {
    const inputRect = input.getBoundingClientRect();
    const popH = Math.min(280, Math.max(pop.offsetHeight || 160, 120));
    const gap = 6;
    const kb = Number.parseInt(getComputedStyle(document.documentElement).getPropertyValue("--kb")) || 0;
    const sat = Number.parseInt(getComputedStyle(document.documentElement).getPropertyValue("--sat")) || 0;
    const safeBottom = window.innerHeight - kb - 12;
    const spaceBelow = safeBottom - inputRect.bottom - gap;
    const spaceAbove = inputRect.top - gap - (54 + sat);

    let top;
    let maxH;
    if (spaceBelow >= 100 || spaceBelow >= spaceAbove) {
      top = inputRect.bottom + gap;
      maxH = Math.min(280, Math.max(100, spaceBelow));
    } else {
      maxH = Math.min(280, Math.max(100, spaceAbove));
      top = inputRect.top - maxH - gap;
    }

    pop.style.top = `${Math.max(8, top)}px`;
    pop.style.maxHeight = `${maxH}px`;
  });
}

async function lookup(q) {
  state.suggestAc?.abort();
  state.suggestAc = new AbortController();
  const u = new URL("/api/suggest", location.origin);
  u.searchParams.set("q", q);
  u.searchParams.set("lat", String(state.here?.lat ?? state.bias.lat));
  u.searchParams.set("lon", String(state.here?.lng ?? state.bias.lng));
  const data = await api(u.pathname + u.search, { signal: state.suggestAc.signal, timeout: 14000 });
  return data.hits || [];
}

function applyHit(stop, hit) {
  stop.query = hit.label;
  stop.label = hit.label;
  stop.lat = hit.lat;
  stop.lng = hit.lng;
}

async function onSuggestPick(hit) {
  const stop = state.trip?.stops.find((s) => s.id === state.focusId);
  if (!stop) return;
  applyHit(stop, hit);
  hideSuggest();
  const input = $("stopList").querySelector(`input[data-id="${stop.id}"]`);
  if (input) {
    input.value = hit.label;
    input.classList.remove("unresolved");
  }
  updateRowMeta();
  scheduleSave();
  scheduleRoute(false);
  buzz();
}

function stopKind(i, n) {
  if (i === 0) return "origin";
  if (i === n - 1 && !state.trip.roundtrip) return "dest";
  return "";
}

function placeholder(i, n) {
  if (i === 0) return "Address or business";
  if (i === n - 1 && !state.trip.roundtrip) return "Address or business";
  return "Address or business";
}

function makeRow(s, i, n) {
  const row = document.createElement("div");
  row.className = `stop-row ${stopKind(i, n)}`;
  row.dataset.id = s.id;
  row.innerHTML = `
    <div class="rail"><span class="num">${i + 1}</span></div>
    <div class="stop-main">
      <input data-id="${s.id}" value="${esc(s.query || s.label)}" placeholder="${placeholder(i, n)}" autocomplete="off" autocorrect="on" spellcheck="true" />
      <span class="leg"></span>
    </div>
    <button type="button" class="grip" data-act="grip" data-id="${s.id}" aria-label="Reorder">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><circle cx="8" cy="7" r="1.4"/><circle cx="16" cy="7" r="1.4"/><circle cx="8" cy="12" r="1.4"/><circle cx="16" cy="12" r="1.4"/><circle cx="8" cy="17" r="1.4"/><circle cx="16" cy="17" r="1.4"/></svg>
    </button>
    <button type="button" class="icon-tiny" data-act="del" data-id="${s.id}" aria-label="Remove">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18"/></svg>
    </button>`;
  bindStopInput(row.querySelector("input"));
  return row;
}

function updateRowMeta() {
  if (!state.trip) return;
  const n = state.trip.stops.length;
  [...$("stopList").children].forEach((row, i) => {
    const s = state.trip.stops[i];
    if (!s) return;
    row.className = `stop-row ${stopKind(i, n)}${row.classList.contains("dragging") ? " dragging" : ""}`;
    row.querySelector(".num").textContent = String(i + 1);
    const input = row.querySelector("input");
    input.placeholder = placeholder(i, n);
    if (document.activeElement !== input) {
      const val = s.query || s.label || "";
      if (input.value !== val) input.value = val;
    }
    input.classList.toggle("unresolved", !!(input.value && !Number.isFinite(s.lat)));
    const leg = state.route?.legs?.[i - 1];
    row.querySelector(".leg").textContent = i > 0 && leg ? `${fmtDur(leg.durationS)} · ${fmtKm(leg.distanceM)}` : "";
  });
  updateEta();
  updateNav();
}

function syncStops(force) {
  const list = $("stopList");
  const trip = state.trip;
  if (!trip) {
    list.innerHTML = "";
    return;
  }
  const ids = trip.stops.map((s) => s.id);
  const existing = [...list.children];
  if (force || existing.map((r) => r.dataset.id).join() !== ids.join()) {
    const map = new Map(existing.map((r) => [r.dataset.id, r]));
    const next = [];
    trip.stops.forEach((s, i) => {
      const row = map.get(s.id) || makeRow(s, i, trip.stops.length);
      map.delete(s.id);
      next.push(row);
    });
    map.forEach((r) => r.remove());
    next.forEach((r) => list.appendChild(r));
  }
  updateRowMeta();
}

function updateEta() {
  const r = state.route;
  const n = geocodedStops().length;
  const main = $("etaMain");
  main.classList.toggle("pulse", state.routing);
  if (state.routing && n >= 2) {
    main.textContent = "Finding the drive…";
    $("etaSub").textContent = `${n} stops`;
    $("btnStart").disabled = true;
    return;
  }
  if (!r || n < 2) {
    main.textContent = n < 2 ? "Add two places" : "No route yet";
    $("etaSub").textContent = `${filledStops().length} stops · no 10-stop limit`;
    $("btnStart").disabled = true;
    return;
  }
  main.textContent = `${fmtDur(r.durationS)} · ${fmtKm(r.distanceM)}`;
  const title = state.trip.title && state.trip.title !== "Untitled trip" ? state.trip.title : `${n} stops`;
  $("etaSub").textContent = `${title}${state.trip.roundtrip ? " · round trip" : ""}`;
  $("btnStart").disabled = false;
}

function updateNav() {
  const bar = $("navBar");
  if (!state.navigating) {
    bar.classList.add("hidden");
    return;
  }
  const pts = geocodedStops();
  if (state.navI >= pts.length - 1) {
    $("navTitle").textContent = "Trip complete";
    $("navSub").textContent = "Every stop is done";
    $("btnNext").textContent = "Done";
    bar.classList.remove("hidden");
    return;
  }
  const next = pts[state.navI + 1];
  const leg = state.route?.legs?.[state.navI];
  $("navTitle").textContent = `Stop ${state.navI + 2} of ${pts.length}`;
  $("navSub").textContent = `${(next.label || next.query).split(",")[0]}${leg ? " · " + fmtDur(leg.durationS) : ""}`;
  $("btnNext").textContent = "Go";
  bar.classList.remove("hidden");
}

function bindStopInput(input) {
  if (input.dataset.bound) return;
  input.dataset.bound = "1";
  const id = input.dataset.id;
  input.addEventListener("focus", () => {
    state.focusId = id;
    setSnap("full");
    requestAnimationFrame(() => scrollStopForSuggest(input));
    if (state.here && !input.value) showHereSuggest();
  });
  input.addEventListener("input", () => {
    const stop = state.trip.stops.find((s) => s.id === id);
    if (!stop) return;
    stop.query = input.value;
    stop.lat = null;
    stop.lng = null;
    stop.label = "";
    input.classList.toggle("unresolved", !!input.value.trim());
    clearTimeout(state.suggestTimer);
    const q = input.value.trim();
    if (q.length < 2) {
      if (state.here && !q) showHereSuggest();
      else hideSuggest();
      return;
    }
    state.suggestTimer = setTimeout(async () => {
      try {
        const hits = dedupeClientHits(await lookup(q));
        if (state.focusId !== id) return;
        if (!hits.length) return hideSuggest();
        $("suggestPop").innerHTML = hits
          .map((h, i) => {
            const title = esc(h.name || h.label.split(",")[0]);
            const sub = esc(h.label);
            const tag = h.kind === "business" ? "Business" : "Australia";
            return `<button type="button" data-i="${i}"><span class="ico"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 2a7 7 0 0 0-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6a2.5 2.5 0 0 1 0 5.5z"/></svg></span><span><strong>${title}</strong><small>${sub}<br>${tag}</small></span></button>`;
          })
          .join("");
        $("suggestPop")._hits = hits;
        $("suggestPop").classList.remove("hidden");
        $("tripScreen").classList.add("suggest-open");
        placeSuggest();
      } catch (err) {
        if (!err.cancelled) hideSuggest();
      }
    }, 220);
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
      if (!err.cancelled) toast(err.message);
    }
  });
}

function showHereSuggest() {
  const pins = readPins();
  const rows = [];
  if (state.here) {
    rows.push(
      `<button type="button" data-me="1"><span class="ico">◎</span><span><strong>Your location</strong><small>${esc(
        state.hereLabel,
      )}</small></span></button>`,
    );
  }
  const home = pins.home;
  const work = pins.work;
  if (home) {
    rows.push(
      `<button type="button" data-pin="home"><span class="ico">🏠</span><span><strong>Home</strong><small>${esc(
        home.label,
      )}</small></span></button>`,
    );
  }
  if (work) {
    rows.push(
      `<button type="button" data-pin="work"><span class="ico">💼</span><span><strong>Work</strong><small>${esc(
        work.label,
      )}</small></span></button>`,
    );
  }
  if (!rows.length) return;
  $("suggestPop").innerHTML = rows.join("");
  $("suggestPop").classList.remove("hidden");
  $("tripScreen").classList.add("suggest-open");
  placeSuggest();
}

$("stopList").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-act=del]");
  if (!btn || !state.trip) return;
  const i = state.trip.stops.findIndex((s) => s.id === btn.dataset.id);
  if (i < 0) return;
  buzz();
  const prev = JSON.parse(JSON.stringify(state.trip.stops));
  if (state.trip.stops.length <= 2) {
    state.trip.stops[i] = { id: uid(), query: "", label: "", lat: null, lng: null };
  } else state.trip.stops.splice(i, 1);
  syncStops(true);
  scheduleSave();
  scheduleRoute(false);
  toast("Stop removed", () => {
    state.trip.stops = prev;
    syncStops(true);
    scheduleSave();
    scheduleRoute(false);
  });
});

$("stopList").addEventListener(
  "pointerdown",
  (e) => {
    const grip = e.target.closest(".grip");
    if (!grip || !state.trip) return;
    e.preventDefault();
    const row = grip.closest(".stop-row");
    const list = $("stopList");
    row.classList.add("dragging");
    const move = (ev) => {
      const y = ev.clientY;
      const others = [...list.querySelectorAll(".stop-row")].filter((r) => r !== row);
      let placed = false;
      for (const r of others) {
        const b = r.getBoundingClientRect();
        if (y < b.top + b.height / 2) {
          list.insertBefore(row, r);
          placed = true;
          break;
        }
      }
      if (!placed) list.appendChild(row);
    };
    const up = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      row.classList.remove("dragging");
      const byId = Object.fromEntries(state.trip.stops.map((s) => [s.id, s]));
      state.trip.stops = [...list.querySelectorAll(".stop-row")].map((r) => byId[r.dataset.id]).filter(Boolean);
      updateRowMeta();
      scheduleSave();
      scheduleRoute(false);
      buzz();
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  },
  { passive: false },
);

$("suggestPop").addEventListener("click", async (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  if (btn.dataset.me) {
    if (!state.here) return toast("Turn on Location to use GPS");
    await onSuggestPick({ label: state.hereLabel, lat: state.here.lat, lng: state.here.lng });
    return;
  }
  if (btn.dataset.pin) {
    const hit = pinHit(btn.dataset.pin);
    if (!hit) return toast("Set this in More → Places");
    await onSuggestPick(hit);
    return;
  }
  const hit = ($("suggestPop")._hits || [])[Number(btn.dataset.i)];
  if (hit) await onSuggestPick(hit);
});

$("btnAddStop").onclick = () => {
  const stops = state.trip.stops;
  const destLike = !state.trip.roundtrip && stops.length >= 2;
  const neu = { id: uid(), query: "", label: "", lat: null, lng: null };
  if (destLike) stops.splice(stops.length - 1, 0, neu);
  else stops.push(neu);
  syncStops(true);
  scheduleSave();
  setSnap("full");
  const inputs = $("stopList").querySelectorAll("input");
  (destLike ? inputs[inputs.length - 2] : inputs[inputs.length - 1])?.focus();
};

$("btnPaste").onclick = () => openModal("Paste addresses", pasteBody());
$("btnReverse").onclick = () => {
  state.trip.stops.reverse();
  syncStops(true);
  scheduleSave();
  scheduleRoute(false);
  toast("Start and finish swapped");
};
$("btnOptimize").onclick = () => {
  if (geocodedStops().length < 3) return toast("Add at least 3 places first");
  $("btnOptimize").classList.add("busy");
  scheduleRoute(true);
};
$("btnShare").onclick = () => shareTrip();
$("btnMore").onclick = () => openModal("Trip", moreBody());

$("btnPreview").onclick = () => {
  const isEditing = state.snap === "full";
  if (isEditing) {
    document.activeElement?.blur();
    hideSuggest();
    setSnap("mid");
    drawMap(true);
    $("btnPreview").classList.add("active");
  } else {
    setSnap("full");
    $("btnPreview").classList.remove("active");
    setTimeout(() => $("stopList").querySelector("input")?.focus(), 180);
  }
};
$("btnBack").onclick = () => {
  hideSuggest();
  saveTrip();
  state.navigating = false;
  showList();
};
$("tripSearch").addEventListener("input", (e) => {
  state.filter = e.target.value;
  renderList();
});
$("btnNew").onclick = () => newTrip();
$("btnEmptyNew").onclick = () => newTrip();
$("tripList").onclick = (e) => {
  const row = e.target.closest("[data-id]");
  if (row) openTrip(row.dataset.id);
};

(function tripSwipeDelete() {
  const list = $("tripList");
  let sx = 0;
  let sy = 0;
  let row = null;
  list.addEventListener(
    "touchstart",
    (e) => {
      row = e.target.closest(".trip-row");
      if (!row) return;
      sx = e.changedTouches[0].clientX;
      sy = e.changedTouches[0].clientY;
    },
    { passive: true },
  );
  list.addEventListener(
    "touchend",
    (e) => {
      if (!row) return;
      const dx = e.changedTouches[0].clientX - sx;
      const dy = Math.abs(e.changedTouches[0].clientY - sy);
      if (dx < -72 && dy < 48) {
        const id = row.dataset.id;
        const prev = (state.records || []).slice();
        setRecords(prev.filter((t) => t.id !== id));
        api(`/api/trips/${id}`, { method: "DELETE" }).catch(() => {});
        renderList();
        toast("Trip deleted", () => {
          setRecords(prev);
          renderList();
        });
      }
      row = null;
    },
    { passive: true },
  );
})();
$("btnStart").onclick = () => {
  state.navigating = true;
  state.navI = 0;
  updateNav();
  drawMap(true);
  goLeg();
};
$("btnNext").onclick = () => {
  const pts = geocodedStops();
  if (state.navI >= pts.length - 1) {
    state.navigating = false;
    updateNav();
    drawMap(true);
    return;
  }
  state.navI += 1;
  updateNav();
  drawMap(true);
  if (state.navI < pts.length - 1) goLeg();
};
$("btnLocate").onclick = () => {
  if (!state.here) return toast("Location unavailable");
  state.map?.setView([state.here.lat, state.here.lng], 15);
};
$("sheetBack").onclick = closeModal;

function openModal(title, html) {
  $("sheetTitle").textContent = title;
  $("sheetBody").innerHTML = html;
  $("sheet").classList.remove("hidden");
}
function closeModal() {
  $("sheet").classList.add("hidden");
}

function pasteBody() {
  return `    <p class="hint">One per line — street addresses or company names in Australia. Woolworths, Bunnings, a job site, whatever.</p>
    <textarea id="pasteBox" placeholder="Bunnings Warehouse, Geebung&#10;12 Queen St, Brisbane&#10;Woolworths Townsville"></textarea>
    <div style="display:flex;gap:8px;margin-top:14px">
      <button type="button" class="btn primary" id="pasteGo" style="flex:1">Add them</button>
      <button type="button" class="chip" id="pasteCancel">Cancel</button>
    </div>`;
}

function moreBody() {
  const t = state.trip;
  const pins = readPins();
  return `<label class="field">Name
      <input id="renameTitle" value="${esc(t.title || "")}" />
    </label>
    <button type="button" class="sheet-btn" data-more="star">${t.starred ? "★ " : ""}Star trip</button>
    <button type="button" class="sheet-btn" data-more="round">${t.roundtrip ? "✓ " : ""}Round trip</button>
    <button type="button" class="sheet-btn" data-more="ends">${t.keepEnds ? "✓ " : ""}Keep start &amp; end when optimizing</button>
    <button type="button" class="sheet-btn" data-more="tolls">${t.avoidTolls ? "✓ " : ""}Avoid tolls</button>
    <button type="button" class="sheet-btn" data-more="ferries">${t.avoidFerries ? "✓ " : ""}Avoid ferries</button>
    <button type="button" class="sheet-btn" data-more="refresh">Refresh route</button>
    <button type="button" class="sheet-btn" data-more="clear">Clear all stops</button>
    <button type="button" class="sheet-btn" data-more="home">Set Home — ${esc((pins.home?.label || "not set").split(",")[0])}</button>
    <button type="button" class="sheet-btn" data-more="work">Set Work — ${esc((pins.work?.label || "not set").split(",")[0])}</button>
    <button type="button" class="sheet-btn" data-more="dup">Duplicate trip</button>
    <button type="button" class="sheet-btn" data-more="export">Export backup</button>
    <button type="button" class="sheet-btn" data-more="import">Import backup</button>
    <button type="button" class="sheet-btn" data-more="waze">Open in Waze</button>
    <button type="button" class="sheet-btn" data-more="google">Open in Google Maps</button>
    <button type="button" class="sheet-btn bad" data-more="del">Delete trip</button>`;
}

function shareTrip() {
  const pts = geocodedStops();
  if (pts.length < 2) return toast("Add a route first");
  const lines = pts.map((s, i) => `${i + 1}. ${s.label || s.query}`);
  const head = state.trip.title && state.trip.title !== "Untitled trip" ? state.trip.title : "Trip";
  const stats = state.route ? `${fmtDur(state.route.durationS)} · ${fmtKm(state.route.distanceM)}` : "";
  const sharePayload = {
    title: head,
    stops: pts.map((s) => ({ label: s.label || s.query, lat: s.lat, lng: s.lng })),
  };
  const imp = encodeURIComponent(JSON.stringify(sharePayload));
  const link = imp.length < 1800 ? `${location.origin}${location.pathname}?import=${imp}` : "";
  const text = `${head}\n${stats}\n\n${lines.join("\n")}${link ? `\n\n${link}` : ""}`;
  if (navigator.share) {
    navigator.share({ title: head, text, url: link || undefined }).catch(() => {});
    return;
  }
  navigator.clipboard?.writeText(text).then(() => toast(link ? "Copied trip + link" : "Copied to clipboard"));
}

function importBackupFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(String(reader.result || "{}"));
      const incoming = Array.isArray(data.trips) ? data.trips : data.stops ? [data] : [];
      if (!incoming.length) return toast("No trips in file");
      const normalized = incoming.map((t) => {
        const trip = emptyTrip();
        return {
          ...trip,
          ...t,
          id: uid(),
          stops: (t.stops || []).map((s) => ({
            id: uid(),
            query: s.label || s.query || "",
            label: s.label || s.query || "",
            lat: s.lat ?? null,
            lng: s.lng ?? null,
          })),
          updatedAt: Date.now(),
          createdAt: t.createdAt || Date.now(),
        };
      });
      if (data.pins && typeof data.pins === "object") writePins({ ...readPins(), ...data.pins });
      setRecords(mergeTrips(normalized, state.records || readLocal()));
      renderList();
      toast(`Imported ${normalized.length} trip${normalized.length === 1 ? "" : "s"}`);
    } catch {
      toast("Couldn’t read that file");
    }
  };
  reader.readAsText(file);
}

function pickBackupFile() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "application/json,.json";
  input.onchange = () => {
    const file = input.files?.[0];
    if (file) importBackupFile(file);
  };
  input.click();
}

function exportBackup() {
  const blob = new Blob([JSON.stringify({ trips: state.records || readLocal(), pins: readPins() }, null, 2)], {
    type: "application/json",
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `trips-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast("Backup saved");
}

$("sheetBody").addEventListener("click", (e) => {
  if (e.target.id === "pasteCancel") return closeModal();
  if (e.target.id === "pasteGo") return pasteAddresses();
  const more = e.target.closest("[data-more]");
  if (!more) return;
  const act = more.dataset.more;
  if (act === "star") {
    state.trip.starred = !state.trip.starred;
    closeModal();
    scheduleSave();
    renderList();
    toast(state.trip.starred ? "Starred" : "Unstarred");
  }
  if (act === "tolls") {
    state.trip.avoidTolls = !state.trip.avoidTolls;
    closeModal();
    scheduleSave();
    scheduleRoute(false);
  }
  if (act === "ferries") {
    state.trip.avoidFerries = !state.trip.avoidFerries;
    closeModal();
    scheduleSave();
    scheduleRoute(false);
  }
  if (act === "refresh") {
    closeModal();
    scheduleRoute(false);
    toast("Refreshing route…");
  }
  if (act === "clear") {
    closeModal();
    const prev = JSON.parse(JSON.stringify(state.trip.stops));
    state.trip.stops = [
      { id: uid(), query: "", label: "", lat: null, lng: null },
      { id: uid(), query: "", label: "", lat: null, lng: null },
    ];
    syncStops(true);
    scheduleSave();
    scheduleRoute(false);
    toast("Stops cleared", () => {
      state.trip.stops = prev;
      syncStops(true);
      scheduleSave();
      scheduleRoute(false);
    });
  }
  if (act === "home" || act === "work") {
    const pts = geocodedStops();
    const last = filledStops().slice(-1)[0];
    const src = pts.find((s) => s.label || s.query) || last;
    if (!src?.lat) return toast("Pick a place on the map first");
    setPin(act, { label: src.label || src.query, lat: src.lat, lng: src.lng });
    closeModal();
    toast(act === "home" ? "Home saved" : "Work saved");
  }
  if (act === "export") {
    closeModal();
    exportBackup();
  }
  if (act === "import") {
    closeModal();
    pickBackupFile();
  }
  if (act === "round") {
    state.trip.roundtrip = !state.trip.roundtrip;
    closeModal();
    syncStops(true);
    scheduleSave();
    scheduleRoute(false);
  }
  if (act === "ends") {
    state.trip.keepEnds = !state.trip.keepEnds;
    closeModal();
    toast(state.trip.keepEnds ? "Start and end stay put" : "Best overall order");
    scheduleSave();
  }
  if (act === "dup") {
    const copy = JSON.parse(JSON.stringify(state.trip));
    copy.id = uid();
    copy.title = `${copy.title || "Trip"} copy`;
    copy.createdAt = Date.now();
    copy.updatedAt = Date.now();
    copy.stops = (copy.stops || []).map((s) => ({ ...s, id: uid() }));
    setRecords([copy, ...(state.records || [])]);
    closeModal();
    openTrip(copy.id);
    toast("Duplicated");
  }
  if (act === "waze") {
    closeModal();
    openExternal("waze");
  }
  if (act === "google") {
    closeModal();
    openExternal("google");
  }
  if (act === "del") {
    const id = state.trip.id;
    const prev = (state.records || readLocal()).slice();
    setRecords(prev.filter((t) => t.id !== id));
    api(`/api/trips/${id}`, { method: "DELETE" }).catch(() => {});
    closeModal();
    state.trip = null;
    showList();
    renderList();
    toast("Trip deleted", () => {
      setRecords(prev);
      renderList();
    });
  }
});
$("sheetBody").addEventListener("input", (e) => {
  if (e.target.id !== "renameTitle" || !state.trip) return;
  state.trip.title = e.target.value;
  scheduleSave();
  updateEta();
});

async function pasteAddresses() {
  const lines = ($("pasteBox")?.value || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!lines.length) return;
  closeModal();
  toast(`Finding ${lines.length} addresses…`);
  try {
    const data = await api("/api/geocode", {
      method: "POST",
      timeout: 60000,
      body: JSON.stringify({
        lines,
        lat: state.here?.lat ?? state.bias.lat,
        lng: state.here?.lng ?? state.bias.lng,
      }),
    });
    const built = (data.results || []).map((r) => ({
      id: uid(),
      query: r.hit?.label || r.query,
      label: r.hit?.label || r.query,
      lat: r.hit?.lat ?? null,
      lng: r.hit?.lng ?? null,
    }));
    if (!filledStops().length) {
      state.trip.stops = built.length >= 2 ? built : [...built, { id: uid(), query: "", label: "", lat: null, lng: null }];
    } else if (state.trip.roundtrip) {
      state.trip.stops.push(...built);
    } else {
      state.trip.stops.splice(Math.max(1, state.trip.stops.length - 1), 0, ...built);
    }
    const missed = built.filter((s) => !s.lat).length;
    syncStops(true);
    setSnap("mid");
    scheduleSave();
    scheduleRoute(false);
    toast(missed ? `Added ${built.length}. ${missed} need a tap to fix.` : `Added ${built.length} stops`);
  } catch (err) {
    if (!err.cancelled) toast(err.message);
  }
}

function scheduleRoute(optimize) {
  clearTimeout(state.routeTimer);
  state.routeTimer = setTimeout(() => routeNow(optimize), optimize ? 40 : 260);
}

async function routeNow(optimize) {
  const pts = geocodedStops();
  const seq = ++state.routeSeq;
  if (pts.length < 2) {
    state.route = null;
    state.routing = false;
    drawMap(true);
    updateRowMeta();
    return;
  }
  state.routing = true;
  updateEta();
  try {
    const data = await api("/api/route", {
      method: "POST",
      timeout: 35000,
      body: JSON.stringify({
        points: pts.map((p) => ({ lat: p.lat, lng: p.lng })),
        optimize,
        roundtrip: state.trip.roundtrip,
        keepEnds: state.trip.keepEnds !== false,
        avoidTolls: !!state.trip.avoidTolls,
        avoidFerries: !!state.trip.avoidFerries,
      }),
    });
    if (seq !== state.routeSeq) return;
    if (optimize && Array.isArray(data.order) && data.order.length === pts.length) {
      const ids = pts.map((p) => p.id);
      const byId = Object.fromEntries(state.trip.stops.map((s) => [s.id, s]));
      const rest = state.trip.stops.filter((s) => !ids.includes(s.id));
      state.trip.stops = [...data.order.map((i) => byId[ids[i]]), ...rest].filter(Boolean);
      syncStops(true);
      toast("Reordered for a shorter drive");
    }
    state.route = data;
    state.trip.distanceM = data.distanceM;
    state.trip.durationS = data.durationS;
    drawMap(true);
    updateRowMeta();
    scheduleSave();
  } catch (err) {
    if (seq !== state.routeSeq || err.cancelled) return;
    toast(err.message);
  } finally {
    if (seq === state.routeSeq) {
      state.routing = false;
      $("btnOptimize").classList.remove("busy");
      updateEta();
    }
  }
}

function ensureMap() {
  if (state.map) return;
  state.map = L.map("map", { zoomControl: false, attributionControl: false, tap: false }).setView(
    [state.bias.lat, state.bias.lng],
    11,
  );
  L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", { maxZoom: 20 }).addTo(
    state.map,
  );
}

function mapPad() {
  const h = $("tripScreen").classList.contains("hidden") ? 24 : $("plannerSheet").offsetHeight || 220;
  return { paddingTopLeft: [16, 68], paddingBottomRight: [16, h + 10] };
}

function drawMap(fit) {
  ensureMap();
  state.markers.forEach((m) => m.remove());
  state.markers = [];
  if (state.line) {
    state.line.remove();
    state.line = null;
  }
  if (state.hereDot) {
    state.hereDot.remove();
    state.hereDot = null;
  }
  const pts = geocodedStops();
  pts.forEach((s, i) => {
    const last = i === pts.length - 1 && !state.trip?.roundtrip;
    const active = state.navigating && i === Math.min(state.navI + 1, pts.length - 1);
    const cls = `${i === 0 ? "origin" : last ? "dest" : ""} ${active ? "active" : ""}`;
    const icon = L.divIcon({
      className: "",
      html: `<div class="num-marker ${cls}">${i + 1}</div>`,
      iconSize: [26, 26],
      iconAnchor: [13, 13],
    });
    const mk = L.marker([s.lat, s.lng], { icon }).addTo(state.map);
    mk.on("click", () => {
      state.focusId = s.id;
      setSnap("full");
      const input = $("stopList").querySelector(`input[data-id="${s.id}"]`);
      input?.scrollIntoView({ block: "center" });
      input?.focus();
    });
    state.markers.push(mk);
  });
  if (state.here) {
    state.hereDot = L.circleMarker([state.here.lat, state.here.lng], {
      radius: 6,
      color: "#fff",
      weight: 2,
      fillColor: "#1a73e8",
      fillOpacity: 1,
    }).addTo(state.map);
  }
  if (!fit) return;
  const pad = mapPad();
  try {
    if (state.route?.geometry?.length) {
      state.line = L.polyline(state.route.geometry, { color: "#1a73e8", weight: 5, opacity: 0.94 }).addTo(state.map);
      state.map.fitBounds(state.line.getBounds(), pad);
    } else if (pts.length === 1) state.map.setView([pts[0].lat, pts[0].lng], 14);
    else if (pts.length > 1) state.map.fitBounds(L.latLngBounds(pts.map((p) => [p.lat, p.lng])), pad);
  } catch {
    /* invalid bounds */
  }
}

function mapsQuery(s) {
  if (Number.isFinite(s.lat) && Number.isFinite(s.lng)) return `${s.lat},${s.lng}`;
  return encodeURIComponent(s.label || s.query || "");
}

function goLeg() {
  const pts = geocodedStops();
  if (state.navI >= pts.length - 1) return;
  const a = pts[state.navI];
  const b = pts[state.navI + 1];
  location.href = `https://waze.com/ul?ll=${b.lat},${b.lng}&navigate=yes`;
}

function openExternal(kind) {
  const pts = geocodedStops();
  if (pts.length < 2) return toast("Need a route first");
  if (kind === "waze") {
    const dest = pts[pts.length - 1];
    location.href = `https://waze.com/ul?ll=${dest.lat},${dest.lng}&navigate=yes`;
    return;
  }
  const u = new URL("https://www.google.com/maps/dir/");
  u.searchParams.set("api", "1");
  u.searchParams.set("origin", mapsQuery(pts[0]));
  u.searchParams.set("destination", mapsQuery(pts[pts.length - 1]));
  u.searchParams.set("travelmode", "driving");
  const mid = pts
    .slice(1, -1)
    .slice(0, 8)
    .map((p) => mapsQuery(p))
    .join("|");
  if (mid) u.searchParams.set("waypoints", mid);
  location.href = u.toString();
}

(function sheetDrag() {
  const grab = $("sheetGrab");
  const sheet = $("plannerSheet");
  grab.addEventListener(
    "pointerdown",
    (e) => {
      const startY = e.clientY;
      const startH = sheet.getBoundingClientRect().height;
      sheet.style.transition = "none";
      const move = (ev) => {
        const next = Math.min(window.innerHeight - 64, Math.max(160, startH + (startY - ev.clientY)));
        sheet.style.height = `${next}px`;
      };
      const up = (ev) => {
        document.removeEventListener("pointermove", move);
        document.removeEventListener("pointerup", up);
        sheet.style.transition = "";
        sheet.style.height = "";
        const h = startH + (startY - ev.clientY);
        const max = window.innerHeight;
        if (h < max * 0.32) setSnap("collapsed");
        else if (h > max * 0.7) setSnap("full");
        else setSnap("mid");
      };
      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", up);
    },
    { passive: true },
  );
})();

document.addEventListener("click", (e) => {
  if (e.target.closest("#suggestPop") || e.target.closest(".stop-row input")) return;
  hideSuggest();
});

if (window.visualViewport) {
  const pinKb = () => {
    const vv = window.visualViewport;
    const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    document.documentElement.style.setProperty("--kb", `${kb > 48 ? kb : 0}px`);
    if (!$("suggestPop").classList.contains("hidden")) placeSuggest();
  };
  window.visualViewport.addEventListener("resize", pinKb);
  window.visualViewport.addEventListener("scroll", pinKb);
}

function locate() {
  if (!navigator.geolocation) return;
  navigator.geolocation.watchPosition(
    async (pos) => {
      state.here = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      state.bias = { ...state.here };
      if (!state.hereLabel || state.hereLabel === "Your location") {
        try {
          const data = await api(`/api/reverse?lat=${state.here.lat}&lon=${state.here.lng}`, { timeout: 8000 });
          if (data.hit?.label) state.hereLabel = data.hit.label;
        } catch {
          /* keep default */
        }
      }
    },
    () => {},
    { enableHighAccuracy: true, maximumAge: 15000, timeout: 12000 },
  );
}

ensureMap();
locate();

function importTripFromUrl() {
  const imp = new URLSearchParams(location.search).get("import");
  if (!imp) return false;
  try {
    const raw = JSON.parse(decodeURIComponent(imp));
    const trip = emptyTrip();
    trip.title = raw.title || "Imported trip";
    trip.stops = (raw.stops || []).map((s) => ({
      id: uid(),
      query: s.label || s.query || "",
      label: s.label || s.query || "",
      lat: s.lat ?? null,
      lng: s.lng ?? null,
    }));
    if (trip.stops.length < 2) {
      trip.stops.push({ id: uid(), query: "", label: "", lat: null, lng: null });
    }
    setRecords([trip, ...(state.records || [])]);
    history.replaceState({}, "", location.pathname);
    openTrip(trip.id);
    toast("Trip imported");
    return true;
  } catch {
    return false;
  }
}

window.addEventListener("online", () => $("netBanner").classList.add("hidden"));
window.addEventListener("offline", () => $("netBanner").classList.remove("hidden"));
if (!navigator.onLine) $("netBanner").classList.remove("hidden");

loadTrips().then(() => {
  if (!importTripFromUrl()) renderContinue();
}).catch(() => {});
