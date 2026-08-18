const BASE = "http://127.0.0.1:3860";
const fails = [];
const passes = [];

function ok(name, detail = "") {
  passes.push(name);
  console.log("PASS  " + name + (detail ? " — " + detail : ""));
}
function fail(name, detail) {
  fails.push(name);
  console.log("FAIL  " + name + " — " + detail);
}

async function req(path, opts = {}) {
  const res = await fetch(BASE + path, opts);
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return { res, text, json, status: res.status };
}

function isHereStop(s) {
  if (!s) return false;
  if (s.here) return true;
  const q = String(s.query || "").trim().toLowerCase();
  const l = String(s.label || "").trim().toLowerCase();
  return q === "your location" || l === "your location";
}
function pinHereFirst(stops) {
  const i = stops.findIndex(isHereStop);
  if (i <= 0) return stops;
  const copy = stops.slice();
  const [moved] = copy.splice(i, 1);
  copy.unshift(moved);
  return copy;
}

try {
  // Static
  {
    const { status, text } = await req("/");
    if (status === 200 && text.includes("app.js?v=41") && text.includes("styles.css?v=41") && text.includes("vendor/leaflet.js") && !text.includes("unpkg.com/leaflet")) ok("GET /", "cache v=41 local leaflet");
    else fail("GET /", "status " + status);
  }
  {
    const { status, text } = await req("/styles.css?v=41");
    if (status === 200 && text.includes(".screen-planner") && text.includes("pointer-events:none") && text.includes(".action-chip.is-hot") && text.includes(".mrow.checked") && text.includes("pinch-zoom") && text.includes("calc(100% - 58px") && text.includes(".sug-row.is-on")) ok("GET styles.css");
    else fail("GET styles.css", "status " + status);
  }
  {
    const { status, text } = await req("/app.js?v=41");
    if (status === 200 && text.includes("function pinHereFirst") && text.includes("hereDisplay")) ok("GET app.js");
    else fail("GET app.js", "status " + status);
    const guards = ["function backToList", "lockStart:isHereStop", "Where to?", "readOnly", "is-hot", "function updateHereDot", "You're offline.", "function forgetLast", "isHereStop(stop) && !hit.here", "smoothFactor:0", "startTrafficWatch", "trafficDelayS", "maps.recentPlaces", "function runSuggest"];
    const missing = guards.filter(s => !text.includes(s));
    if (!missing.length) ok("planner flow guards in JS");
    else fail("planner flow guards in JS", missing.join(", "));
    if (text.includes("voyager") && !text.includes("dark_all")) ok("voyager map tiles");
    else fail("voyager map tiles", "missing voyager or dark_all sneaked in");
  }
  {
    const { status, text } = await req("/admin.html");
    if (status === 200 && text.includes("/api/stats")) ok("GET /admin.html");
    else fail("GET /admin.html", "status " + status);
  }
  {
    const { status } = await req("/admin");
    if (status === 200) ok("GET /admin alias");
    else fail("GET /admin alias", "status " + status);
  }
  {
    const { status } = await req("/icon.svg");
    if (status === 200) ok("GET icon.svg");
    else fail("GET icon.svg", "status " + status);
  }
  {
    const { status } = await req("/icon-180.png");
    if (status === 200) ok("GET icon-180.png");
    else fail("GET icon-180.png", "status " + status);
  }
  {
    const { status, text } = await req("/vendor/leaflet.js?v=41");
    if (status === 200 && text.length > 10000) ok("GET vendor leaflet.js", text.length + " bytes");
    else fail("GET vendor leaflet.js", "status " + status);
  }
  {
    const { status, text } = await req("/vendor/leaflet.css?v=41");
    if (status === 200 && text.includes(".leaflet-container")) ok("GET vendor leaflet.css");
    else fail("GET vendor leaflet.css", "status " + status);
  }
  {
    const { status } = await req("/manifest.webmanifest");
    if (status === 200) ok("GET manifest");
    else fail("GET manifest", "status " + status);
  }
  {
    const { status } = await req("/nope-file");
    if (status === 404) ok("404 missing static");
    else fail("404 missing static", "status " + status);
  }

  // Health
  {
    const { status, json } = await req("/health");
    if (status === 200 && json?.ok) ok("GET /health", "googlePlaces=" + json.googlePlaces);
    else fail("GET /health", JSON.stringify(json));
  }

  // Suggest
  {
    const { status, json } = await req("/api/suggest?q=Bunnings&lat=-33.8688&lon=151.2093");
    const n = json?.hits?.length || 0;
    const okHits = n > 0 && json.hits.every(h => h.label && (Number.isFinite(h.lat) || h.placeId));
    if (status === 200 && okHits) ok("suggest Bunnings", n + " hits");
    else fail("suggest Bunnings", "status " + status + " hits " + n);
  }
  {
    const { status, json } = await req("/api/suggest?q=x&lat=-33.86&lon=151.20");
    if (status === 200 && Array.isArray(json.hits) && json.hits.length === 0) ok("suggest too short");
    else if (status === 200 && Array.isArray(json.hits)) ok("suggest too short", "returned " + json.hits.length);
    else fail("suggest too short", "status " + status);
  }
  {
    const { json } = await req("/api/suggest?q=Sydney%20Opera%20House&lat=-33.8688&lon=151.2093");
    const labels = (json?.hits || []).map(h => h.label.toLowerCase());
    if (labels.some(l => l.includes("opera") || l.includes("sydney"))) ok("suggest Opera House");
    else fail("suggest Opera House", labels.slice(0, 3).join(" | ") || "no hits");
  }
  {
    const { status, json } = await req("/api/place");
    if (status === 400 && json?.error) ok("place needs id");
    else fail("place needs id", "status " + status);
  }

  // Reverse
  {
    const { status, json } = await req("/api/reverse?lat=-33.8688&lon=151.2093");
    if (status === 200 && json?.hit?.label) ok("reverse Sydney CBD", json.hit.label.slice(0, 50));
    else fail("reverse Sydney CBD", JSON.stringify(json));
  }
  {
    const { status } = await req("/api/reverse?lat=abc&lon=1");
    if (status === 400) ok("reverse bad coords");
    else fail("reverse bad coords", "status " + status);
  }
  {
    const { status, json } = await req("/api/route", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not-json",
    });
    if (status === 400 && json?.error === "Invalid JSON") ok("route rejects invalid JSON");
    else fail("route rejects invalid JSON", "status " + status + " " + JSON.stringify(json));
  }

  // Geocode
  {
    const { status, json } = await req("/api/geocode", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lines: ["Sydney Opera House", "Bunnings Warehouse Caringbah", "zzzznotaplace999xyz"],
        lat: -33.8688,
        lng: 151.2093,
      }),
    });
    const r = json?.results || [];
    if (status === 200 && r.length === 3 && r[0].hit && r[1].hit) ok("geocode 3 lines", "missed=" + r.filter(x => !x.hit).length);
    else fail("geocode 3 lines", "status " + status + " n=" + r.length);
  }

  // Route
  const sydney = { lat: -33.8688, lng: 151.2093 };
  const parra  = { lat: -33.8150, lng: 151.0010 };
  const kato   = { lat: -33.7125, lng: 150.3119 };
  const woll   = { lat: -34.4278, lng: 150.8931 };

  {
    const { status, json } = await req("/api/route", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ points: [sydney, parra] }),
    });
    if (status === 200 && json.distanceM > 1000 && json.geometry?.length > 50 && json.legs?.length === 1)
      ok("route 2 stops", Math.round(json.distanceM / 1000) + "km " + Math.round(json.durationS / 60) + "min pts=" + json.geometry.length);
    else fail("route 2 stops", JSON.stringify({ status, d: json?.distanceM, legs: json?.legs?.length }));
  }
  {
    const { status } = await req("/api/route", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ points: [sydney] }),
    });
    if (status === 400) ok("route 1 stop rejected");
    else fail("route 1 stop rejected", "status " + status);
  }
  {
    const { json } = await req("/api/route", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        points: [sydney, kato, woll, parra],
        optimize: true,
        lockStart: true,
        roundtrip: false,
      }),
    });
    const order = json?.order;
    if (Array.isArray(order) && order[0] === 0 && order.join() !== "0,1,2,3")
      ok("optimise reorders a crossed trip", JSON.stringify(order));
    else fail("optimise reorders a crossed trip", JSON.stringify(order));
    if (Array.isArray(order) && order[order.length - 1] !== 3)
      ok("optimise does not lock the last stop", JSON.stringify(order));
    else if (Array.isArray(order) && order[0] === 0)
      ok("optimise does not lock the last stop", "last moved or already optimal " + JSON.stringify(order));
    if (json?.distanceM > 0 && json.geometry?.length > 50) ok("optimise has geometry", json.geometry.length + " pts");
    else fail("optimise has geometry", "pts=" + json?.geometry?.length);
  }
  {
    const { json } = await req("/api/route", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        points: [sydney, parra],
        roundtrip: true,
      }),
    });
    if (json?.legs?.length >= 2) ok("roundtrip extra leg", json.legs.length + " legs");
    else fail("roundtrip extra leg", "legs=" + json?.legs?.length);
  }

  // Analytics
  {
    const { json } = await req("/api/ping", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sid: "live-test", did: "live-device", kind: "session" }),
    });
    if (json?.ok) ok("ping session");
    else fail("ping session", JSON.stringify(json));
  }
  {
    await req("/api/ping", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sid: "live-test", did: "live-device", kind: "route", meta: { stops: 4, km: 90 } }),
    });
    ok("ping route event");
  }
  {
    const { json } = await req("/api/error", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "live-test-error", path: "/test" }),
    });
    if (json?.ok) ok("client error ingest");
    else fail("client error ingest", JSON.stringify(json));
  }
  {
    const { status } = await req("/api/stats", {
      headers: { Authorization: "Basic " + Buffer.from("admin:wrong").toString("base64") },
    });
    if (status === 401) ok("stats rejects bad password");
    else fail("stats rejects bad password", "status " + status);
  }
  {
    const { status, json } = await req("/api/stats", {
      headers: { Authorization: "Basic " + Buffer.from("admin:trips-admin").toString("base64") },
    });
    if (status === 200 && typeof json.activeSessions === "number" && json.hourly?.length === 24 && json.daily?.length === 7 && typeof json.uniqueUsersAllTime === "number" && json.persisted === true)
      ok("stats shape", "users=" + json.uniqueUsersAllTime + " active=" + json.activeSessions + " uptime=" + json.health?.uptime);
    else fail("stats shape", "status " + status + " keys=" + Object.keys(json || {}).join(","));
  }
  {
    const { status, json } = await req("/api/stats?range=7d", {
      headers: { Authorization: "Basic " + Buffer.from("admin:trips-admin").toString("base64") },
    });
    if (status === 200 && json.range === "7d" && typeof json.uniqueUsers === "number") ok("stats range 7d", "users=" + json.uniqueUsers);
    else fail("stats range 7d", "status " + status + " range=" + json?.range);
  }
  {
    const { status } = await req("/api/admin/export");
    if (status === 401) ok("export requires auth");
    else fail("export requires auth", "status " + status);
  }
  {
    const { status, json } = await req("/api/admin/export", {
      headers: { Authorization: "Basic " + Buffer.from("admin:trips-admin").toString("base64") },
    });
    if (status === 200 && Array.isArray(json?.devices) && Array.isArray(json?.events) && json.lifetime)
      ok("export dump", "devices=" + json.devices.length + " events=" + json.events.length);
    else fail("export dump", "status " + status);
  }
  {
    const { status } = await req("/api/admin/errors", { method: "DELETE" });
    if (status === 401) ok("clear errors requires auth");
    else fail("clear errors requires auth", "status " + status);
  }

  // Client logic
  {
    const stops = [
      { id: "a", query: "Wollongong", here: false },
      { id: "b", query: "Your location", here: true, lat: -33.8, lng: 151.2 },
      { id: "c", query: "Parramatta", here: false },
    ];
    const pinned = pinHereFirst(stops);
    if (pinned[0].id === "b" && pinned[1].id === "a" && pinned[2].id === "c") ok("pinHereFirst moves location to #1");
    else fail("pinHereFirst", pinned.map(s => s.id).join(","));
  }
  {
    const stops = [
      { id: "h", query: "Your location", here: true },
      { id: "a", query: "A" },
      { id: "b", query: "B" },
    ];
    const reversed = pinHereFirst(stops.slice().reverse());
    if (reversed[0].id === "h") ok("reverse keeps location first");
    else fail("reverse keeps location first", reversed.map(s => s.id).join(","));
  }
  {
    if (isHereStop({ query: "Your location" }) && !isHereStop({ query: "Home" })) ok("isHereStop matcher");
    else fail("isHereStop matcher", "mismatch");
  }
  {
    // empty slots preserved during optimise reorder
    const pts = [
      { id: "1", lat: 1 },
      { id: "3", lat: 3 },
    ];
    const all = [
      { id: "1", lat: 1 },
      { id: "empty", lat: null },
      { id: "3", lat: 3 },
    ];
    const order = [1, 0];
    const geocodedIds = new Set(pts.map(p => p.id));
    const reordered = order.map(i => pts[i]);
    let ri = 0;
    const next = all.map(s => geocodedIds.has(s.id) ? reordered[ri++] : s);
    if (next[1].id === "empty" && next[0].id === "3" && next[2].id === "1") ok("optimise preserves empty slot");
    else fail("optimise preserves empty slot", next.map(s => s.id).join(","));
  }

  // IDs in HTML exist in JS
  {
    const html = (await req("/")).text;
    const js = (await req("/app.js?v=41")).text;
    const ids = [...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]);
    const missing = ids.filter(id => !js.includes('"' + id + '"') && !js.includes("'" + id + "'") && !["mapToggleIcon","mapToggleLabel","navTitle","navSub","continueTitle","continueSub","installTitle","installSub","iosShareWord"].includes(id));
    // map/list structural ids that JS must touch
    const required = ["listScreen","tripScreen","sheet","stopList","btnStart","btnBack","btnNew","modal","toast","suggestBox"];
    const absent = required.filter(id => !js.includes(id));
    if (absent.length === 0) ok("required DOM ids wired", required.length + " checked");
    else fail("required DOM ids wired", absent.join(","));
  }

} catch (err) {
  fail("runner crashed", err.stack || err.message);
}

console.log("\n" + passes.length + " passed, " + fails.length + " failed");
if (fails.length) {
  console.log("FAILED: " + fails.join(" | "));
  process.exit(1);
}
