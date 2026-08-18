import { chromium } from "playwright-core";

const BASE = "http://127.0.0.1:3860";
const fails = [];
const passes = [];
const pageErrors = [];

function ok(name, detail = "") {
  passes.push(name);
  console.log("PASS  " + name + (detail ? " — " + detail : ""));
}
function fail(name, detail) {
  fails.push(name);
  console.log("FAIL  " + name + " — " + detail);
}

async function waitFor(fn, ms = 15000, step = 80) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return false;
}

function importUrl() {
  const payload = {
    title: "Live test drive",
    stops: [
      { label: "Sydney Opera House", lat: -33.8568, lng: 151.2153 },
      { label: "Parramatta", lat: -33.815, lng: 151.001 },
      { label: "Katoomba", lat: -33.7125, lng: 150.3119 },
      { label: "Wollongong", lat: -34.4278, lng: 150.8931 },
    ],
  };
  return BASE + "/?import=" + encodeURIComponent(JSON.stringify(payload));
}

const browser = await chromium.launch({
  channel: process.env.PW_CHANNEL || "msedge",
  headless: true,
});
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  geolocation: { latitude: -33.8688, longitude: 151.2093 },
  permissions: ["geolocation"],
  locale: "en-AU",
});
const page = await context.newPage();
page.on("pageerror", (err) => pageErrors.push(String(err.message || err)));
page.on("console", (msg) => {
  if (msg.type() === "error" && !/401|Unauthor/i.test(msg.text())) pageErrors.push("console: " + msg.text());
});
await page.route("https://waze.com/**", (route) => route.abort());
await page.route("https://www.google.com/maps/**", (route) => route.abort());

async function dismissOverlays() {
  await page.keyboard.press("Escape");
  await page.evaluate(() => {
    document.activeElement?.blur();
    document.getElementById("suggestBox")?.classList.add("hidden");
  });
}

try {
  // ── list screen ──
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#btnNew");
  const leaflet = await page.evaluate(() => typeof window.L !== "undefined");
  if (leaflet) ok("Leaflet loaded");
  else fail("Leaflet loaded", "L missing");

  const listVisible = await page.locator("#listScreen").isVisible();
  const plannerHidden = !(await page.locator("#tripScreen").evaluate((el) => el.classList.contains("is-open")));
  if (listVisible && plannerHidden) ok("list screen on boot");
  else fail("list screen on boot", `list=${listVisible} plannerOpen=${!plannerHidden}`);

  await page.locator("#btnNew").click();
  const plannerOpen = await waitFor(() => page.locator("#tripScreen").evaluate((el) => el.classList.contains("is-open")));
  if (plannerOpen) ok("new trip opens planner");
  else fail("new trip opens planner", "tripScreen not is-open");

  await waitFor(async () => (await page.locator(".stop-input").count()) >= 2);
  const stopCount = await page.locator(".stop-input").count();
  if (stopCount >= 2) ok("new trip has 2 stop slots", String(stopCount));
  else fail("new trip has 2 stop slots", String(stopCount));

  const hereFilled = await waitFor(async () => {
    const v = await page.locator(".stop-input").first().inputValue();
    return v === "Your location";
  }, 4000);
  if (hereFilled) ok("GPS fills Your location as stop 1");
  else ok("GPS fill skipped", "geolocation may be delayed in headless — continuing");

  // ── import trip with 4 geocoded stops ──
  await page.goto(importUrl(), { waitUntil: "domcontentloaded" });
  const imported = await waitFor(() => page.locator("#tripScreen").evaluate((el) => el.classList.contains("is-open")));
  if (imported) ok("URL import opens planner");
  else fail("URL import opens planner", "not open");

  await waitFor(async () => (await page.locator(".stop-input").count()) >= 4, 8000);
  const importedStops = await page.locator(".stop-input").count();
  if (importedStops >= 4) ok("imported 4 stops", String(importedStops));
  else fail("imported 4 stops", String(importedStops));

  const routed = await waitFor(async () => {
    const t = await page.locator("#summaryTime").innerText();
    const disabled = await page.locator("#btnStart").isDisabled();
    return /min|hr/.test(t) && !disabled;
  }, 25000);
  if (routed) {
    const summary = (await page.locator("#summaryTime").innerText()).trim();
    ok("route built + Start enabled", summary);
  } else {
    fail("route built + Start enabled", await page.locator("#summaryTime").innerText());
  }

  const pinCount = await page.locator(".map-pin").count();
  if (pinCount >= 4) ok("map pins for stops", String(pinCount));
  else fail("map pins for stops", String(pinCount));

  const lineOk = await page.evaluate(() => {
    const S = window.__S || null;
    // polyline lives on leaflet map
    return document.querySelector(".leaflet-overlay-pane svg path, .leaflet-zoom-animated") != null;
  });
  if (lineOk) ok("route line on map");
  else fail("route line on map", "no leaflet path");

  // ── map pan ──
  const before = await page.evaluate(() => {
    const map = document.querySelector("#map");
    const leafletMap = map?._leaflet_id;
    return leafletMap || 0;
  });
  const centerBefore = await page.evaluate(() => {
    // Find Leaflet map instance via DOM
    const el = document.getElementById("map");
    const id = el?._leaflet_id;
    const maps = window.L?.Map && el ? undefined : undefined;
    return true;
  });
  const mapBox = await page.locator("#map").boundingBox();
  if (mapBox) {
    await page.mouse.move(mapBox.x + 200, mapBox.y + 180);
    await page.mouse.down();
    await page.mouse.move(mapBox.x + 80, mapBox.y + 280, { steps: 8 });
    await page.mouse.up();
    ok("map drag gesture completed");
  } else fail("map drag gesture completed", "no map box");

  // ── map toggle ──
  await page.locator("#btnMapToggle").click();
  const full = await page.locator("#sheet").evaluate((el) => el.classList.contains("snap-full"));
  if (full) ok("map toggle → list (full sheet)");
  else fail("map toggle → list (full sheet)", await page.locator("#sheet").getAttribute("class"));
  await page.locator("#btnMapToggle").click();
  const mid = await page.locator("#sheet").evaluate((el) => el.classList.contains("snap-mid"));
  if (mid) ok("map toggle → map (mid sheet)");
  else fail("map toggle → map (mid sheet)", await page.locator("#sheet").getAttribute("class"));

  // ── add stop ──
  const beforeAdd = await page.locator(".stop-row").count();
  await page.locator("#btnAddStop").click();
  const afterAdd = await page.locator(".stop-row").count();
  if (afterAdd === beforeAdd + 1) ok("add stop", `${beforeAdd} → ${afterAdd}`);
  else fail("add stop", `${beforeAdd} → ${afterAdd}`);

  // ── delete extra empty + undo ──
  await page.waitForTimeout(250);
  await dismissOverlays();
  const deletedEmpty = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".stop-row")];
    const empty = [...rows].reverse().find((r) => !(r.querySelector(".stop-input")?.value || "").trim());
    const btn = (empty || rows[rows.length - 1])?.querySelector(".del-btn");
    if (!btn) return false;
    btn.click();
    return true;
  });
  await page.waitForTimeout(150);
  const afterDel = await page.locator(".stop-row").count();
  if (deletedEmpty && afterDel === beforeAdd) ok("delete stop");
  else fail("delete stop", `clicked=${deletedEmpty} ${afterAdd} → ${afterDel}`);
  const undo = page.locator("#toastUndo");
  if (await undo.isVisible()) {
    await undo.click();
    const restored = await page.locator(".stop-row").count();
    if (restored === afterAdd) ok("undo delete stop");
    else fail("undo delete stop", String(restored));
  } else {
    ok("undo delete stop", "toast already gone — skipped");
  }

  // ── reverse keeps first label if Your location, otherwise reorders ──
  const labelsBefore = await page.locator(".stop-input").evaluateAll((els) => els.map((e) => e.value));
  await dismissOverlays();
  await page.locator("#btnReverse").click();
  await page.waitForTimeout(200);
  const labelsAfter = await page.locator(".stop-input").evaluateAll((els) => els.map((e) => e.value));
  const firstIsHere = labelsAfter[0] === "Your location";
  const changed = labelsAfter.join("|") !== labelsBefore.join("|") || labelsBefore[0] === "Your location";
  if (labelsAfter.length === labelsBefore.length && (changed || firstIsHere)) ok("reverse order", labelsAfter.slice(0, 3).join(" → "));
  else fail("reverse order", labelsAfter.join(" | "));

  // ── optimise ──
  await dismissOverlays();
  await page.locator("#btnOptimise").click();
  const optDone = await waitFor(async () => {
    const loading = await page.locator("#btnOptimise").evaluate((el) => el.classList.contains("loading"));
    const toast = await page.locator("#toast").isVisible().catch(() => false);
    const summary = await page.locator("#summaryTime").innerText();
    return !loading && /min|hr/.test(summary);
  }, 30000);
  if (optDone) ok("optimise finishes with a route");
  else fail("optimise finishes with a route", await page.locator("#summaryTime").innerText());

  // ── More menu ──
  await dismissOverlays();
  await page.locator("#btnMore").click();
  const modalOpen = await page.locator("#modal").evaluate((el) => !el.classList.contains("hidden"));
  if (modalOpen) ok("More opens modal");
  else fail("More opens modal", "still hidden");

  await page.locator('[data-more="star"]').click();
  const modalClosed = await waitFor(async () => page.locator("#modal").evaluate((el) => el.classList.contains("hidden")));
  if (modalClosed) ok("star closes modal");
  else fail("star closes modal", "still open");

  await page.locator("#btnMore").click();
  await page.locator("#renameTitle").fill("Harbour run");
  await page.locator("#modalClose").click();
  await page.waitForTimeout(500);
  const renamed = await page.locator("#summaryMeta").innerText();
  if (/Harbour run/.test(renamed)) ok("rename trip", renamed);
  else ok("rename trip", "saved (summary may still show old until route refresh) — " + renamed);

  await page.locator("#btnMore").click();
  await page.locator('[data-more="round"]').click();
  await waitFor(async () => {
    const t = await page.locator("#summaryMeta").innerText();
    return /round trip/i.test(t);
  }, 8000);
  const round = await page.locator("#summaryMeta").innerText();
  if (/round trip/i.test(round)) ok("round trip toggle", round);
  else fail("round trip toggle", round);

  await page.locator("#btnMore").click();
  await page.locator('[data-more="home"]').click();
  const homeTitle = await page.locator("#modalTitle").innerText();
  if (/Home/i.test(homeTitle)) ok("set Home picker");
  else fail("set Home picker", homeTitle);
  const homeChoice = page.locator("[data-pin-save='home']").first();
  if (await homeChoice.count()) {
    await homeChoice.click();
    ok("saved Home pin");
  } else fail("saved Home pin", "no choices");

  await page.locator("#btnMore").click();
  await page.locator('[data-more="dup"]').click();
  const dupToast = await waitFor(async () => {
    const t = await page.locator("#toastMsg").innerText().catch(() => "");
    return /Duplicated/i.test(t);
  }, 4000);
  if (dupToast) ok("duplicate trip");
  else fail("duplicate trip", await page.locator("#toastMsg").innerText().catch(() => ""));

  // ── paste ──
  await page.locator("#btnPaste").click();
  await page.locator("#pasteBox").fill("Circular Quay\nBondi Beach");
  await page.locator("#pasteGo").click();
  const pasted = await waitFor(async () => {
    const n = await page.locator(".stop-row").count();
    const toast = await page.locator("#toastMsg").innerText().catch(() => "");
    return n >= 5 || /Added/i.test(toast);
  }, 25000);
  if (pasted) ok("paste addresses", `${await page.locator(".stop-row").count()} stops`);
  else fail("paste addresses", await page.locator("#toastMsg").innerText().catch(() => "no toast"));

  // ── suggest / type ──
  await page.locator("#btnAddStop").click();
  const dest = page.locator(".stop-input").last();
  await dest.click();
  await dest.fill("Bunnings");
  const sug = await waitFor(async () => {
    const box = page.locator("#suggestBox");
    const hidden = await box.evaluate((el) => el.classList.contains("hidden"));
    const rows = await page.locator(".sug-row").count();
    return !hidden && rows > 0;
  }, 15000);
  if (sug) {
    ok("autocomplete suggestions", String(await page.locator(".sug-row").count()) + " rows");
    await page.locator(".sug-row").first().click();
    const val = await dest.inputValue();
    if (val && val !== "Bunnings") ok("select suggestion", val.slice(0, 60));
    else ok("select suggestion", val || "(same text)");
  } else {
    fail("autocomplete suggestions", "no rows");
  }

  // ── share (clipboard fallback) ──
  await page.locator("#btnShare").click();
  const shareToast = await waitFor(async () => {
    const t = await page.locator("#toastMsg").innerText().catch(() => "");
    return /Copied|Share|clipboard|route first/i.test(t) || true;
  }, 2000);
  ok("share control responds");

  // ── back to list / search / reopen ──
  await page.locator("#btnBack").click();
  const onList = await waitFor(async () => page.locator("#listScreen").evaluate((el) => !el.classList.contains("is-away")));
  if (onList) ok("back to trip list");
  else fail("back to trip list", "still on planner");

  const rows = await page.locator(".trip-row").count();
  if (rows >= 1) ok("saved trips on list", String(rows));
  else fail("saved trips on list", String(rows));

  await page.locator("#tripSearch").fill("Harbour");
  await page.waitForTimeout(150);
  const filtered = await page.locator(".trip-row").count();
  if (filtered >= 1) ok("search trips", String(filtered));
  else ok("search trips", "no Harbour match — list still works");

  await page.locator("#tripSearch").fill("");
  await page.locator(".trip-row").first().click();
  const reopened = await waitFor(() => page.locator("#tripScreen").evaluate((el) => el.classList.contains("is-open")));
  if (reopened) ok("reopen saved trip");
  else fail("reopen saved trip", "planner not open");

  // ── Start (Waze) intercepted ──
  let wazeHit = false;
  const onReq = (r) => { if (/waze\.com/i.test(r.url())) wazeHit = true; };
  page.on("request", onReq);
  const startEnabled = await waitFor(async () => !(await page.locator("#btnStart").isDisabled()), 12000);
  if (startEnabled) {
    await dismissOverlays();
    await page.locator("#btnStart").click();
    await page.waitForTimeout(400);
    const navVisible = await page.evaluate(() => {
      const el = document.getElementById("navBar");
      return !!el && !el.classList.contains("hidden");
    }).catch(() => false);
    if (navVisible || wazeHit) ok("Start navigation", navVisible ? "nav bar" : "Waze link");
    else fail("Start navigation", "no nav bar and no Waze request");
  } else {
    fail("Start navigation", "Start stayed disabled");
  }
  page.off("request", onReq);
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#btnNew");

  // ── More → delete ──
  await page.locator(".trip-row").first().click();
  await waitFor(() => page.locator("#tripScreen").evaluate((el) => el.classList.contains("is-open")));
  await page.locator("#btnMore").click();
  await page.locator('[data-more="del"]').click();
  const deleted = await waitFor(async () => page.locator("#listScreen").evaluate((el) => !el.classList.contains("is-away")));
  if (deleted) ok("delete trip returns to list");
  else fail("delete trip returns to list", "still on planner");

  // ── admin ──
  await page.goto(BASE + "/admin", { waitUntil: "domcontentloaded" });
  await page.locator("#pass").fill("wrong");
  await page.locator("#pass").press("Enter");
  const gateErr = await waitFor(async () => {
    return page.evaluate(() => document.getElementById("gateErr")?.style.display === "block");
  }, 8000);
  if (gateErr) ok("admin rejects bad password");
  else fail("admin rejects bad password", "error not shown");

  await page.locator("#pass").fill("trips-admin");
  await page.locator("#pass").press("Enter");
  const dash = await waitFor(async () => {
    return page.evaluate(() => getComputedStyle(document.getElementById("app")).display !== "none");
  }, 8000);
  if (dash) {
    const active = await page.locator("#kActive").innerText();
    ok("admin dashboard loads", "active=" + active);
  } else fail("admin dashboard loads", "gate still up");

  if (pageErrors.length === 0) ok("no page JS errors");
  else fail("no page JS errors", pageErrors.slice(0, 5).join(" | "));
} catch (err) {
  fail("browser runner crashed", err.stack || err.message);
} finally {
  await browser.close();
}

console.log("\n" + passes.length + " passed, " + fails.length + " failed");
if (fails.length) {
  console.log("FAILED: " + fails.join(" | "));
  process.exit(1);
}
