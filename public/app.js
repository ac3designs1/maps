/* global L */
"use strict";

/* ─── constants ─── */
const STORE_KEY = "maps.trips.v1";
const PINS_KEY  = "maps.pins.v1";
const LAST_KEY  = "maps.lastTrip";

/* ─── state ─── */
const S = {
  trips: [],       /* summaries */
  records: [],     /* full trip objects */
  trip: null,      /* active trip */
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
  lineOutline: null,
  markers: [],
  hereDot: null,
  snap: "mid",
  navI: 0,
  navigating: false,
  undo: null,
};

/* ─── tiny helpers ─── */
const $ = (id) => document.getElementById(id);

function uid() {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
function buzz(ms = 8) { try { navigator.vibrate?.(ms); } catch {} }
function esc(s) {
  return String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/"/g,"&quot;");
}
function fmtDur(s) {
  if (!s) return "";
  const m = Math.round(s / 60);
  if (m < 1) return "<1 min";
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h} hr ${r} min` : `${h} hr`;
}
function fmtKm(m) {
  if (m == null) return "";
  return m < 950 ? `${Math.round(m)} m` : `${(m/1000).toFixed(m >= 100000 ? 0 : 1)} km`;
}
function relTime(ts) {
  const d = Date.now() - ts;
  if (d < 60_000)    return "Just now";
  if (d < 3600_000)  return `${Math.floor(d/60_000)}m ago`;
  if (d < 86400_000) return `${Math.floor(d/3600_000)}h ago`;
  return new Date(ts).toLocaleDateString();
}
function filledStops(trip = S.trip)   { return (trip?.stops||[]).filter(s=>(s.label||s.query||"").trim()); }
function geocodedStops(trip = S.trip) { return (trip?.stops||[]).filter(s=>Number.isFinite(s.lat)&&Number.isFinite(s.lng)); }
function isHereStop(s) {
  if (!s) return false;
  if (s.here) return true;
  const q = String(s.query || "").trim().toLowerCase();
  const l = String(s.label || "").trim().toLowerCase();
  return q === "your location" || l === "your location";
}
function hereDisplay() { return "Your location"; }
function stopPlaceholder(s, i, n) {
  if (isHereStop(s)) return "Your location";
  if (i === 0) return "Start from";
  if (i === n - 1 && !S.trip?.roundtrip) return "Where to?";
  return "Add stop";
}
function titleFromStops(trip) {
  const f = filledStops(trip);
  if (f.length === 0) return trip.title && trip.title !== "Untitled trip" ? trip.title : "Untitled trip";
  if (f.length === 1) return (f[0].label||f[0].query).split(",")[0];
  return `${(f[0].label||f[0].query).split(",")[0]} → ${(f[f.length-1].label||f[f.length-1].query).split(",")[0]}`;
}

/* ─── api ─── */
async function api(path, opts = {}) {
  // Support an external AbortController via opts.signal, plus our own timeout.
  const ac  = new AbortController();
  const ext = opts.signal;
  let timedOut = false;
  if (ext) ext.addEventListener("abort", () => ac.abort(), { once: true });
  const timer = setTimeout(() => { timedOut = true; ac.abort(); }, opts.timeout || 22000);
  try {
    const res = await fetch(path, {
      ...opts,
      signal: ac.signal,
      headers: { Accept:"application/json","Content-Type":"application/json",...(opts.headers||{}) },
    });
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { throw new Error("Server error"); }
    if (!res.ok) throw new Error(data.error || "Something went wrong");
    return data;
  } catch (err) {
    if (err?.name === "AbortError") {
      if (timedOut) throw new Error("That took too long. Try again.");
      throw Object.assign(new Error("cancelled"),{cancelled:true});
    }
    throw err;
  } finally { clearTimeout(timer); }
}

/* ─── toast ─── */
function toast(msg, undoFn) {
  $("toastMsg").textContent = msg;
  const u = $("toastUndo");
  if (undoFn) { S.undo = undoFn; u.classList.remove("hidden"); }
  else         { S.undo = null;  u.classList.add("hidden");    }
  $("toast").classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    $("toast").classList.add("hidden");
    S.undo = null;
    u.classList.add("hidden");
  }, undoFn ? 4500 : 2400);
}
$("toastUndo").onclick = () => {
  if (!S.undo) return;
  S.undo(); S.undo = null;
  $("toastUndo").classList.add("hidden");
  $("toast").classList.add("hidden");
};

/* ─── modal ─── */
function openModal(title, html) {
  $("modalTitle").textContent = title;
  $("modalBody").innerHTML = html;
  $("modal").classList.remove("hidden");
}
function closeModal() { $("modal").classList.add("hidden"); }
$("modalBack").onclick   = closeModal;
$("modalClose").onclick  = closeModal;
$("modal").addEventListener("click", e => {
  if (e.target === $("modal")) closeModal();
});

/* ─── local storage ─── */
function readLocal() {
  try { const p = JSON.parse(localStorage.getItem(STORE_KEY)||'{"trips":[]}'); return Array.isArray(p.trips)?p.trips:[]; }
  catch { return []; }
}
function writeLocal(trips) { try { localStorage.setItem(STORE_KEY,JSON.stringify({trips})); } catch {} }
function readPins() { try { return JSON.parse(localStorage.getItem(PINS_KEY)||"{}"); } catch { return {}; } }
function writePins(p) { try { localStorage.setItem(PINS_KEY,JSON.stringify(p)); } catch {} }
function pinHit(key) {
  const p = readPins()[key];
  if (!p||!Number.isFinite(p.lat)) return null;
  return { label:p.label, lat:p.lat, lng:p.lng, kind:"pin", name:p.label.split(",")[0] };
}
function setPin(key,hit) { const p=readPins(); p[key]={label:hit.label,lat:hit.lat,lng:hit.lng}; writePins(p); }
function rememberLast(id) { try { if(id) localStorage.setItem(LAST_KEY,id); } catch {} }

/* ─── trip summaries ─── */
function summarize(t) {
  const f = (t.stops||[]).filter(s=>s.label||s.query);
  return {
    id: t.id, title: t.title, updatedAt: t.updatedAt, createdAt: t.createdAt,
    stopCount: f.length,
    preview: f.slice(0,3).map(s=>s.label||s.query).join(" → "),
    distanceM: t.distanceM||0, durationS: t.durationS||0, starred: !!t.starred,
  };
}
function mergeTrips(a,b) {
  const map = new Map();
  for (const t of [...a,...b]) {
    if (!t?.id) continue;
    const prev = map.get(t.id);
    if (!prev||(t.updatedAt||0)>=(prev.updatedAt||0)) map.set(t.id,t);
  }
  return [...map.values()].sort((x,y)=>(y.updatedAt||0)-(x.updatedAt||0));
}
function emptyTrip() {
  const now = Date.now();
  return { id:uid(), title:"Untitled trip", roundtrip:false, keepEnds:false,
    avoidTolls:false, avoidFerries:false, starred:false,
    createdAt:now, updatedAt:now,
    stops: [{id:uid(),query:"",label:"",lat:null,lng:null},{id:uid(),query:"",label:"",lat:null,lng:null}] };
}
function setRecords(trips) { S.records=trips; writeLocal(trips); S.trips=trips.map(summarize); }

/* ─── dedup ─── */
function dedupeHits(hits) {
  const out = [];
  for (const h of hits) {
    const dup = out.some(p => {
      const dlat=(h.lat-p.lat)*111000, dlng=(h.lng-p.lng)*111000*Math.cos(h.lat*Math.PI/180);
      const dm=Math.sqrt(dlat*dlat+dlng*dlng);
      if (dm<35) return true;
      const norm=s=>String(s||"").toLowerCase().replace(/[^\w\s]/g," ").replace(/\s+/g," ").trim();
      const a=norm(h.label),b=norm(p.label);
      if (a&&a===b) return true;
      const na=norm(h.name||h.label.split(",")[0]),nb=norm(p.name||p.label.split(",")[0]);
      return dm<80&&na&&na===nb;
    });
    if (!dup) out.push(h);
  }
  return out;
}

/* ─── screens ─── */
function showList() {
  $("listScreen").classList.remove("is-away");
  $("tripScreen").classList.remove("is-open");
  document.activeElement?.blur();
  hideSuggest();
  renderContinue();
}
function showTrip() {
  $("listScreen").classList.add("is-away");
  $("tripScreen").classList.add("is-open");
  setSnap(S.snap || "mid");
  if (history.state?.tp !== 1) {
    try { history.pushState({ tp: 1 }, ""); } catch {}
  }
  requestAnimationFrame(() => {
    S.map?.invalidateSize();
    S.map?.dragging?.enable();
    drawMap(true);
  });
}

/* ─── snap ─── */
function setSnap(which) {
  S.snap = which;
  const el = $("sheet");
  el.classList.remove("snap-collapsed","snap-mid","snap-full");
  el.classList.add(`snap-${which}`);
  setTimeout(() => S.map?.invalidateSize(), 260);
  const icon  = $("mapToggleIcon");
  const label = $("mapToggleLabel");
  const btn   = $("btnMapToggle");
  if (which === "full") {
    btn.classList.remove("active");
    if (label) label.textContent = "Map";
    if (icon) icon.innerHTML = `<path d="M1 6l7-3 8 3 7-3v15l-7 3-8-3-7 3V6z"/><path d="M8 3v15M16 6v15"/>`;
  } else {
    btn.classList.add("active");
    if (label) label.textContent = "List";
    if (icon) icon.innerHTML = `<path d="M9 3H5a2 2 0 0 0-2 2v4m6-6h10a2 2 0 0 1 2 2v4M9 3v18m0 0h10a2 2 0 0 0 2-2V9M9 21H5a2 2 0 0 1-2-2V9m0 0h18"/>`;
  }
}

/* ─── list screen ─── */
function renderContinue() {
  const card = $("continueCard");
  if (!card) return;
  const lastId = localStorage.getItem(LAST_KEY);
  const trip = lastId && (S.records||[]).find(t=>t.id===lastId);
  if (!trip || $("tripScreen").classList.contains("is-open")) { card.classList.add("hidden"); return; }
  $("continueTitle").textContent = trip.title||"Untitled trip";
  const n = filledStops(trip).length;
  const dur = trip.durationS ? ` · ${fmtDur(trip.durationS)}` : "";
  $("continueSub").textContent = `${n} stop${n===1?"":"s"}${dur}`;
  card.onclick = () => openTrip(trip.id);
  card.classList.remove("hidden");
}

function renderList() {
  const q = S.filter.trim().toLowerCase();
  const rows = S.trips
    .filter(t=>!q||`${t.title} ${t.preview}`.toLowerCase().includes(q))
    .sort((a,b)=>(a.starred?0:1)-(b.starred?0:1)||b.updatedAt-a.updatedAt);
  const empty = $("emptyState");
  empty.classList.toggle("hidden", rows.length > 0);
  const h2 = empty.querySelector("h2");
  const p  = empty.querySelector("p");
  const btn = $("btnEmptyNew");
  if (S.trips.length && !rows.length) {
    if (h2) h2.textContent = "No matches";
    if (p) p.textContent = "Try a different name or place.";
    btn?.classList.add("hidden");
  } else {
    if (h2) h2.textContent = "No trips yet";
    if (p) p.innerHTML = "Add addresses, optimise your route,<br>and navigate stop by stop.";
    btn?.classList.remove("hidden");
  }
  $("tripList").innerHTML = rows.map(t => {
    const stats = t.durationS ? fmtDur(t.durationS) : relTime(t.updatedAt);
    const words = (t.title||"?").trim().split(/\s+/).filter(Boolean);
    const initials = words.length >= 2
      ? ((words[0][0]||"")+(words[1][0]||"")).toUpperCase()
      : (t.title||"?").replace(/\s+/g,"").slice(0,2).toUpperCase() || "?";
    const badgeCls = t.starred ? "trip-badge starred-badge" : "trip-badge";
    return `<button type="button" class="trip-row" data-id="${t.id}">
      <span class="${badgeCls}">${t.starred?"★":esc(initials)}</span>
      <span class="trip-info">
        <span class="trip-name">${esc(t.title||"Untitled trip")}</span>
        <span class="trip-sub">${esc(t.preview||"No stops yet")}</span>
      </span>
      <span class="trip-meta">${esc(stats)}<br><span style="font-size:11px">${t.stopCount||0} stop${t.stopCount===1?"":"s"}</span></span>
      <svg class="trip-chev" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>
    </button>`;
  }).join("");
  renderContinue();
}

async function loadTrips() {
  // Trips are stored per-device in localStorage only.
  const records = readLocal();
  setRecords(records);
  renderList();
}

function openTrip(id) {
  const raw = (S.records||readLocal()).find(t=>t.id===id);
  if (!raw) return toast("Trip not found");
  const base = emptyTrip();
  S.trip = { ...base, ...raw, stops: raw.stops?.length ? raw.stops : base.stops };
  S.route=null; S.navigating=false; S.navI=0; nudgeDismissed=false;
  pinHereFirst();
  if (S.here) {
    const hereStop = S.trip.stops.find(isHereStop);
    if (hereStop) {
      hereStop.lat = S.here.lat;
      hereStop.lng = S.here.lng;
      hereStop.here = true;
      hereStop.query = hereDisplay();
      hereStop.label = hereDisplay();
    }
  }
  rememberLast(id);
  S.snap = "mid";
  syncStops(true);
  showTrip();
  scheduleRoute(false);
  _analytics?.ping("open_trip");
}

function newTrip() {
  buzz();
  const trip = emptyTrip();
  setRecords([trip,...(S.records||readLocal()).filter(t=>t.id!==trip.id)]);
  S.trip=trip; S.route=null; S.navigating=false; S.navI=0; nudgeDismissed=false;
  S.snap="full"; // set before showTrip so setSnap picks it up
  syncStops(true); renderList(); showTrip();
  // Pre-fill first stop with current location if available
  applyLocationToFirstStop();
  // Focus the second stop (destination) since first is already filled, or first if not
  setTimeout(()=>{
    const inputs = $("stopList").querySelectorAll(".stop-input");
    const target = S.here ? inputs[1] : inputs[0];
    target?.focus();
  }, 240);
  _analytics?.ping("new_trip");
}

/* ─── save ─── */
function scheduleSave() { clearTimeout(S.saveTimer); S.saveTimer=setTimeout(saveTrip,400); }
function saveTrip() {
  if (!S.trip) return;
  if (!S.trip.title||S.trip.title==="Untitled trip") S.trip.title=titleFromStops(S.trip);
  if (S.route) { S.trip.distanceM=S.route.distanceM; S.trip.durationS=S.route.durationS; }
  S.trip.updatedAt=Date.now();
  setRecords(mergeTrips([S.trip],S.records||readLocal()));
  renderList(); rememberLast(S.trip.id);
}
function flushSave() {
  clearTimeout(S.saveTimer);
  saveTrip();
}
window.addEventListener("pagehide", flushSave);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flushSave();
});

/* ─── autocomplete ─── */
function hideSuggest() {
  const box = $("suggestBox");
  box.classList.add("hidden"); box.innerHTML=""; box._hits=null;
}

function activeStopInput() {
  if (S.focusId) return $("stopList").querySelector(`.stop-input[data-id="${S.focusId}"]`);
  const el = document.activeElement;
  return el?.matches?.(".stop-input") ? el : null;
}

function positionSuggest() {
  const box   = $("suggestBox");
  const input = activeStopInput();
  if (!input||box.classList.contains("hidden")) return;

  input.closest(".stop-row")?.scrollIntoView({block:"nearest"});

  requestAnimationFrame(() => {
    const r = input.getBoundingClientRect();
    const kb = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--kb"))||0;
    const safeB = window.innerHeight - kb - 8;
    const gap = 6;
    const below = safeB - r.bottom - gap;
    const above = r.top - 64 - gap;

    let top, maxH;
    if (below >= 100 || below >= above) {
      top  = r.bottom + gap;
      maxH = Math.min(300, Math.max(100, below));
    } else {
      maxH = Math.min(300, Math.max(100, above));
      top  = r.top - maxH - gap;
    }
    box.style.top     = `${Math.max(8,top)}px`;
    box.style.maxHeight = `${maxH}px`;
  });
}

async function lookup(q) {
  S.suggestAc?.abort();
  S.suggestAc = new AbortController();
  const u = new URL("/api/suggest", location.origin);
  u.searchParams.set("q",q);
  u.searchParams.set("lat",String(S.here?.lat ?? S.bias.lat));
  u.searchParams.set("lon",String(S.here?.lng ?? S.bias.lng));
  const d = await api(u.pathname+u.search,{signal:S.suggestAc.signal,timeout:14000});
  return d.hits||[];
}

function renderSuggestRows(hits) {
  const iconFor = kind => {
    if (kind==="business") return {
      cls:"sug-ico-blue",
      svg:`<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M3 9l1-6h16l1 6v1a2 2 0 0 1-4 0 2 2 0 0 1-4 0 2 2 0 0 1-4 0 2 2 0 0 1-4 0V9zm0 5h18v7H3z"/></svg>`
    };
    return {
      cls:"sug-ico-green",
      svg:`<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 2a7 7 0 0 0-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6a2.5 2.5 0 0 1 0 5.5z"/></svg>`
    };
  };
  if (!hits.length) return `<div class="sug-empty">No results found</div>`;
  return hits.map((h,i) => {
    const {cls,svg} = iconFor(h.kind);
    const name = esc(h.name||h.label.split(",")[0]);
    const addr = esc(h.label);
    return `<button class="sug-row" data-i="${i}">
      <span class="sug-ico ${cls}">${svg}</span>
      <span style="min-width:0"><span class="sug-name">${name}</span><span class="sug-addr">${addr}</span></span>
    </button>`;
  }).join("");
}

function showHereSuggest() {
  const pins = readPins();
  const rows = [];
  if (S.here) rows.push(`<button class="sug-row" data-me="1">
    <span class="sug-ico sug-ico-blue"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg></span>
    <span style="min-width:0"><span class="sug-name">Your location</span><span class="sug-addr">${esc(S.hereLabel)}</span></span>
  </button>`);
  if (pins.home) rows.push(`<button class="sug-row" data-pin="home">
    <span class="sug-ico sug-ico-green"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/></svg></span>
    <span style="min-width:0"><span class="sug-name">Home</span><span class="sug-addr">${esc(pins.home.label)}</span></span>
  </button>`);
  if (pins.work) rows.push(`<button class="sug-row" data-pin="work">
    <span class="sug-ico sug-ico-amber"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M20 6h-2.18A3 3 0 0 0 15 4H9a3 3 0 0 0-2.82 2H4a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2zm-5 0H9a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1z"/></svg></span>
    <span style="min-width:0"><span class="sug-name">Work</span><span class="sug-addr">${esc(pins.work.label)}</span></span>
  </button>`);
  if (!rows.length) return;
  const box = $("suggestBox");
  box.innerHTML = rows.join(""); box._hits = null;
  box.classList.remove("hidden");
  positionSuggest();
}

function applyHit(hit) {
  const stop = S.trip?.stops.find(s=>s.id===S.focusId);
  if (!stop) return;
  const isHere = !!hit.here;
  const displayVal = isHere ? hereDisplay() : (hit.name && hit.name !== hit.label ? hit.name : hit.label);
  stop.query = displayVal;
  stop.label = isHere ? hereDisplay() : hit.label;
  stop.lat = hit.lat;
  stop.lng = hit.lng;
  stop.here = isHere;
  hideSuggest();
  const input = $("stopList").querySelector(`.stop-input[data-id="${stop.id}"]`);
  if (input) { input.value = displayVal; input.classList.remove("unresolved"); }
  if (isHere) {
    for (const s of S.trip.stops) { if (s.id !== stop.id) s.here = false; }
    pinHereFirst();
  }
  syncStops(true);
  updateRowMeta(); scheduleSave(); scheduleRoute(false); buzz();
  const idx = S.trip.stops.findIndex(s=>s.id===stop.id);
  const next = S.trip.stops.slice(idx+1).find(s=>!(s.label||s.query).trim());
  if (next) {
    setTimeout(() => {
      const ni = $("stopList").querySelector(`.stop-input[data-id="${next.id}"]`);
      ni?.focus();
    }, 80);
  } else if (geocodedStops().length >= 2) {
    document.activeElement?.blur();
    setSnap("mid");
    setTimeout(() => { S.map?.invalidateSize(); drawMap(true); }, 280);
  }
}

$("suggestBox").addEventListener("click", async e => {
  const btn = e.target.closest(".sug-row");
  if (!btn) return;
  if (btn.dataset.me) {
    if (!S.here) return toast("Location unavailable");
    applyHit({label:hereDisplay(),lat:S.here.lat,lng:S.here.lng,here:true,name:hereDisplay()}); return;
  }
  if (btn.dataset.pin) {
    const h=pinHit(btn.dataset.pin);
    if (!h) return toast("Set this in More first");
    applyHit(h); return;
  }
  const idx = Number(btn.dataset.i);
  const h = ($("suggestBox")._hits||[])[idx];
  if (h) applyHit(h);
});

document.addEventListener("click", e => {
  if (e.target.closest("#suggestBox")||e.target.closest(".stop-input")) return;
  hideSuggest();
});

/* ─── stop rows ─── */
function stopKind(i,n) {
  if (i===0) return "is-origin";
  if (i===n-1&&!S.trip?.roundtrip) return "is-dest";
  return "";
}
function stopLabel(i,n) {
  if (n===2) return i===0 ? "A" : "B";
  return String(i+1);
}

function makeRow(s,i,n) {
  const row = document.createElement("div");
  row.className = `stop-row ${stopKind(i,n)}${isHereStop(s)?" is-here":""}`.trim();
  row.dataset.id = s.id;

  row.innerHTML = `
    <div class="stop-dot-col">
      <div class="stop-dot">${stopLabel(i,n)}</div>
      <div class="stop-line"></div>
    </div>
    <div class="stop-input-col">
      <input class="stop-input${s.query&&!Number.isFinite(s.lat)?" unresolved":""}"
        data-id="${s.id}" value="${esc(isHereStop(s)?hereDisplay():(s.query||s.label))}"
        placeholder="${esc(stopPlaceholder(s,i,n))}"
        autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"
        enterkeyhint="search" inputmode="${isHereStop(s)?"none":"search"}"
        ${isHereStop(s)?"readonly":""}/>
      <div class="leg-meta"></div>
    </div>
    <div class="grip-btn" data-act="grip" data-id="${s.id}" aria-label="Reorder" role="button">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" opacity=".35">
        <circle cx="8" cy="6" r="1.5"/><circle cx="16" cy="6" r="1.5"/>
        <circle cx="8" cy="12" r="1.5"/><circle cx="16" cy="12" r="1.5"/>
        <circle cx="8" cy="18" r="1.5"/><circle cx="16" cy="18" r="1.5"/>
      </svg>
    </div>
    <button class="del-btn" data-act="del" data-id="${s.id}" aria-label="Remove">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
    </button>`;
  bindStopInput(row.querySelector(".stop-input"));
  return row;
}

function updateRowMeta() {
  if (!S.trip) return;
  const stops = S.trip.stops;
  const n = stops.length;
  const domRows = [...$("stopList").children];
  // Safety: only iterate as far as both DOM and stops arrays go
  const count = Math.min(domRows.length, n);
  for (let i = 0; i < count; i++) {
    const row = domRows[i];
    const s   = stops[i];
    if (!s) continue;
    row.className = `stop-row ${stopKind(i,n)}${row.classList.contains("dragging")?" dragging":""}${isHereStop(s)?" is-here":""}`.trim();
    const dot = row.querySelector(".stop-dot");
    if (dot) dot.textContent = stopLabel(i,n);
    const input = row.querySelector(".stop-input");
    if (input) {
      const here = isHereStop(s);
      input.readOnly = here;
      input.inputMode = here ? "none" : "search";
      input.placeholder = stopPlaceholder(s, i, n);
      if (document.activeElement !== input) {
        const val = here ? hereDisplay() : (s.query||s.label||"");
        if (input.value !== val) input.value = val;
      }
      input.classList.toggle("unresolved", !!(input.value && !Number.isFinite(s.lat)));
    }
    const legEl = row.querySelector(".leg-meta");
    if (legEl) {
      const leg = S.route?.legs?.[i-1];
      legEl.textContent = i>0&&leg ? `${fmtDur(leg.durationS)} · ${fmtKm(leg.distanceM)}` : "";
    }
  }
  updateSummary();
  updateNav();
  updateNudge();
}

function syncStops(force) {
  const list = $("stopList");
  const trip = S.trip;
  if (!trip) { list.innerHTML=""; return; }
  const ids = trip.stops.map(s=>s.id);
  const existing = [...list.children];
  if (force || existing.map(r=>r.dataset.id).join()!==ids.join()) {
    const map = new Map(existing.map(r=>[r.dataset.id,r]));
    const next = [];
    trip.stops.forEach((s,i)=>{
      const row = map.get(s.id)||makeRow(s,i,trip.stops.length);
      map.delete(s.id); next.push(row);
    });
    map.forEach(r=>r.remove());
    next.forEach(r=>list.appendChild(r));
  }
  updateRowMeta();
}

/* ─── summary bar ─── */
function updateSummary() {
  if (!S.trip) return;
  const r = S.route;
  const n = geocodedStops().length;
  const title = $("summaryTime");
  const sub   = $("summaryMeta");
  const start = $("btnStart");

  title.classList.toggle("loading", S.routing&&n>=2);

  if (S.routing && n>=2) {
    title.textContent = "Finding route…";
    sub.textContent   = `${n} stops`;
    start.disabled    = true;
    return;
  }
  if (!r||n<2) {
    const hereStart = isHereStop(S.trip.stops[0]);
    title.textContent = n<2 ? (hereStart ? "Add a destination" : "Add two places") : "Can't find a route";
    sub.textContent   = hereStart && n<2 ? "Search below or tap + Stop" : `${filledStops().length} stop${filledStops().length===1?"":"s"}`;
    start.disabled    = true;
    return;
  }
  title.textContent = `${fmtDur(r.durationS)} · ${fmtKm(r.distanceM)}`;
  sub.textContent   = `${S.trip.title||"Trip"}${S.trip.roundtrip?" · round trip":""}`;
  start.disabled    = false;
}

/* ─── optimise nudge ─── */
let nudgeDismissed = false;
function updateNudge() {
  const nudge = $("optimiseNudge");
  if (!nudge) return;
  const pts = geocodedStops();
  // Show when 3+ geocoded stops, not round trip, route loaded, not dismissed, not already optimised this session
  const show = !nudgeDismissed && !S.trip?.roundtrip && pts.length >= 3 && S.route && !S.routing;
  nudge.classList.toggle("hidden", !show);
  $("btnOptimise")?.classList.toggle("is-hot", pts.length >= 3 && !S.routing);
}
$("nudgeOptimise")?.addEventListener("click", () => {
  if (S.routing) return;
  nudgeDismissed = true;
  $("optimiseNudge").classList.add("hidden");
  if (geocodedStops().length < 3) return toast("Add at least 3 places first");
  $("btnOptimise").classList.add("loading");
  scheduleRoute(true);
});
$("nudgeDismiss")?.addEventListener("click", () => {
  nudgeDismissed = true;
  $("optimiseNudge").classList.add("hidden");
});

/* ─── nav bar ─── */
function updateNav() {
  const bar = $("navBar");
  if (!S.navigating) { bar.classList.add("hidden"); return; }
  const pts = geocodedStops();
  if (S.navI >= pts.length-1) {
    $("navTitle").textContent = "Trip complete";
    $("navSub").textContent   = "You've reached every stop";
    $("btnNext").textContent  = "Done";
    bar.classList.remove("hidden"); return;
  }
  const next = pts[S.navI+1];
  const leg  = S.route?.legs?.[S.navI];
  $("navTitle").textContent = `Stop ${S.navI+2} of ${pts.length}`;
  $("navSub").textContent   = `${(next.label||next.query).split(",")[0]}${leg?" · "+fmtDur(leg.durationS):""}`;
  $("btnNext").textContent  = "Go";
  bar.classList.remove("hidden");
}

/* ─── bind inputs ─── */
function bindStopInput(input) {
  if (input.dataset.bound) return;
  input.dataset.bound = "1";
  const id = input.dataset.id;

  input.addEventListener("focus", () => {
    S.focusId = id;
    setSnap("full");
    const stop = S.trip?.stops.find(s=>s.id===id);
    if (isHereStop(stop)) showHereSuggest();
    else if (S.here&&!input.value) showHereSuggest();
    requestAnimationFrame(()=>positionSuggest());
  });

  input.addEventListener("blur", () => {
    const stop = S.trip?.stops.find(s=>s.id===id);
    if (!stop) return;
    if ((stop.here || isHereStop(stop)) && input.value.trim().length < 2) {
      stop.query = hereDisplay();
      stop.label = hereDisplay();
      stop.here = true;
      if (S.here) { stop.lat = S.here.lat; stop.lng = S.here.lng; }
      input.value = hereDisplay();
      scheduleSave();
    }
  });

  input.addEventListener("input", () => {
    const stop = S.trip?.stops.find(s=>s.id===id);
    if (!stop) return;
    if (input.readOnly) { showHereSuggest(); return; }
    const q = input.value.trim();
    const qn = q.toLowerCase();
    const lockedHere = !!(stop.here || isHereStop(stop));
    if (lockedHere) {
      const appended = qn.startsWith("your location") && qn !== "your location";
      const prefixing = qn.length > 0 && qn !== "your location" && "your location".startsWith(qn);
      if (appended || prefixing) {
        stop.query = hereDisplay();
        stop.label = hereDisplay();
        stop.here = true;
        if (S.here) { stop.lat = S.here.lat; stop.lng = S.here.lng; }
        input.value = hereDisplay();
        showHereSuggest();
        scheduleSave();
        return;
      }
      if (q.length < 2) {
        stop.here = true;
        stop.query = hereDisplay();
        stop.label = hereDisplay();
        if (S.here) { stop.lat = S.here.lat; stop.lng = S.here.lng; }
        if (!q) showHereSuggest();
        return;
      }
    }
    stop.query=input.value; stop.lat=null; stop.lng=null; stop.label=""; stop.here=false;
    input.classList.toggle("unresolved",!!input.value.trim());
    clearTimeout(S.suggestTimer);
    if (q.length<2) { if(S.here&&!q) showHereSuggest(); else hideSuggest(); return; }
    S.suggestTimer = setTimeout(async ()=>{
      // Show loading spinner immediately
      const box = $("suggestBox");
      box.innerHTML = `<div class="sug-loading"><span class="sug-spinner"></span>Searching…</div>`;
      box._hits = null;
      box.classList.remove("hidden");
      positionSuggest();
      try {
        const hits = dedupeHits(await lookup(q));
        if (S.focusId!==id) return;
        box.innerHTML = renderSuggestRows(hits);
        box._hits = hits;
        if (!hits.length) {
          // Keep "No results" visible briefly then hide
          setTimeout(()=>{ if($("suggestBox").querySelector(".sug-empty")) hideSuggest(); }, 2000);
        }
        box.classList.remove("hidden");
        positionSuggest();
      } catch(err) { if(!err.cancelled) hideSuggest(); }
    }, 200);
  });

  input.addEventListener("keydown", async e => {
    if (e.key==="Escape") { hideSuggest(); input.blur(); return; }
    if (e.key!=="Enter") return;
    e.preventDefault();
    const q = input.value.trim();
    if (!q) return;
    // If there's already a result in the suggest box, use the first one
    const firstHit = ($("suggestBox")._hits||[])[0];
    if (firstHit) { applyHit(firstHit); return; }
    clearTimeout(S.suggestTimer);
    try { const hits=await lookup(q); if(hits[0]) applyHit(hits[0]); }
    catch(err) { if(!err.cancelled) toast(err.message); }
  });
}

/* ─── stop list events ─── */
$("stopList").addEventListener("click", e => {
  const del = e.target.closest(".del-btn");
  if (del&&S.trip) {
    const i = S.trip.stops.findIndex(s=>s.id===del.dataset.id);
    if (i<0) return;
    if (isHereStop(S.trip.stops[i])) return toast("Your location stays as the start");
    buzz();
    const prev = JSON.parse(JSON.stringify(S.trip.stops));
    if (S.trip.stops.length<=2) S.trip.stops[i]={id:uid(),query:"",label:"",lat:null,lng:null};
    else S.trip.stops.splice(i,1);
    syncStops(true); scheduleSave(); scheduleRoute(false);
    toast("Stop removed",()=>{ if (!S.trip) return; S.trip.stops=prev; syncStops(true); scheduleSave(); scheduleRoute(false); });
  }
});

$("stopList").addEventListener("pointerdown", e => {
  const grip = e.target.closest(".grip-btn");
  if (!grip || !S.trip) return;
  const row = grip.closest(".stop-row");
  if (!row) return;
  const stop = S.trip.stops.find(s => s.id === row.dataset.id);
  if (isHereStop(stop)) return;

  e.preventDefault();
  e.stopPropagation();
  const list = $("stopList");
  list.classList.add("reordering");
  row.classList.add("dragging");
  const pointerId = e.pointerId;
  try { row.setPointerCapture(pointerId); } catch {}

  const move = ev => {
    if (ev.pointerId !== pointerId) return;
    ev.preventDefault();
    const y = ev.clientY;
    const others = [...list.querySelectorAll(".stop-row")].filter(r => r !== row);
    const hereRow = others.find(r => isHereStop(S.trip.stops.find(s => s.id === r.dataset.id)));
    let placed = false;
    for (const r of others) {
      if (r === hereRow) continue;
      const b = r.getBoundingClientRect();
      if (y < b.top + b.height / 2) { list.insertBefore(row, r); placed = true; break; }
    }
    if (!placed) list.appendChild(row);
    if (hereRow && list.firstElementChild !== hereRow) list.insertBefore(hereRow, list.firstElementChild);
  };
  const up = ev => {
    if (ev && ev.pointerId !== pointerId) return;
    row.removeEventListener("pointermove", move);
    row.removeEventListener("pointerup", up);
    row.removeEventListener("pointercancel", up);
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
    list.classList.remove("reordering");
    row.classList.remove("dragging");
    const byId = Object.fromEntries(S.trip.stops.map(s => [s.id, s]));
    S.trip.stops = [...list.querySelectorAll(".stop-row")].map(r => byId[r.dataset.id]).filter(Boolean);
    pinHereFirst();
    syncStops(true);
    scheduleSave(); scheduleRoute(false); buzz();
  };
  row.addEventListener("pointermove", move, { passive: false });
  row.addEventListener("pointerup", up);
  row.addEventListener("pointercancel", up);
  window.addEventListener("pointermove", move, { passive: false });
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
}, { passive: false });

/* ─── action bar ─── */
$("btnAddStop").onclick = () => {
  if (!S.trip) return;
  const stops = S.trip.stops;
  const destLike = !S.trip.roundtrip && stops.length >= 2;
  const neu = { id:uid(), query:"", label:"", lat:null, lng:null };
  if (destLike) stops.splice(stops.length-1, 0, neu); else stops.push(neu);
  syncStops(true); scheduleSave(); setSnap("full");
  // Focus and scroll the new stop into view
  setTimeout(() => {
    const inputs = $("stopList").querySelectorAll(".stop-input");
    const target = destLike ? inputs[inputs.length-2] : inputs[inputs.length-1];
    if (target) {
      target.focus();
      target.closest(".stop-row")?.scrollIntoView({ block:"nearest" });
    }
  }, 60);
};

$("btnPaste").onclick = () => { if (!S.trip) return; openModal("Paste addresses", pasteBody()); };
$("btnReverse").onclick = () => {
  if (!S.trip) return;
  compactEmptyStops();
  S.trip.stops.reverse();
  pinHereFirst();
  syncStops(true); scheduleSave(); scheduleRoute(false);
  toast("Order reversed");
  _analytics?.ping("reverse");
};
$("btnOptimise").onclick = () => {
  if (!S.trip || S.routing) return;
  compactEmptyStops();
  pinHereFirst();
  syncStops(true);
  if (geocodedStops().length<3) return toast("Add at least 3 places first");
  $("btnOptimise").classList.add("loading");
  _analytics?.ping("optimise", { stops: geocodedStops().length });
  scheduleRoute(true);
};
$("btnShare").onclick = () => { if (!S.trip) return; shareTrip(); _analytics?.ping("share"); };
$("btnMore").onclick  = () => { if (!S.trip) return; openModal("More", moreBody()); };

/* ─── map toggle ─── */
$("btnMapToggle").onclick = () => {
  if (S.snap==="full") { document.activeElement?.blur(); hideSuggest(); setSnap("mid"); drawMap(true); }
  else {
    setSnap("full");
    setTimeout(() => {
      const inputs = [...$("stopList").querySelectorAll(".stop-input")];
      const empty = inputs.find(el => !el.readOnly && !el.value.trim());
      (empty || inputs.find(el => !el.readOnly) || inputs[0])?.focus();
    }, 200);
  }
};

/* ─── start / nav ─── */
$("btnStart").onclick = () => {
  if (geocodedStops().length < 2) return toast("Add at least two places first");
  S.navigating=true; S.navI=0; updateNav(); drawMap(true); goLeg();
  _analytics?.ping("navigate", { stops: geocodedStops().length });
};
$("btnNext").onclick = () => {
  const pts = geocodedStops();
  if (S.navI>=pts.length-1) { S.navigating=false; updateNav(); drawMap(true); return; }
  S.navI++; updateNav(); drawMap(true);
  if (S.navI<pts.length-1) goLeg();
};

/* ─── back / locate ─── */
function backToList() {
  hideSuggest();
  closeModal();
  saveTrip();
  S.navigating=false;
  showList();
}
$("btnBack").onclick = () => {
  if (!$("modal").classList.contains("hidden")) { closeModal(); return; }
  if (!$("suggestBox").classList.contains("hidden")) { hideSuggest(); document.activeElement?.blur(); return; }
  if (history.state?.tp === 1) { history.back(); return; }
  backToList();
};
window.addEventListener("popstate", () => {
  if ($("tripScreen").classList.contains("is-open")) backToList();
});
$("btnLocate").onclick = () => {
  if (!S.here) return toast("Location unavailable");
  S.map?.setView([S.here.lat,S.here.lng],15);
};

document.addEventListener("keydown", e => {
  if (e.key !== "Escape") return;
  if (!$("modal").classList.contains("hidden")) { closeModal(); return; }
  hideSuggest();
});

/* ─── search ─── */
$("tripSearch").addEventListener("input",e=>{ S.filter=e.target.value; renderList(); });
$("btnNew").onclick      = newTrip;
$("btnEmptyNew").onclick = newTrip;
$("tripList").addEventListener("click",e=>{
  const row=e.target.closest("[data-id]");
  if (row) openTrip(row.dataset.id);
});

/* ─── swipe-to-delete trips ─── */
(()=>{
  const list=$("tripList");
  let sx=0,sy=0,row=null;
  list.addEventListener("touchstart",e=>{ row=null; const r=e.target.closest(".trip-row"); if(r){row=r;sx=e.changedTouches[0].clientX;sy=e.changedTouches[0].clientY;}},{passive:true});
  list.addEventListener("touchend",e=>{
    if(!row)return;
    const dx=e.changedTouches[0].clientX-sx, dy=Math.abs(e.changedTouches[0].clientY-sy);
    if(dx<-72&&dy<48){
      const id=row.dataset.id;
      const prev=(S.records||[]).slice();
      setRecords(prev.filter(t=>t.id!==id));
      renderList();
      toast("Trip deleted",()=>{setRecords(prev);renderList();});
    }
    row=null;
  },{passive:true});
})();

/* ─── modal body builders ─── */
function pasteBody() {
  return `<div class="modal-pad">
    <p class="modal-hint">One address or business per line. Up to 200 stops at once.</p>
    <textarea id="pasteBox" class="modal-textarea" placeholder="Bunnings Warehouse Geebung&#10;12 Queen St Brisbane&#10;Woolworths Townsville"></textarea>
    <div class="modal-actions">
      <button id="pasteGo" class="btn-primary" style="flex:1">Add stops</button>
      <button id="pasteCancel" class="btn-secondary">Cancel</button>
    </div>
  </div>`;
}

function pinPickerBody(pinKey) {
  // Only geocoded stops can be saved as pins (need lat/lng)
  const pts = geocodedStops();
  if (!pts.length) return `<div class="modal-pad"><p class="modal-hint">Add and select at least one place in this trip first, then set it as ${pinKey === "home" ? "Home" : "Work"}.</p></div>`;
  const label = pinKey === "home" ? "Home" : "Work";
  const rows = pts.map((s, i) => {
    const name = esc((s.label || s.query).split(",")[0]);
    const addr = esc(s.label || s.query);
    return `<button class="mrow" data-pin-save="${pinKey}" data-pin-i="${i}">
      <span>${name}<br><span style="font-size:13px;color:var(--t3)">${addr}</span></span>
    </button>`;
  }).join("");
  return `<div class="msec">${rows}</div>
  <div class="modal-pad"><p class="modal-hint" style="margin:0">Tap a stop to save it as ${label}.</p></div>`;
}

function chk(on) {
  return `<span class="mrow-check">${on?`<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="#fff" stroke-width="2.5"><path d="M4 12l5 5L20 7"/></svg>`:""}</span>`;
}

function ico(svg) { return `<span class="mrow-ico">${svg}</span>`; }
function moreBody() {
  const t    = S.trip;
  const pins = readPins();
  const homeLabel = (pins.home?.label||"Not set").split(",")[0];
  const workLabel = (pins.work?.label||"Not set").split(",")[0];
  const starSvg = `<svg viewBox="0 0 24 24" width="16" height="16" fill="${t.starred?"currentColor":"none"}" stroke="currentColor" stroke-width="2"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 21 12 17.77 5.82 21 7 14.14 2 9.27l6.91-1.01z"/></svg>`;
  return `
  <div class="modal-field">
    <label>Trip name</label>
    <input id="renameTitle" value="${esc(t.title||"")}" placeholder="Untitled trip"/>
  </div>
  <div class="msec">
    <button class="mrow" data-more="star">${ico(starSvg)}${t.starred?"Starred":"Star this trip"}<span class="mrow-sub">${t.starred?"★":""}</span></button>
    <button class="mrow${t.roundtrip?" checked":""}" data-more="round">${ico(`<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 1l4 4-4 4M7 23l-4-4 4-4"/><path d="M3 11V9a4 4 0 0 1 4-4h14M21 13v2a4 4 0 0 1-4 4H3"/></svg>`)}Round trip${chk(t.roundtrip)}</button>
  </div>
  <div class="msec">
    <button class="mrow${t.avoidTolls?" checked":""}" data-more="tolls">${ico(`<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M12 11v6M9 14h6"/><path d="M7 7V5a5 5 0 0 1 10 0v2"/></svg>`)}Avoid tolls${chk(t.avoidTolls)}</button>
    <button class="mrow${t.avoidFerries?" checked":""}" data-more="ferries">${ico(`<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 21c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1 .6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"/><path d="M19 11H5L3 8h18z"/><path d="M12 3v5M8 8V5h8v3"/></svg>`)}Avoid ferries${chk(t.avoidFerries)}</button>
    <button class="mrow" data-more="refresh">${ico(`<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>`)}Refresh route</button>
  </div>
  <div class="msec">
    <button class="mrow" data-more="home">${ico(`<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/></svg>`)}Home<span class="mrow-sub">${esc(homeLabel)}</span></button>
    <button class="mrow" data-more="work">${ico(`<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/></svg>`)}Work<span class="mrow-sub">${esc(workLabel)}</span></button>
  </div>
  <div class="msec">
    <button class="mrow" data-more="waze">${ico(`<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="10" r="7"/><path d="M12 17v4M8 21h8"/><circle cx="10" cy="9" r="1" fill="currentColor"/><circle cx="14" cy="9" r="1" fill="currentColor"/><path d="M10 12s.5 1 2 1 2-1 2-1"/></svg>`)}Open in Waze</button>
    <button class="mrow" data-more="google">${ico(`<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a7 7 0 0 0-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 0 0-7-7z"/><circle cx="12" cy="9" r="2.5"/></svg>`)}Open in Google Maps</button>
  </div>
  <div class="msec">
    <button class="mrow" data-more="dup">${ico(`<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`)}Duplicate trip</button>
    <button class="mrow" data-more="clear">${ico(`<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>`)}Clear all stops</button>
    <button class="mrow" data-more="export">${ico(`<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`)}Export backup</button>
    <button class="mrow" data-more="import">${ico(`<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`)}Import backup</button>
  </div>
  <div class="msec" style="margin-bottom:0">
    <button class="mrow danger" data-more="del">${ico(`<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>`)}Delete trip</button>
  </div>`;
}

/* ─── modal events ─── */
$("modalBody").addEventListener("click", e => {
  if (e.target.id==="pasteCancel") return closeModal();
  if (e.target.id==="pasteGo")     return pasteAddresses();

  // Pin picker (Home / Work)
  const pinSave = e.target.closest("[data-pin-save]");
  if (pinSave) {
    const key = pinSave.dataset.pinSave;
    const i   = Number(pinSave.dataset.pinI);
    const s   = geocodedStops()[i];
    if (s) {
      setPin(key, { label: s.label||s.query, lat: s.lat, lng: s.lng });
      closeModal();
      toast(`${key === "home" ? "Home" : "Work"} saved`);
    }
    return;
  }

  const more = e.target.closest("[data-more]");
  if (!more) return;
  const act = more.dataset.more;
  const handlers = {
    star()    { S.trip.starred=!S.trip.starred; closeModal(); scheduleSave(); renderList(); toast(S.trip.starred?"Starred":"Unstarred"); },
    tolls()   { S.trip.avoidTolls=!S.trip.avoidTolls; closeModal(); scheduleSave(); scheduleRoute(false); },
    ferries() { S.trip.avoidFerries=!S.trip.avoidFerries; closeModal(); scheduleSave(); scheduleRoute(false); },
    refresh() { closeModal(); scheduleRoute(false); toast("Refreshing route…"); },
    round()   { S.trip.roundtrip=!S.trip.roundtrip; closeModal(); syncStops(true); scheduleSave(); scheduleRoute(false); },
    clear()   {
      closeModal();
      const prev=JSON.parse(JSON.stringify(S.trip.stops));
      S.trip.stops=[{id:uid(),query:"",label:"",lat:null,lng:null},{id:uid(),query:"",label:"",lat:null,lng:null}];
      applyLocationToFirstStop();
      syncStops(true); scheduleSave(); scheduleRoute(false);
      toast("Stops cleared",()=>{ if (!S.trip) return; S.trip.stops=prev; syncStops(true); scheduleSave(); scheduleRoute(false); });
    },
    home()    {
      openModal("Set Home", pinPickerBody("home"));
    },
    work()    {
      openModal("Set Work", pinPickerBody("work"));
    },
    export()  { closeModal(); exportBackup(); },
    import()  { closeModal(); pickBackupFile(); },
    dup()     { const c=JSON.parse(JSON.stringify(S.trip)); c.id=uid(); c.title=`${c.title||"Trip"} copy`; c.createdAt=c.updatedAt=Date.now(); c.stops=(c.stops||[]).map(s=>({...s,id:uid()})); setRecords([c,...(S.records||[])]); closeModal(); openTrip(c.id); toast("Duplicated"); },
    waze()    { closeModal(); openExternal("waze"); },
    google()  { closeModal(); openExternal("google"); },
    del()     {
      const id=S.trip.id, prev=(S.records||readLocal()).slice();
      setRecords(prev.filter(t=>t.id!==id));
      closeModal();
      S.trip=null; S.route=null; S.navigating=false;
      $("stopList").innerHTML="";
      showList(); renderList();
      try { if (history.state?.tp === 1) history.back(); } catch {}
      toast("Trip deleted",()=>{ setRecords(mergeTrips(prev,S.records||[])); renderList(); });
      _analytics?.ping("delete");
    },
  };
  handlers[act]?.();
});

$("modalBody").addEventListener("input", e => {
  if (e.target.id!=="renameTitle"||!S.trip) return;
  S.trip.title=e.target.value; scheduleSave(); updateSummary();
});

/* ─── paste ─── */
async function pasteAddresses() {
  const lines=($("pasteBox")?.value||"").split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  if (!lines.length) return;
  closeModal();
  toast(`Finding ${lines.length} place${lines.length===1?"":"s"}…`);
  try {
    _analytics?.ping("paste", { lines: lines.length });
    const data=await api("/api/geocode",{method:"POST",timeout:60000,body:JSON.stringify({lines,lat:S.here?.lat??S.bias.lat,lng:S.here?.lng??S.bias.lng})});
    if (!S.trip) return;
    const built=(data.results||[]).map(r=>({id:uid(),query:r.hit?.label||r.query,label:r.hit?.label||r.query,lat:r.hit?.lat??null,lng:r.hit?.lng??null}));
    if (!filledStops().length) { S.trip.stops=built.length>=2?built:[...built,{id:uid(),query:"",label:"",lat:null,lng:null}]; }
    else if (S.trip.roundtrip) S.trip.stops.push(...built);
    else S.trip.stops.splice(Math.max(1,S.trip.stops.length-1),0,...built);
    const missed=built.filter(s=>!s.lat).length;
    syncStops(true); setSnap("mid"); scheduleSave(); scheduleRoute(false);
    toast(missed?`Added ${built.length}. ${missed} need a tap to fix.`:`Added ${built.length} stop${built.length===1?"":"s"}`);
  } catch(err) { if(!err.cancelled) toast(err.message); }
}

/* ─── share ─── */
function shareTrip() {
  const pts=geocodedStops();
  if (pts.length<2) return toast("Add a route first");
  const lines=pts.map((s,i)=>`${i+1}. ${s.label||s.query}`);
  const head=S.trip.title&&S.trip.title!=="Untitled trip"?S.trip.title:"Trip";
  const stats=S.route?`${fmtDur(S.route.durationS)} · ${fmtKm(S.route.distanceM)}`:"";
  const payload=encodeURIComponent(JSON.stringify({title:head,stops:pts.map(s=>({label:s.label||s.query,lat:s.lat,lng:s.lng}))}));
  const baseUrl=`${location.origin}${location.pathname.replace(/\/$/, "")}`;
  const link=payload.length<1800?`${baseUrl}?import=${payload}`:"";
  const text=`${head}${stats?`\n${stats}`:""}\n\n${lines.join("\n")}${link?`\n\n${link}`:""}`;
  if (navigator.share) { navigator.share({title:head,text,url:link||undefined}).catch(()=>{}); return; }
  if (navigator.clipboard) { navigator.clipboard.writeText(text).then(()=>toast(link?"Copied trip + link":"Copied to clipboard")).catch(()=>toast("Couldn't copy")); }
  else toast("Share not supported on this browser");
}

/* ─── export / import ─── */
function exportBackup() {
  const json=JSON.stringify({trips:S.records||readLocal(),pins:readPins()},null,2);
  const filename=`trips-backup-${new Date().toISOString().slice(0,10)}.json`;
  // Use Web Share API on iOS where anchor download doesn't work
  if (navigator.share && /iP(hone|ad|od)/.test(navigator.userAgent)) {
    const file=new File([json],filename,{type:"application/json"});
    navigator.share({files:[file],title:filename}).catch(()=>{});
    return;
  }
  const blob=new Blob([json],{type:"application/json"});
  const a=document.createElement("a"); a.href=URL.createObjectURL(blob);
  a.download=filename; document.body.appendChild(a); a.click();
  setTimeout(()=>{ document.body.removeChild(a); URL.revokeObjectURL(a.href); },300);
  toast("Backup saved");
}
function importBackupFile(file) {
  const reader=new FileReader();
  reader.onload=()=>{
    try {
      const data=JSON.parse(String(reader.result||"{}"));
      const incoming=Array.isArray(data.trips)?data.trips:data.stops?[data]:[];
      if (!incoming.length) return toast("No trips in file");
      const norm=incoming.map(t=>({...emptyTrip(),...t,id:uid(),stops:(t.stops||[]).map(s=>({id:uid(),query:s.label||s.query||"",label:s.label||s.query||"",lat:s.lat??null,lng:s.lng??null})),updatedAt:Date.now(),createdAt:t.createdAt||Date.now()}));
      if (data.pins&&typeof data.pins==="object") writePins({...readPins(),...data.pins});
      setRecords(mergeTrips(norm,S.records||readLocal())); renderList();
      toast(`Imported ${norm.length} trip${norm.length===1?"":"s"}`);
    } catch { toast("Couldn't read that file"); }
  };
  reader.readAsText(file);
}
function pickBackupFile() {
  const input=document.createElement("input"); input.type="file"; input.accept="application/json,.json";
  input.onchange=()=>{ if(input.files?.[0]) importBackupFile(input.files[0]); }; input.click();
}

/* ─── routing ─── */
function scheduleRoute(optimize) {
  clearTimeout(S.routeTimer);
  S.routeTimer=setTimeout(()=>routeNow(optimize),optimize?40:260);
}
async function routeNow(optimize) {
  if (!S.trip) return;
  const pts=geocodedStops();
  const seq=++S.routeSeq;
  if (pts.length<2) {
    S.route=null; S.routing=false; drawMap(true); updateRowMeta(); return;
  }
  S.routing=true; updateSummary();
  try {
    const data=await api("/api/route",{method:"POST",timeout:35000,body:JSON.stringify({
      points:pts.map(p=>({lat:p.lat,lng:p.lng})),
      optimize, roundtrip:!!S.trip.roundtrip, lockStart:isHereStop(pts[0]),
      avoidTolls:!!S.trip.avoidTolls, avoidFerries:!!S.trip.avoidFerries,
    })});
    if (seq!==S.routeSeq || !S.trip) return;
    if (optimize&&Array.isArray(data.order)&&data.order.length===pts.length) {
      const geocodedIds = new Set(pts.map(p=>p.id));
      const reordered   = data.order.map(i=>pts[i]).filter(Boolean);
      const same = data.order.every((v,i)=>v===i);
      let ri = 0;
      S.trip.stops = S.trip.stops.map(s => geocodedIds.has(s.id) ? reordered[ri++] : s).filter(Boolean);
      pinHereFirst();
      nudgeDismissed = true;
      $("optimiseNudge")?.classList.add("hidden");
      syncStops(true);
      toast(same ? "Already the shortest drive" : "Reordered for a shorter drive");
    }
    S.route=data; S.trip.distanceM=data.distanceM; S.trip.durationS=data.durationS;
    if (!optimize) _analytics?.ping("route", { stops: pts.length, km: Math.round((data.distanceM||0)/1000) });
    drawMap(true); scheduleSave();
  } catch(err) {
    if (seq!==S.routeSeq||err.cancelled) return;
    toast(err.message);
  } finally {
    if (seq===S.routeSeq) {
      S.routing=false;
      $("btnOptimise")?.classList.remove("loading");
      updateRowMeta();
    }
  }
}

/* ─── map ─── */
function ensureMap() {
  if (S.map) return;
  S.map=L.map("map",{
    zoomControl:false,
    attributionControl:false,
    tap:false,
    bounceAtZoomLimits:false,
    inertia:true,
    zoomSnap:0,
  }).setView([S.bias.lat,S.bias.lng],11);
  const dark = window.matchMedia?.("(prefers-color-scheme: dark)")?.matches;
  L.tileLayer(dark
    ? "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
    : "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
    { maxZoom: 20 }).addTo(S.map);
  S.map.on("click", () => {
    if (document.activeElement && document.activeElement !== document.body) {
      document.activeElement.blur();
      hideSuggest();
    }
  });
}
function mapPad() {
  const h = $("tripScreen").classList.contains("is-open") ? ($("sheet").offsetHeight || 200) : 24;
  return {paddingTopLeft:[16,64],paddingBottomRight:[16,h+10]};
}
function drawMap(fit) {
  ensureMap();
  S.markers.forEach(m=>m.remove()); S.markers=[];
  if (S.lineOutline) { S.lineOutline.remove(); S.lineOutline=null; }
  if (S.line) { S.line.remove(); S.line=null; }
  if (S.hereDot) { S.hereDot.remove(); S.hereDot=null; }
  const pts=geocodedStops();
  pts.forEach((s,i) => {
    const last=i===pts.length-1&&!S.trip?.roundtrip;
    const active=S.navigating&&i===Math.min(S.navI+1,pts.length-1);
    const cls=`map-pin${i===0?" pin-origin":last?" pin-dest":""}${active?" pin-active":""}`;
    const icon=L.divIcon({className:"",html:`<div class="${cls}">${i+1}</div>`,iconSize:[28,28],iconAnchor:[14,14]});
    const mk=L.marker([s.lat,s.lng],{icon}).addTo(S.map);
    mk.on("click",()=>{ S.focusId=s.id; setSnap("full"); const inp=$("stopList").querySelector(`.stop-input[data-id="${s.id}"]`); inp?.scrollIntoView({block:"center"}); inp?.focus(); });
    S.markers.push(mk);
  });
  if (S.here) {
    S.hereDot=L.circleMarker([S.here.lat,S.here.lng],{radius:7,color:"#fff",weight:2.5,fillColor:"#1A73E8",fillOpacity:1}).addTo(S.map);
  }
  if (!fit) return;
  const pad=mapPad();
  try {
    if (S.route?.geometry?.length) {
      // White outline for visibility on all map tiles
      S.lineOutline=L.polyline(S.route.geometry,{color:"#fff",weight:9,opacity:.55}).addTo(S.map);
      S.line=L.polyline(S.route.geometry,{color:"#1A73E8",weight:5.5,opacity:.96}).addTo(S.map);
      S.map.fitBounds(S.line.getBounds(),pad);
    } else if (pts.length===1) S.map.setView([pts[0].lat,pts[0].lng],14);
    else if (pts.length>1) S.map.fitBounds(L.latLngBounds(pts.map(p=>[p.lat,p.lng])),pad);
  } catch {}
}

/* ─── external nav ─── */
function mapsQuery(s) {
  return Number.isFinite(s.lat)&&Number.isFinite(s.lng)?`${s.lat},${s.lng}`:encodeURIComponent(s.label||s.query||"");
}
function goLeg() {
  const pts=geocodedStops();
  if (S.navI>=pts.length-1) return;
  const b=pts[S.navI+1];
  location.href=`https://waze.com/ul?ll=${b.lat},${b.lng}&navigate=yes`;
}
function openExternal(kind) {
  const pts=geocodedStops();
  if (pts.length<2) return toast("Need a route first");
  if (kind==="waze") {
    // Waze deeplink supports multi-stop via navigate URL with stop params
    const dest=pts[pts.length-1];
    const stopParams=pts.slice(1,-1).map((p,i)=>`stop${i+1}_lat=${p.lat}&stop${i+1}_lon=${p.lng}`).join("&");
    const base=`https://waze.com/ul?ll=${dest.lat},${dest.lng}&navigate=yes`;
    location.href = stopParams ? `${base}&${stopParams}` : base;
    return;
  }
  const u=new URL("https://www.google.com/maps/dir/");
  u.searchParams.set("api","1"); u.searchParams.set("origin",mapsQuery(pts[0]));
  u.searchParams.set("destination",mapsQuery(pts[pts.length-1])); u.searchParams.set("travelmode","driving");
  const mid=pts.slice(1,-1).slice(0,8).map(p=>mapsQuery(p)).join("|");
  if (mid) u.searchParams.set("waypoints",mid);
  location.href=u.toString();
}

/* ─── sheet drag ─── */
(()=>{
  const handle = $("sheetHandle");
  const sheet  = $("sheet");
  let startY = null, startH = 0, lastY = 0, velY = 0, lastT = 0;

  handle.addEventListener("pointerdown", e => {
    e.preventDefault();
    startY = e.clientY;
    lastY  = e.clientY;
    lastT  = Date.now();
    velY   = 0;
    startH = sheet.getBoundingClientRect().height;
    sheet.classList.add("no-transition");
    handle.setPointerCapture(e.pointerId);
  }, { passive: false });

  handle.addEventListener("pointermove", e => {
    if (startY === null) return;
    const now = Date.now();
    const dt  = Math.max(1, now - lastT);
    velY  = (e.clientY - lastY) / dt;   // px/ms — positive = dragging down
    lastY = e.clientY;
    lastT = now;
    const next = Math.min(window.innerHeight - 48, Math.max(120, startH - (e.clientY - startY)));
    sheet.style.height = `${next}px`;
  }, { passive: true });

  const finish = e => {
    if (startY === null) return;
    const dragDelta = startY - (e.clientY ?? lastY); // positive = dragged up
    const h   = startH + dragDelta;
    const max = window.innerHeight;

    sheet.style.height = "";
    sheet.classList.remove("no-transition");

    // Use velocity to determine intent: flick up → full, flick down → collapse/mid
    if (velY < -0.6) {
      // Fast flick upward
      setSnap("full");
    } else if (velY > 0.6) {
      // Fast flick downward
      setSnap(startH > max * 0.5 ? "mid" : "collapsed");
    } else {
      // Settle by position
      if      (h > max * 0.68) setSnap("full");
      else if (h < max * 0.28) setSnap("collapsed");
      else                      setSnap("mid");
    }
    startY = null;
  };

  handle.addEventListener("pointerup",     finish, { passive: true });
  handle.addEventListener("pointercancel", finish, { passive: true });
})();

/* ─── keyboard / viewport ─── */
if (window.visualViewport) {
  const pinKb=()=>{
    const v=window.visualViewport;
    const kb=Math.max(0,window.innerHeight-v.height-v.offsetTop);
    document.documentElement.style.setProperty("--kb",`${kb>48?kb:0}px`);
    if (!$("suggestBox").classList.contains("hidden")) positionSuggest();
    S.map?.invalidateSize({ animate: false });
  };
  window.visualViewport.addEventListener("resize",pinKb);
  window.visualViewport.addEventListener("scroll",pinKb);
}

/* ─── geolocation ─── */
function applyLocationToFirstStop() {
  if (!S.here || !S.trip) return;
  const first = S.trip.stops[0];
  if (!first || (first.label || first.query || "").trim()) return;
  first.query = hereDisplay();
  first.label = hereDisplay();
  first.lat = S.here.lat;
  first.lng = S.here.lng;
  first.here = true;
  const input = $("stopList").querySelector(`.stop-input[data-id="${first.id}"]`);
  if (input) { input.value = hereDisplay(); input.classList.remove("unresolved"); }
  updateRowMeta(); scheduleSave(); scheduleRoute(false);
}

function compactEmptyStops() {
  if (!S.trip) return;
  const keep = S.trip.stops.filter(s => isHereStop(s) || (s.label||s.query||"").trim() || Number.isFinite(s.lat));
  while (keep.length < 2) keep.push({id:uid(),query:"",label:"",lat:null,lng:null});
  S.trip.stops = keep;
}

function pinHereFirst() {
  if (!S.trip) return false;
  const idxs = [];
  S.trip.stops.forEach((s, i) => { if (isHereStop(s)) idxs.push(i); });
  if (!idxs.length) return false;
  for (let k = idxs.length - 1; k >= 1; k--) {
    const extra = S.trip.stops[idxs[k]];
    extra.here = false;
    extra.query = "";
    extra.label = "";
    extra.lat = null;
    extra.lng = null;
  }
  const i = S.trip.stops.findIndex(isHereStop);
  if (i < 0) return false;
  const moved = S.trip.stops[i];
  moved.here = true;
  moved.query = hereDisplay();
  moved.label = hereDisplay();
  if (i === 0) return false;
  S.trip.stops.splice(i, 1);
  S.trip.stops.unshift(moved);
  return true;
}

function locate() {
  if (!navigator.geolocation) return;
  let locDenied = false;
  navigator.geolocation.watchPosition(async pos => {
    const firstFix = !S.here;
    S.here={lat:pos.coords.latitude,lng:pos.coords.longitude};
    S.bias={...S.here};
    if (!S.hereLabel||S.hereLabel==="Your location") {
      try {
        const d=await api(`/api/reverse?lat=${S.here.lat}&lon=${S.here.lng}`,{timeout:8000});
        if(d.hit?.label) S.hereLabel=d.hit.label;
      } catch {}
    }
    // Keep GPS coords fresh if stop 1 is Your location
    const hereStop = S.trip?.stops.find(isHereStop);
    if (hereStop) {
      hereStop.lat = S.here.lat;
      hereStop.lng = S.here.lng;
      hereStop.query = hereDisplay();
      hereStop.label = hereDisplay();
      hereStop.here = true;
    }
    if (firstFix) applyLocationToFirstStop();
  },(err)=>{
    if (locDenied) return;
    locDenied = true;
    if (err && err.code === 1) toast("Location is off — type a start address");
  },{enableHighAccuracy:true,maximumAge:15000,timeout:12000});
}

/* ─── online/offline ─── */
window.addEventListener("online",  ()=>$("offlineBanner").classList.add("hidden"));
window.addEventListener("offline", ()=>$("offlineBanner").classList.remove("hidden"));
if (!navigator.onLine) $("offlineBanner").classList.remove("hidden");

/* ─── URL import ─── */
function importTripFromUrl() {
  const imp=new URLSearchParams(location.search).get("import");
  if (!imp) return false;
  try {
    const raw=JSON.parse(decodeURIComponent(imp));
    const trip=emptyTrip();
    trip.title=raw.title||"Imported trip";
    trip.stops=(raw.stops||[]).map(s=>({id:uid(),query:s.label||s.query||"",label:s.label||s.query||"",lat:s.lat??null,lng:s.lng??null}));
    if (trip.stops.length<2) trip.stops.push({id:uid(),query:"",label:"",lat:null,lng:null});
    setRecords([trip,...(S.records||[])]);
    history.replaceState({},"",location.pathname);
    openTrip(trip.id); toast("Trip imported"); return true;
  } catch { return false; }
}

/* ─── install prompt ─── */
(function installPrompt() {
  const DISMISS_KEY = "install_dismissed";
  // Already installed as PWA — hide everything
  const isStandalone = window.matchMedia("(display-mode:standalone)").matches
    || window.navigator.standalone === true;
  if (isStandalone) return;
  // Don't nag if user already dismissed in the last 30 days
  const dismissed = Number(localStorage.getItem(DISMISS_KEY) || 0);
  if (Date.now() - dismissed < 30 * 86400000) return;

  const ua = navigator.userAgent;
  const isIOS = /iP(hone|ad|od)/.test(ua) && !/CriOS/.test(ua);
  const isAndroidOrChrome = /Android/.test(ua) || /Chrome/.test(ua);

  function dismiss(key) {
    localStorage.setItem(key || DISMISS_KEY, String(Date.now()));
  }

  if (isIOS) {
    // iOS Safari: show tooltip pointing at Share button in bottom bar
    const tip = $("iosTooltip");
    if (!tip) return;
    // On iPad the Share button is top-right, so flip the arrow
    const isIPad = /iPad/.test(ua) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(ua));
    if (isIPad) {
      tip.style.bottom = "auto";
      tip.style.top = "calc(60px + var(--sat,0px))";
      tip.style.right = "16px";
      tip.style.left = "auto";
      tip.style.transform = "none";
      const arrow = tip.querySelector(".ios-tooltip-arrow");
      if (arrow) {
        arrow.style.borderTop = "none";
        arrow.style.borderBottom = "10px solid rgba(28,28,30,.94)";
        arrow.style.order = "-1";
      }
    }
    setTimeout(() => tip.classList.remove("hidden"), 1200);
    $("iosClose")?.addEventListener("click", () => {
      tip.classList.add("hidden");
      dismiss(DISMISS_KEY);
    });
    // Auto-hide after 12s
    setTimeout(() => tip.classList.add("hidden"), 13000);

  } else if (isAndroidOrChrome) {
    // Android/Chrome: listen for beforeinstallprompt
    let deferredPrompt = null;
    window.addEventListener("beforeinstallprompt", (e) => {
      e.preventDefault();
      deferredPrompt = e;
      setTimeout(() => $("installBanner").classList.remove("hidden"), 1200);
    });

    $("installBtn").addEventListener("click", async () => {
      $("installBanner").classList.add("hidden");
      if (deferredPrompt) {
        deferredPrompt.prompt();
        const { outcome } = await deferredPrompt.userChoice;
        if (outcome === "accepted") dismiss(DISMISS_KEY);
        deferredPrompt = null;
      }
    });

    $("installDismiss").addEventListener("click", () => {
      $("installBanner").classList.add("hidden");
      dismiss(DISMISS_KEY);
    });

    // If already installed via appinstalled event
    window.addEventListener("appinstalled", () => {
      $("installBanner").classList.add("hidden");
    });
  }
})();

/* ─── analytics ─── */
const _analytics = (function() {
  const DID_KEY = "maps.did";
  const sid = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const ua = navigator.userAgent || "";
  const platform = /iPhone|iPad|iPod/.test(ua) ? "iOS"
    : /Android/.test(ua) ? "Android"
    : /Mac/.test(ua) ? "Mac"
    : /Win/.test(ua) ? "Windows"
    : /Linux/.test(ua) ? "Linux"
    : "Other";
  const standalone = window.matchMedia("(display-mode:standalone)").matches || window.navigator.standalone === true;
  const sessionMeta = () => ({
    platform,
    standalone,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone || "",
    lang: navigator.language || "",
    w: window.innerWidth,
    h: window.innerHeight,
  });
  let did = "";
  try { did = localStorage.getItem(DID_KEY) || ""; } catch {}
  const queued = [];

  function send(payload) {
    const body = JSON.stringify(payload);
    const blob = new Blob([body], { type: "application/json" });
    if (!navigator.sendBeacon || !navigator.sendBeacon("/api/ping", blob)) {
      fetch("/api/ping", { method:"POST", headers:{ "Content-Type":"application/json" }, body, keepalive:true }).catch(()=>{});
    }
  }

  function ping(kind, meta) {
    const extra = kind === "session" ? { ...sessionMeta(), ...(meta||{}) } : (meta||{});
    if (!did) { queued.push({ kind, meta: extra }); return; }
    send({ sid, did, kind, meta: extra });
  }

  (async () => {
    if (!did) {
      try {
        const rawFp = [navigator.language, screen.width, screen.height, Intl.DateTimeFormat().resolvedOptions().timeZone, navigator.hardwareConcurrency||0, crypto.randomUUID?.()||Date.now()].join("|");
        const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rawFp));
        did = [...new Uint8Array(buf)].map(b=>b.toString(16).padStart(2,"0")).join("").slice(0,32);
      } catch { did = `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`.slice(0,32); }
      try { localStorage.setItem(DID_KEY, did); } catch {}
    }
    queued.splice(0).forEach(q => send({ sid, did, kind: q.kind, meta: q.meta }));
  })();

  setTimeout(() => ping("session"), 400);
  setInterval(() => ping("session"), 4 * 60_000);

  window.addEventListener("error", e => {
    fetch("/api/error", { method:"POST", headers:{ "Content-Type":"application/json" }, body:JSON.stringify({ message: e.message, path: e.filename }), keepalive:true }).catch(()=>{});
  });
  window.addEventListener("unhandledrejection", e => {
    fetch("/api/error", { method:"POST", headers:{ "Content-Type":"application/json" }, body:JSON.stringify({ message: String(e.reason?.message||e.reason||"unknown") }), keepalive:true }).catch(()=>{});
  });

  return { ping };
})();

/* ─── iOS: don't rubber-band the whole page off the map ─── */
document.addEventListener("touchmove", (e) => {
  if (e.touches.length > 1) return;
  const t = e.target;
  if (!(t instanceof Element)) return;
  if (t.closest(".screen-list, .stop-list, .modal-sheet, .action-row, .suggest-box, .leaflet-container, .feed, .users, .errs")) return;
  e.preventDefault();
}, { passive: false });

/* ─── boot ─── */
ensureMap();
locate();
loadTrips().then(()=>{ if(!importTripFromUrl()) renderContinue(); }).catch(()=>{});
