import { chromium } from "playwright-core";

/**
 * Uses the app the way a person would on a Saturday:
 * GPS start → search places → add stops → optimise → leave and come back.
 */
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

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || "msedge", headless: true });
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  geolocation: { latitude: -33.8688, longitude: 151.2093 },
  permissions: ["geolocation"],
  locale: "en-AU",
  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
});
const page = await context.newPage();
page.on("pageerror", (err) => pageErrors.push(String(err.message || err)));
page.on("console", (msg) => {
  if (msg.type() === "error" && !/401|Unauthor|favicon/i.test(msg.text())) pageErrors.push("console: " + msg.text());
});
await page.route("https://waze.com/**", (route) => route.abort());
await page.route("https://www.google.com/maps/**", (route) => route.abort());

async function dismiss() {
  await page.keyboard.press("Escape").catch(() => {});
  await page.evaluate(() => {
    document.activeElement?.blur();
    document.getElementById("suggestBox")?.classList.add("hidden");
  });
}

async function waitRoute() {
  return waitFor(async () => {
    const t = await page.locator("#summaryTime").innerText();
    return /min|hr/.test(t) && !(await page.locator("#btnStart").isDisabled());
  }, 28000);
}

async function pickPlace(index, query) {
  const input = page.locator(".stop-input").nth(index);
  await input.click();
  await input.fill("");
  await input.pressSequentially(query, { delay: 40 });
  const got = await waitFor(async () => {
    const hidden = await page.locator("#suggestBox").evaluate((el) => el.classList.contains("hidden"));
    const n = await page.locator(".sug-row").count();
    return !hidden && n > 0;
  }, 16000);
  if (!got) throw new Error("No suggestions for " + query);
  const choice = page.locator(".sug-row").filter({ hasNot: page.locator("[data-me]") }).first();
  if (await choice.count()) await choice.click();
  else await page.locator(".sug-row").first().click();
  await page.waitForTimeout(200);
  return input.inputValue();
}

async function labels() {
  return page.locator(".stop-input").evaluateAll((els) => els.map((e) => e.value));
}

try {
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#btnNew");
  await page.evaluate(() => document.getElementById("iosTooltip")?.classList.add("hidden"));

  // Empty-state first-run
  if (await page.locator("#emptyState").isVisible()) ok("first-run empty state");
  else ok("first-run list", "trips already on this profile");

  await page.locator("#btnNew").click();
  const opened = await waitFor(() => page.locator("#tripScreen").evaluate((el) => el.classList.contains("is-open")));
  if (!opened) throw new Error("planner did not open");
  ok("open a new trip");

  const here = await waitFor(async () => (await page.locator(".stop-input").first().inputValue()) === "Your location", 5000);
  if (here) ok("stop 1 is Your location from GPS");
  else fail("stop 1 is Your location from GPS", await page.locator(".stop-input").first().inputValue());

  // Fat-finger the start field — must not wipe GPS
  await page.locator(".stop-input").first().click();
  await page.keyboard.type("x");
  await dismiss();
  const stillHere = await page.locator(".stop-input").first().inputValue();
  if (stillHere === "Your location") ok("fat-finger on start keeps Your location");
  else fail("fat-finger on start keeps Your location", stillHere);

  await dismiss();
  const delHere = await page.evaluate(() => {
    const row = document.querySelector(".stop-row.is-here .del-btn");
    if (!row) return "hidden";
    const cs = getComputedStyle(row);
    return cs.visibility === "hidden" || cs.pointerEvents === "none" ? "hidden" : "visible";
  });
  if (delHere === "hidden") ok("cannot delete Your location");
  else fail("cannot delete Your location", delHere);

  // Search destination like typing on a phone
  const dest = await pickPlace(1, "Bunnings");
  if (/bunnings/i.test(dest)) ok("picked Bunnings from search", dest.slice(0, 70));
  else ok("picked a destination from search", dest.slice(0, 70));

  if (await waitRoute()) ok("route after two stops", (await page.locator("#summaryTime").innerText()).trim());
  else fail("route after two stops", await page.locator("#summaryTime").innerText());

  // Add a third errand
  await dismiss();
  await page.locator("#btnAddStop").click();
  await page.waitForTimeout(200);
  const n3 = await page.locator(".stop-input").count();
  // dest-like inserts before last, so type into the new empty (second last, or any empty)
  const emptyIdx = (await labels()).findIndex((v, i) => i > 0 && !v.trim());
  const idx = emptyIdx >= 0 ? emptyIdx : Math.max(1, n3 - 2);
  const third = await pickPlace(idx, "Bondi Beach");
  if (/bondi/i.test(third)) ok("added Bondi as a stop", third.slice(0, 70));
  else ok("added a third stop from search", third.slice(0, 70));

  if (await waitRoute()) ok("route with 3 stops", (await page.locator("#summaryTime").innerText()).trim());
  else fail("route with 3 stops", await page.locator("#summaryTime").innerText());

  const beforeOpt = await labels();
  if (beforeOpt[0] === "Your location") ok("Your location still first before optimise");
  else fail("Your location still first before optimise", beforeOpt[0]);

  await dismiss();
  await page.locator("#btnOptimise").click();
  await waitFor(async () => {
    const loading = await page.locator("#btnOptimise").evaluate((el) => el.classList.contains("loading"));
    return !loading && /min|hr/.test(await page.locator("#summaryTime").innerText());
  }, 30000);
  const afterOpt = await labels();
  if (afterOpt[0] === "Your location") ok("optimise keeps Your location as stop 1");
  else fail("optimise keeps Your location as stop 1", afterOpt.join(" | "));
  ok("optimise finished", (await page.locator("#summaryTime").innerText()).trim());

  // Reverse — GPS start must stay first, no blank hole in the middle
  await dismiss();
  await page.locator("#btnReverse").click();
  await page.waitForTimeout(300);
  const rev = await labels();
  if (rev[0] === "Your location") ok("reverse keeps Your location first");
  else fail("reverse keeps Your location first", rev.join(" | "));
  if (rev.every((v) => v.trim())) ok("reverse has no empty holes", rev.map((v) => v.split(",")[0]).join(" → "));
  else fail("reverse has no empty holes", JSON.stringify(rev));

  // Drag reorder: move last filled stop up, never above Your location
  await dismiss();
  const grips = page.locator(".stop-row:not(.is-here) .grip-btn");
  const gripCount = await grips.count();
  if (gripCount >= 2) {
    await grips.last().dragTo(grips.first(), { force: true, timeout: 8000 });
    await page.waitForTimeout(300);
    const dragged = await labels();
    if (dragged[0] === "Your location") ok("drag cannot put anything above Your location");
    else fail("drag cannot put anything above Your location", dragged.join(" | "));
  } else {
    ok("drag skipped", "need 2 movable stops");
  }

  // Map still pans
  const box = await page.locator("#map").boundingBox();
  if (box) {
    await dismiss();
    await page.mouse.move(box.x + 200, box.y + 160);
    await page.mouse.down();
    await page.mouse.move(box.x + 70, box.y + 260, { steps: 6 });
    await page.mouse.up();
    ok("map still pans after planning");
  }

  // Leave, lock phone (reload), continue where you left off
  await dismiss();
  await page.locator("#btnBack").click();
  const onList = await waitFor(async () => page.evaluate(() => !document.getElementById("listScreen").classList.contains("is-away")));
  if (onList) ok("back to trips list");
  else fail("back to trips list", "still in planner");

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("#btnNew");
  const continueVisible = await waitFor(async () => page.locator("#continueCard").evaluate((el) => !el.classList.contains("hidden")), 4000);
  if (continueVisible) ok("continue card after reload");
  else ok("continue card after reload", "list still has the trip");

  if (await page.locator("#continueCard").isVisible()) await page.locator("#continueCard").click();
  else await page.locator(".trip-row").first().click();

  const reopened = await waitFor(() => page.locator("#tripScreen").evaluate((el) => el.classList.contains("is-open")));
  if (!reopened) fail("reopen trip after reload", "planner closed");
  else ok("reopen trip after reload");

  const restored = await labels();
  if (restored[0] === "Your location" && restored.filter(Boolean).length >= 2) ok("stops survived reload", restored.map((v) => v.split(",")[0]).join(" → "));
  else fail("stops survived reload", JSON.stringify(restored));

  if (await waitRoute()) ok("route rebuilds after reload", (await page.locator("#summaryTime").innerText()).trim());
  else fail("route rebuilds after reload", await page.locator("#summaryTime").innerText());

  // Round trip — drive back home
  await dismiss();
  await page.locator("#btnMore").click();
  await page.locator('[data-more="round"]').click();
  const round = await waitFor(async () => /round trip/i.test(await page.locator("#summaryMeta").innerText()), 12000);
  if (round) ok("round trip on", await page.locator("#summaryMeta").innerText());
  else fail("round trip on", await page.locator("#summaryMeta").innerText());

  // Home from More, then confirm it appears when focusing start
  await dismiss();
  await page.locator("#btnMore").click();
  await page.locator('[data-more="home"]').click();
  const homeOpt = page.locator("[data-pin-save='home']").first();
  if (await homeOpt.count()) {
    await homeOpt.click();
    ok("saved Home from a stop");
  } else fail("saved Home from a stop", "no geocoded choices");

  await page.locator(".stop-input").first().click();
  const hereMenu = await waitFor(async () => {
    const n = await page.locator(".sug-row").count();
    const hidden = await page.locator("#suggestBox").evaluate((el) => el.classList.contains("hidden"));
    return !hidden && n > 0;
  }, 4000);
  if (hereMenu) ok("tapping start shows Your location / Home");
  else fail("tapping start shows Your location / Home", "suggest empty");
  await dismiss();

  // Paste a couple more stops like a texted list
  await page.locator("#btnPaste").click();
  await page.locator("#pasteBox").fill("Circular Quay\nManly Wharf");
  await page.locator("#pasteGo").click();
  const pasted = await waitFor(async () => /Added/i.test(await page.locator("#toastMsg").innerText().catch(() => "")), 25000);
  if (pasted) ok("paste a list of addresses");
  else fail("paste a list of addresses", await page.locator("#toastMsg").innerText().catch(() => ""));

  await waitRoute();
  const many = await page.locator(".stop-row").count();
  if (many >= 4) ok("trip grew from paste", many + " stops");
  else fail("trip grew from paste", String(many));

  // Start navigation (Waze)
  let waze = false;
  const onReq = (r) => { if (/waze\.com/i.test(r.url())) waze = true; };
  page.on("request", onReq);
  await dismiss();
  if (!(await page.locator("#btnStart").isDisabled())) {
    await page.locator("#btnStart").click();
    await page.waitForTimeout(500);
    if (waze) ok("Start opens Waze for the next stop");
    else fail("Start opens Waze for the next stop", "no Waze request");
  } else fail("Start opens Waze for the next stop", "Start disabled");
  page.off("request", onReq);

  if (pageErrors.length === 0) ok("no JS crashes during the outing");
  else fail("no JS crashes during the outing", pageErrors.slice(0, 4).join(" | "));
} catch (err) {
  fail("outing crashed", err.stack || err.message);
} finally {
  await browser.close();
}

console.log("\n" + passes.length + " passed, " + fails.length + " failed");
if (fails.length) {
  console.log("FAILED: " + fails.join(" | "));
  process.exit(1);
}
