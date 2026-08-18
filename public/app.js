/* global L */
const $ = (id) => document.getElementById(id);
const STORE_KEY = "maps.trips.v1";

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
  saveTimer: 0,
  routeTimer: 0,
  route: null,
  routing: false,
  map: null,
  line: null,
  markers: [],
  hereDot: null,
  snap: "mid",
  navI: 0,
  navigating: false,
};

function buzz(ms = 8) {
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* ignore */
  }
}

function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add("hidden"), 2400);
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
  return `${a} → ${b}`;
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
  if (!m) return "";
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

function showList() {
  $("listScreen").classList.remove("hidden");
  $("tripScreen").classList.add("hidden");
  $("btnLocate").classList.add("hidden");
  hideSuggest();
}

function showTrip() {
  $("listScreen").classList.add("hidden");
  $("tripScreen").classList.remove("hidden");
  $("btnLocate").classList.remove("hidden");
  setSnap(state.snap || "mid");
  requestAnimationFrame(() => {
    state.map?.invalidateSize();
    drawMap(false);
  });
}

function setSnap(which) {
  state.snap = which;
  const el = $("plannerSheet");
  el.classList.remove("snap-collapsed", "snap-mid", "snap-full");
  el.classList.add(`snap-${which}`);
  setTimeout(() => state.map?.invalidateSize(), 220);
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

function renderList() {
  const q = state.filter.trim().toLowerCase();
  const rows = state.trips.filter((t) => !q || `${t.title} ${t.preview}`.toLowerCase().includes(q));
  $("tripEmpty").classList.toggle("hidden", rows.length > 0);
  $("tripList").innerHTML = rows
    .map((t) => {
      const stats = t.durationS ? `${fmtDur(t.durationS)}` : relTime(t.updatedAt);
      return `<button type="button" class="trip-row" data-id="${t.id}">
        <span class="pin">${t.stopCount || 0}</span>
        <span>
          <strong>${esc(t.title || "Untitled trip")}</strong>
          <span class="preview">${esc(t.preview || "No stops yet")}</span>
        </span>
        <span class="meta">${esc(stats)}<br>${t.stopCount || 0} stops</span>
      </button>`;
    })
    .join("");
}

async function loadTrips() {
  let records = readLocal();
  try {
    const data = await api("/api/trips");
    records = mergeTrips(records, data.records || []);
  } catch {
    /* offline */
  }
  setRecords(records);
  renderList();
}

async function openTrip(id) {
  const trip = (state.records || readLocal()).find((t) => t.id === id);
  if (!trip) return toast("Trip not found");
  state.trip = trip;
  state.route = null;
  state.navigating = false;
  state.navI = 0;
  renderStops();
  showTrip();
  scheduleRoute(false);
}

async function newTrip() {
  buzz();
  const trip = emptyTrip();
  setRecords([trip, ...(state.records || readLocal()).filter((t) => t.id !== trip.id)]);
  state.trip = trip;
  state.route = null;
  state.navigating = false;
  renderStops();
  renderList();
  showTrip();
  setSnap("full");
  api("/api/trips/" + trip.id, { method: "PUT", body: JSON.stringify({ trip }) }).catch(() => {});
  setTimeout(() => $("stopList").querySelector("input")?.focus(), 250);
}

function scheduleSave() {
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(saveTrip, 400);
}

async function saveTrip() {
  if (!state.trip) return;
  if (!state.trip.title || state.trip.title === "Untitled trip") {
    state.trip.title = titleFromStops(state.trip);
  }
  if (state.route) {
    state.trip.distanceM = state.route.distanceM;
    state.trip.durationS = state.route.durationS;
  }
  state.trip.updatedAt = Date.now();
  setRecords(mergeTrips([state.trip], state.records || readLocal()));
  renderList();
  api(`/api/trips/${state.trip.id}`, { method: "PUT", body: JSON.stringify({ trip: state.trip }) }).catch(() => {});
}

function hideSuggest() {
  $("suggestPop").classList.add("hidden");
  $("suggestPop").innerHTML = "";
}

function placeSuggest() {
  const sheet = $("plannerSheet");
  const pop = $("suggestPop");
  const top = 8 + (parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--sat")) || 0);
  pop.style.top = Math.max(56, sheet.getBoundingClientRect().top - 8 - Math.min(280, window.innerHeight * 0.4)) + "px";
  if (sheet.getBoundingClientRect().top < 160) pop.style.top = top + 56 + "px";
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
  scheduleRoute(false);
  buzz();
}

function stopKind(i, n) {
  if (i === 0) return "origin";
  if (i === n - 1 && !state.trip.roundtrip) return "dest";
  return "";
}

function renderStops() {
  const trip = state.trip;
  if (!trip) return;
  const n = trip.stops.length;
  const focus = document.activeElement?.dataset?.id;
  const caret = document.activeElement?.selectionStart;
  $("stopList").innerHTML = trip.stops
    .map((s, i) => {
      const kind = stopKind(i, n);
      const ph = i === 0 ? "Choose start" : i === n - 1 && !trip.roundtrip ? "Choose destination" : "Add stop";
      const leg = state.route?.legs?.[i];
      const legTxt = i > 0 && leg ? `${fmtDur(leg.durationS)} · ${fmtKm(leg.distanceM)}` : i > 0 ? "" : "";
      return `<div class="stop-row ${kind}" data-id="${s.id}" data-i="${i}">
        <div class="rail"><span class="num">${i + 1}</span></div>
        <div class="stop-main">
          <input data-id="${s.id}" value="${esc(s.query || s.label)}" placeholder="${ph}" autocomplete="off" autocorrect="on" spellcheck="true" />
          <span class="leg" data-leg="${i}">${esc(legTxt)}</span>
        </div>
        <button type="button" class="grip" data-act="grip" data-id="${s.id}" aria-label="Drag to reorder">☰</button>
        <button type="button" class="icon-tiny" data-act="del" data-id="${s.id}" aria-label="Remove">×</button>
      </div>`;
    })
    .join("");
  $("stopList").querySelectorAll("input").forEach(bindStopInput);
  if (focus) {
    const input = $("stopList").querySelector(`input[data-id="${focus}"]`);
    if (input) {
      input.focus();
      try {
        input.setSelectionRange(caret, caret);
      } catch {
        /* ignore */
      }
    }
  }
  updateEta();
  updateNav();
}

function updateLegs() {
  (state.trip?.stops || []).forEach((_, i) => {
    const el = $("stopList").querySelector(`[data-leg="${i}"]`);
    if (!el) return;
    const leg = state.route?.legs?.[i - 1];
    el.textContent = i > 0 && leg ? `${fmtDur(leg.durationS)} · ${fmtKm(leg.distanceM)}` : "";
  });
}

function updateEta() {
  const r = state.route;
  const n = geocodedStops().length;
  if (state.routing && n >= 2) {
    $("etaMain").textContent = "Finding route…";
    $("etaSub").textContent = `${n} stops`;
    $("btnStart").disabled = true;
    return;
  }
  if (!r || n < 2) {
    $("etaMain").textContent = n < 2 ? "Add two places" : "No route yet";
    $("etaSub").textContent = `${filledStops().length} stops · no 10-stop limit`;
    $("btnStart").disabled = true;
    return;
  }
  $("etaMain").textContent = `${fmtDur(r.durationS)} · ${fmtKm(r.distanceM)}`;
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
    $("navSub").textContent = "You’ve hit every stop";
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
  const id = input.dataset.id;
  input.addEventListener("focus", () => {
    state.focusId = id;
    setSnap("full");
    if (state.here && !input.value) showHereSuggest();
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
      if (state.here && !q) showHereSuggest();
      else hideSuggest();
      return;
    }
    state.suggestTimer = setTimeout(async () => {
      try {
        const hits = await lookup(q);
        if (state.focusId !== id) return;
        if (!hits.length) return hideSuggest();
        $("suggestPop").innerHTML = hits
          .map(
            (h, i) =>
              `<button type="button" data-i="${i}"><span class="ico">📍</span><span><strong>${esc(
                h.label.split(",")[0],
              )}</strong><small>${esc(h.label)}</small></span></button>`,
          )
          .join("");
        $("suggestPop")._hits = hits;
        $("suggestPop").classList.remove("hidden");
        placeSuggest();
      } catch {
        hideSuggest();
      }
    }, 160);
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

function showHereSuggest() {
  $("suggestPop").innerHTML = `<button type="button" data-me="1"><span class="ico">◎</span><span><strong>Your location</strong><small>${esc(
    state.hereLabel,
  )}</small></span></button>`;
  $("suggestPop").classList.remove("hidden");
  placeSuggest();
}

$("stopList").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-act]");
  if (!btn || btn.dataset.act === "grip") return;
  const id = btn.dataset.id;
  const i = state.trip.stops.findIndex((s) => s.id === id);
  if (i < 0) return;
  if (btn.dataset.act === "del") {
    buzz();
    if (state.trip.stops.length <= 2) {
      state.trip.stops[i] = { id: uid(), query: "", label: "", lat: null, lng: null };
    } else state.trip.stops.splice(i, 1);
    renderStops();
    scheduleSave();
    scheduleRoute(false);
  }
});

$("stopList").addEventListener("pointerdown", (e) => {
  const grip = e.target.closest("[data-act=grip]");
  if (!grip) return;
  e.preventDefault();
  const row = grip.closest(".stop-row");
  const from = Number(row.dataset.i);
  row.classList.add("dragging");
  const move = (ev) => {
    const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest(".stop-row");
    if (!el || el === row) return;
    const to = Number(el.dataset.i);
    if (!Number.isFinite(to) || to === from) return;
    const [item] = state.trip.stops.splice(from, 1);
    state.trip.stops.splice(to, 0, item);
    renderStops();
    $("stopList").querySelector(`.stop-row[data-id="${item.id}"]`)?.classList.add("dragging");
    bindDragAfterRerender(item.id, move, up);
  };
  const up = () => {
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", up);
    $("stopList").querySelectorAll(".dragging").forEach((n) => n.classList.remove("dragging"));
    scheduleSave();
    scheduleRoute(false);
    buzz();
  };
  document.addEventListener("pointermove", move);
  document.addEventListener("pointerup", up);
});

function bindDragAfterRerender(id, move, up) {
  document.removeEventListener("pointermove", move);
  document.removeEventListener("pointerup", up);
  const row = $("stopList").querySelector(`.stop-row[data-id="${id}"]`);
  if (!row) return;
  const fromGetter = () => Number(row.dataset.i);
  const move2 = (ev) => {
    const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest(".stop-row");
    if (!el || el === row) return;
    const from = fromGetter();
    const to = Number(el.dataset.i);
    if (!Number.isFinite(to) || to === from) return;
    const [item] = state.trip.stops.splice(from, 1);
    state.trip.stops.splice(to, 0, item);
    renderStops();
    $("stopList").querySelector(`.stop-row[data-id="${item.id}"]`)?.classList.add("dragging");
    bindDragAfterRerender(item.id, move2, up2);
  };
  const up2 = () => {
    document.removeEventListener("pointermove", move2);
    document.removeEventListener("pointerup", up2);
    $("stopList").querySelectorAll(".dragging").forEach((n) => n.classList.remove("dragging"));
    scheduleSave();
    scheduleRoute(false);
  };
  document.addEventListener("pointermove", move2);
  document.addEventListener("pointerup", up2);
}

$("suggestPop").addEventListener("click", async (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  if (btn.dataset.me) {
    if (!state.here) return toast("Turn on location to use GPS");
    await onSuggestPick({ label: state.hereLabel, lat: state.here.lat, lng: state.here.lng });
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
  renderStops();
  scheduleSave();
  setSnap("full");
  const inputs = $("stopList").querySelectorAll("input");
  (destLike ? inputs[inputs.length - 2] : inputs[inputs.length - 1])?.focus();
};

$("btnPaste").onclick = () => openModal("Paste addresses", pasteBody());
$("btnReverse").onclick = () => {
  if (!state.trip?.stops.length) return;
  state.trip.stops.reverse();
  renderStops();
  scheduleSave();
  scheduleRoute(false);
  toast("Start and finish swapped");
};
$("btnOptimize").onclick = () => {
  if (geocodedStops().length < 3) return toast("Add at least 3 places first");
  $("btnOptimize").classList.add("busy");
  scheduleRoute(true);
};
$("btnMore").onclick = () => openModal("Trip", moreBody());
$("btnBack").onclick = async () => {
  hideSuggest();
  await saveTrip();
  state.navigating = false;
  showList();
};
$("tripSearch").addEventListener("input", (e) => {
  state.filter = e.target.value;
  renderList();
});
$("btnNew").onclick = () => newTrip().catch((e) => toast(e.message));
$("tripList").onclick = (e) => {
  const row = e.target.closest("[data-id]");
  if (row) openTrip(row.dataset.id);
};
$("btnStart").onclick = () => {
  state.navigating = true;
  state.navI = 0;
  updateNav();
  goLeg();
};
$("btnNext").onclick = () => {
  const pts = geocodedStops();
  if (state.navI >= pts.length - 1) {
    state.navigating = false;
    updateNav();
    return;
  }
  state.navI += 1;
  updateNav();
  if (state.navI < pts.length - 1) goLeg();
};
$("btnLocate").onclick = () => {
  if (!state.here) return toast("Location unavailable");
  state.map?.setView([state.here.lat, state.here.lng], 14);
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
  return `<p class="hint">One address per line. We’ll auto-complete the lot and drop them on the route.</p>
    <textarea id="pasteBox" placeholder="12 Queen St, Brisbane&#10;200 George St, Sydney&#10;Federation Square, Melbourne"></textarea>
    <div style="display:flex;gap:8px;margin-top:12px">
      <button type="button" class="btn primary" id="pasteGo" style="flex:1">Add them</button>
      <button type="button" class="chip" id="pasteCancel">Cancel</button>
    </div>`;
}

function moreBody() {
  const t = state.trip;
  return `<label class="field">Trip name
      <input id="renameTitle" value="${esc(t.title || "")}" />
    </label>
    <button type="button" class="sheet-btn" data-more="round">${t.roundtrip ? "✓ " : ""}Round trip</button>
    <button type="button" class="sheet-btn" data-more="ends">${t.keepEnds ? "✓ " : ""}Keep start &amp; end when optimizing</button>
    <button type="button" class="sheet-btn" data-more="dup">Duplicate trip</button>
    <button type="button" class="sheet-btn" data-more="apple">Open in Apple Maps</button>
    <button type="button" class="sheet-btn" data-more="google">Open in Google Maps</button>
    <button type="button" class="sheet-btn bad" data-more="del">Delete trip</button>`;
}

$("sheetBody").addEventListener("click", async (e) => {
  if (e.target.id === "pasteCancel") return closeModal();
  if (e.target.id === "pasteGo") return pasteAddresses();
  const more = e.target.closest("[data-more]");
  if (!more) return;
  const act = more.dataset.more;
  if (act === "round") {
    state.trip.roundtrip = !state.trip.roundtrip;
    closeModal();
    renderStops();
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
    copy.title = (copy.title || "Trip") + " copy";
    copy.createdAt = Date.now();
    copy.updatedAt = Date.now();
    copy.stops = (copy.stops || []).map((s) => ({ ...s, id: uid() }));
    setRecords([copy, ...(state.records || [])]);
    closeModal();
    openTrip(copy.id);
    toast("Duplicated");
  }
  if (act === "apple") {
    closeModal();
    openExternal("apple");
  }
  if (act === "google") {
    closeModal();
    openExternal("google");
  }
  if (act === "del") {
    const id = state.trip.id;
    setRecords((state.records || readLocal()).filter((t) => t.id !== id));
    api(`/api/trips/${id}`, { method: "DELETE" }).catch(() => {});
    closeModal();
    state.trip = null;
    showList();
    renderList();
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
    const existing = filledStops();
    if (!existing.length) {
      state.trip.stops = built.length >= 2 ? built : [...built, { id: uid(), query: "", label: "", lat: null, lng: null }];
    } else {
      const dest = state.trip.stops[state.trip.stops.length - 1];
      state.trip.stops.splice(state.trip.stops.length - (state.trip.roundtrip ? 0 : 1), 0, ...built);
      if (!state.trip.roundtrip && !(dest.label || dest.query)) {
        /* dest was empty, pasted stops include a new end */
      }
    }
    const missed = built.filter((s) => !s.lat).length;
    renderStops();
    setSnap("mid");
    scheduleSave();
    scheduleRoute(false);
    toast(missed ? `Added ${built.length}. ${missed} need a tap to fix.` : `Added ${built.length} stops`);
  } catch (err) {
    toast(err.message);
  }
}

function scheduleRoute(optimize) {
  clearTimeout(state.routeTimer);
  state.routeTimer = setTimeout(() => routeNow(optimize), optimize ? 50 : 280);
}

async function routeNow(optimize) {
  const pts = geocodedStops();
  if (pts.length < 2) {
    state.route = null;
    state.routing = false;
    drawMap(true);
    updateEta();
    updateLegs();
    return;
  }
  state.routing = true;
  updateEta();
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
      const byId = Object.fromEntries(state.trip.stops.map((s) => [s.id, s]));
      const rest = state.trip.stops.filter((s) => !ids.includes(s.id));
      state.trip.stops = [...data.order.map((i) => byId[ids[i]]), ...rest].filter(Boolean);
      renderStops();
      toast("Reordered for a shorter drive");
    }
    state.route = data;
    if (state.trip) {
      state.trip.distanceM = data.distanceM;
      state.trip.durationS = data.durationS;
    }
    drawMap(true);
    updateLegs();
    scheduleSave();
  } catch (err) {
    toast(err.message);
  } finally {
    state.routing = false;
    $("btnOptimize").classList.remove("busy");
    updateEta();
  }
}

function ensureMap() {
  if (state.map) return;
  state.map = L.map("map", { zoomControl: false, attributionControl: false }).setView(
    [state.bias.lat, state.bias.lng],
    11,
  );
  L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
    maxZoom: 20,
  }).addTo(state.map);
}

function mapPad() {
  const sheet = $("plannerSheet");
  const h = $("tripScreen").classList.contains("hidden") ? 24 : sheet.offsetHeight || 220;
  return { paddingTopLeft: [18, 72], paddingBottomRight: [18, h + 12] };
}

function drawMap(fit) {
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
    const active = state.navigating && i === state.navI + 1;
    const cls = `${i === 0 ? "origin" : last ? "dest" : ""} ${active ? "active" : ""}`;
    const icon = L.divIcon({
      className: "",
      html: `<div class="num-marker ${cls}">${i + 1}</div>`,
      iconSize: [28, 28],
      iconAnchor: [14, 14],
    });
    const mk = L.marker([s.lat, s.lng], { icon }).addTo(state.map);
    mk.bindTooltip(s.label || s.query, { direction: "top", offset: [0, -12] });
    mk.on("click", () => {
      state.focusId = s.id;
      setSnap("full");
      const input = $("stopList").querySelector(`input[data-id="${s.id}"]`);
      input?.scrollIntoView({ block: "center" });
      input?.focus();
    });
    state.markers.push(mk);
  });
  if (state.hereDot) {
    state.hereDot.remove();
    state.hereDot = null;
  }
  if (state.here) {
    state.hereDot = L.circleMarker([state.here.lat, state.here.lng], {
      radius: 7,
      color: "#fff",
      weight: 2,
      fillColor: "#1a73e8",
      fillOpacity: 1,
    }).addTo(state.map);
  }
  if (!fit && !state.route) return;
  const pad = mapPad();
  if (state.route?.geometry?.length) {
    state.line = L.polyline(state.route.geometry, { color: "#1a73e8", weight: 5, opacity: 0.94 }).addTo(state.map);
    state.map.fitBounds(state.line.getBounds(), pad);
  } else if (pts.length === 1) state.map.setView([pts[0].lat, pts[0].lng], 14);
  else if (pts.length > 1) state.map.fitBounds(L.latLngBounds(pts.map((p) => [p.lat, p.lng])), pad);
}

function mapsQuery(s) {
  if (Number.isFinite(s.lat) && Number.isFinite(s.lng)) return `${s.lat},${s.lng}`;
  return encodeURIComponent(s.label || s.query);
}

function goLeg() {
  const pts = geocodedStops();
  if (state.navI >= pts.length - 1) return;
  const a = pts[state.navI];
  const b = pts[state.navI + 1];
  location.href = `https://maps.apple.com/?saddr=${mapsQuery(a)}&daddr=${mapsQuery(b)}&dirflg=d`;
}

function openExternal(kind) {
  const pts = geocodedStops();
  if (pts.length < 2) return toast("Need a route first");
  if (kind === "apple") {
    const dests = pts
      .slice(1, 11)
      .map((p) => `daddr=${mapsQuery(p)}`)
      .join("&");
    location.href = `https://maps.apple.com/?saddr=${mapsQuery(pts[0])}&${dests}&dirflg=d`;
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
  let startY = 0;
  let startH = 0;
  grab.addEventListener(
    "pointerdown",
    (e) => {
      startY = e.clientY;
      startH = sheet.getBoundingClientRect().height;
      sheet.style.transition = "none";
      const move = (ev) => {
        const next = Math.min(window.innerHeight - 60, Math.max(150, startH + (startY - ev.clientY)));
        sheet.style.height = next + "px";
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
    document.documentElement.style.setProperty("--kb", (kb > 40 ? kb : 0) + "px");
  };
  window.visualViewport.addEventListener("resize", pinKb);
  window.visualViewport.addEventListener("scroll", pinKb);
}

async function locate() {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      state.here = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      state.bias = { ...state.here };
      try {
        const data = await api(`/api/reverse?lat=${state.here.lat}&lon=${state.here.lng}`);
        if (data.hit?.label) state.hereLabel = data.hit.label;
      } catch {
        /* keep default */
      }
      if (state.map && !$("tripScreen").classList.contains("hidden") && geocodedStops().length < 2) {
        state.map.setView([state.here.lat, state.here.lng], 13);
      }
    },
    () => {},
    { enableHighAccuracy: true, timeout: 10000 },
  );
}

ensureMap();
locate();
loadTrips().catch((e) => toast(e.message));
