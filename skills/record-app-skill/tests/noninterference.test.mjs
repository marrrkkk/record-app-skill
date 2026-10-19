/**
 * The caption and cursor overlays are drawn *into the page being recorded*, so
 * they are the one part of this skill that could change the app under test.
 * These tests prove the overlays are inert:
 *
 *   - layout is byte-identical with and without them,
 *   - hit testing still reaches the app, at the exact point the pointer covers,
 *   - real clicks and typing work while overlays are live,
 *   - the app's own DOM and source are not modified,
 *   - the recorded file really contains frames (a screenshot of a page that
 *     never paints would be an empty demo).
 *
 * They also exercise the production overlay functions, not a copy, so a
 * regression in the skill is caught here rather than during a demo.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  captionOverlayHtml,
  escapeHtml,
  launchOptionsFor,
  loadCursorStyle,
  resolveLaunchChannel,
} from "../scripts/capture.mjs";
import { probeMedia } from "../scripts/media-probe.mjs";
import { loadPlaywright, startFixture, screencastAvailable, tmpDir } from "./helpers.mjs";

const pw = await loadPlaywright();

/** Elements whose geometry must not move when overlays are shown. */
const PROBED_SELECTORS = [
  "h1",
  "[data-testid='open-create']",
  "[data-testid='task-list']",
  "[data-testid='empty-state']",
  "nav[aria-label='Main'] a",
];

async function geometry(page, selectors) {
  return page.evaluate((list) => {
    const out = {};
    for (const selector of list) {
      const el = document.querySelector(selector);
      if (!el) {
        out[selector] = null;
        continue;
      }
      const r = el.getBoundingClientRect();
      out[selector] = { x: r.x, y: r.y, width: r.width, height: r.height };
    }
    return out;
  }, selectors);
}

async function withRecording(t, fn) {
  if (!pw) return t.skip("Playwright is not installed for this skill (run: node scripts/setup-check.mjs)");
  if (!(await screencastAvailable())) {
    return t.skip("Playwright's bundled ffmpeg is missing, so page.screencast cannot record");
  }
  let browser;
  let fixture;
  try {
    browser = await pw.playwright.chromium.launch({ headless: true });
  } catch (err) {
    return t.skip(`no browser available: ${err.message.split("\n")[0]}`);
  }
  try {
    fixture = await startFixture();
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const dir = tmpDir("overlay");
    await fn({ page, fixture, context, dir });
  } finally {
    await browser.close().catch(() => {});
    await fixture?.stop();
  }
}

test("caption markup is inert and cannot inject HTML", () => {
  const html = captionOverlayHtml('<img src=x onerror="alert(1)"> & "quoted"');
  assert.match(html, /pointer-events:none/, "the overlay must never intercept pointer events");
  assert.match(html, /position:fixed/, "the overlay must be taken out of flow");
  assert.doesNotMatch(html, /<img/, "markup from the plan must be escaped, never injected");
  assert.match(html, /&lt;img/);
  assert.equal(escapeHtml("<b>&</b>"), "&lt;b&gt;&amp;&lt;/b&gt;");

  // The cursor preset must also be inert, and must not show Playwright's own
  // annotation title (which leaks raw selector text into the video). Click
  // points and target highlights are intentionally absent: the recording
  // should look like a person using the app.
  const cursor = loadCursorStyle();
  assert.equal(cursor.title, "display: none");
  assert.equal(cursor.point, undefined, "no click point decoration");
  assert.equal(cursor.highlight, undefined, "no target highlight decoration");
});

test("overlays do not change layout, hit testing, or the app's own DOM", async (t) => {
  await withRecording(t, async ({ page, fixture, dir }) => {
    await page.goto(new URL("/tasks", fixture.baseUrl).toString());
    await page.getByTestId("open-create").waitFor();

    const before = await geometry(page, PROBED_SELECTORS);
    const bodyBefore = await page.evaluate(() => document.body.innerHTML);
    const scrollBefore = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));

    // Mirror the production call path exactly: `capture` is the screencast
    // namespace, and start() opens the recording.
    const capture = page.screencast;
    await capture.start({
      path: path.join(dir, "overlay.webm"),
      size: { width: 1280, height: 720 },
      fps: 60,
    });

    const cursorStyle = loadCursorStyle();
    const actions = await capture.showActions({
      cursor: "pointer",
      duration: 700,
      style: { title: cursorStyle.title },
    });

    // Two overlays at once, and a chapter card, to make the test as hostile as
    // the real recording path.
    await capture.showOverlay(captionOverlayHtml("A caption that must not block the UI"), { duration: 1200 });
    await capture.showOverlay(captionOverlayHtml("A second caption at the top", { position: "top" }), { duration: 1200 });
    await capture.showChapter("Checkpoint", { description: "overlay non-interference", duration: 4000 });

    try {
      const after = await geometry(page, PROBED_SELECTORS);
      for (const selector of PROBED_SELECTORS) {
        assert.deepEqual(after[selector], before[selector], `geometry of ${selector} changed while overlays were visible`);
      }

      const bodyAfter = await page.evaluate(() => document.body.innerHTML);
      assert.equal(bodyAfter, bodyBefore, "the overlays must not write anything into the application's DOM");
      assert.deepEqual(await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY })), scrollBefore);

      // Overlays live outside <body>, in their own host element, and every
      // overlay host must be pointer-transparent.
      const overlayHosts = await page.evaluate(() =>
        [...document.documentElement.children]
          .filter((el) => !["HEAD", "BODY"].includes(el.tagName))
          .map((el) => ({
            tag: el.tagName,
            pointerEvents: getComputedStyle(el).pointerEvents,
            position: getComputedStyle(el).position,
          }))
      );
      assert.ok(
        overlayHosts.length >= 1,
        `expected an overlay host outside <body>, found ${JSON.stringify(overlayHosts)}`
      );
      for (const host of overlayHosts) {
        assert.equal(
          host.pointerEvents,
          "none",
          `overlay host <${host.tag}> must be pointer-transparent, got ${host.pointerEvents}`
        );
        assert.equal(host.position, "fixed", `overlay host <${host.tag}> must be fixed, got ${host.position}`);
      }

      // Hit testing: the centre of the real button must still be the button.
      const buttonBox = await page.getByTestId("open-create").boundingBox();
      const hit = await page.evaluate(
        ([x, y]) => {
          const el = document.elementFromPoint(x, y);
          return el ? { tag: el.tagName, testId: el.getAttribute("data-testid") } : null;
        },
        [buttonBox.x + buttonBox.width / 2, buttonBox.y + buttonBox.height / 2]
      );
      assert.equal(hit?.testId, "open-create", `elementFromPoint returned ${JSON.stringify(hit)} instead of the app button`);

      // Real interaction through the overlays.
      await page.getByTestId("open-create").click();
      await page.getByTestId("create-form").waitFor({ state: "visible" });
      await page.getByLabel("Task name").fill("Overlay proof");
      assert.equal(await page.getByLabel("Task name").inputValue(), "Overlay proof");
      await page.getByTestId("submit-create").click();
      await page.getByTestId("flash").waitFor({ state: "visible" });

      const state = await fixture.state();
      assert.ok(
        state.tasks.some((task) => task.title === "Overlay proof"),
        "the click and typing must reach the application while overlays are live"
      );
    } finally {
      await actions?.dispose?.().catch?.(() => {});
      await capture.stop();
    }

    // The recording must contain real frames, not an empty container.
    const raw = path.join(dir, "overlay.webm");
    assert.ok(fs.existsSync(raw), "the screencast should have written a file");
    const probed = probeMedia(raw);
    assert.ok(probed, "the recording must be a readable media file");
    assert.equal(probed.width, 1280);
    assert.equal(probed.height, 720);
    assert.ok(probed.durationSeconds > 0.4, `recording only lasted ${probed.durationSeconds}s`);
    assert.ok(probed.nbFrames > 10, `recording only had ${probed.nbFrames} frames`);
    assert.ok(fs.statSync(raw).size > 10_000, "a real recording is not a few bytes");
  });
});

test("the cursor overlay covers the interaction point without swallowing it", async (t) => {
  await withRecording(t, async ({ page, fixture, dir }) => {
    await page.goto(new URL("/tasks", fixture.baseUrl).toString());
    await page.getByTestId("open-create").waitFor();
    const capture = page.screencast;
    await capture.start({
      path: path.join(dir, "cursor.webm"),
      size: { width: 1280, height: 720 },
      fps: 60,
    });
    const cursorStyle = loadCursorStyle();
    const actions = await capture.showActions({
      cursor: "pointer",
      duration: 1000,
      style: { title: cursorStyle.title },
    });
    try {
      const box = await page.getByTestId("open-create").boundingBox();
      const centre = [box.x + box.width / 2, box.y + box.height / 2];

      // Move the real pointer there so the overlay draws its cursor, then check
      // that the topmost element at that point is still the app's button.
      await page.mouse.move(centre[0], centre[1]);
      await page.waitForTimeout(120);
      const hit = await page.evaluate(([x, y]) => {
        const el = document.elementFromPoint(x, y);
        return el ? el.getAttribute("data-testid") ?? el.tagName : null;
      }, centre);
      assert.equal(hit, "open-create", "the drawn cursor must not become the hit target");

      await page.mouse.click(centre[0], centre[1]);
      await page.getByTestId("create-form").waitFor({ state: "visible", timeout: 5000 });
    } finally {
      await actions?.dispose?.().catch?.(() => {});
      await capture.stop();
    }
  });
});

test("launch options never leak a forced channel into the plan's own record", () => {
  const plan = { browser: { channel: "chromium", headless: true } };
  assert.deepEqual(launchOptionsFor(plan), { headless: true }, "chromium is the bundled browser, so no channel is passed");
  assert.equal(resolveLaunchChannel(plan), "chromium");

  const previous = process.env.RECORD_APP_SKILL_FORCE_CHANNEL;
  process.env.RECORD_APP_SKILL_FORCE_CHANNEL = "chrome";
  try {
    assert.deepEqual(launchOptionsFor(plan), { headless: true, channel: "chrome" });
    assert.equal(resolveLaunchChannel(plan), "chrome", "the reported channel must be the one actually launched");
  } finally {
    if (previous === undefined) delete process.env.RECORD_APP_SKILL_FORCE_CHANNEL;
    else process.env.RECORD_APP_SKILL_FORCE_CHANNEL = previous;
  }
});
