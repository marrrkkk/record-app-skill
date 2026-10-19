/**
 * Browser-level tests for step execution and assertions.
 *
 * The point of these tests is that a claim of success must be earned: an
 * assertion that cannot run is a failure, an ambiguous selector is an error
 * rather than a coin flip, and a step that did not take effect cannot pass.
 */

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { buildLocator, evaluateExpect, executeStep, matchUrl } from "../scripts/runner.mjs";
import { loadPlaywright, startFixture, SKILL_DIR } from "./helpers.mjs";

const pw = await loadPlaywright();

/** Launch a browser page against the fixture; skip the file when unavailable. */
async function withPage(t, fn) {
  if (!pw) return t.skip("Playwright is not installed for this skill (run: node scripts/setup-check.mjs)");
  let browser;
  let fixture;
  try {
    browser = await pw.playwright.chromium.launch({ headless: true });
  } catch (err) {
    return t.skip(`no browser available: ${err.message.split("\n")[0]}`);
  }
  try {
    fixture = await startFixture();
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    await fn({ page, fixture, context });
  } finally {
    await browser.close().catch(() => {});
    await fixture?.stop();
  }
}

const ctxFor = (fixture) => ({
  baseUrl: fixture.baseUrl,
  defaultTimeoutMs: 5000,
  showCaption: async () => {},
  showChapter: async () => {},
});

/* ------------------------------------------------------------------ */
/* Locator construction                                                */
/* ------------------------------------------------------------------ */

test("buildLocator reports which strategy it used, for the timeline", async (t) => {
  await withPage(t, async ({ page, fixture }) => {
    await page.goto(new URL("/tasks", fixture.baseUrl).toString());

    const byRole = buildLocator(page, { role: "button", name: "Add task" });
    assert.equal(byRole.strategy, "role");
    assert.equal(byRole.description, 'role="button" name="Add task"');
    assert.equal(await byRole.locator.count(), 1);

    const byLabel = buildLocator(page, { label: "Task name" });
    assert.equal(byLabel.strategy, "label");
    assert.equal(await byLabel.locator.count(), 1);

    const byPlaceholder = buildLocator(page, { placeholder: "e.g. Write the recording skill" });
    assert.equal(byPlaceholder.strategy, "placeholder");

    const byTestId = buildLocator(page, { testId: "open-create" });
    assert.equal(byTestId.strategy, "testId");
    assert.equal(await byTestId.locator.count(), 1);

    const byCss = buildLocator(page, { css: "h1" });
    assert.equal(byCss.strategy, "css");

    assert.throws(() => buildLocator(page, {}), /no usable selector/);
  });
});

test("a preferred strategy wins over a lower-ranked one on the same target", async (t) => {
  await withPage(t, async ({ page, fixture }) => {
    await page.goto(new URL("/tasks", fixture.baseUrl).toString());
    // Both selectors are present; the accessible one must be chosen, because
    // that is the documented preference order.
    const info = buildLocator(page, { css: "#this-id-does-not-exist", role: "button", name: "Add task" });
    assert.equal(info.strategy, "role");
    assert.equal(await info.locator.count(), 1);
  });
});

test("an ambiguous selector is an error, never a silent first match", async (t) => {
  await withPage(t, async ({ page, fixture }) => {
    await fixture.reset();
    await page.goto(new URL("/tasks", fixture.baseUrl).toString());
    // Create two tasks whose titles share a prefix, so a text selector for that
    // prefix matches more than one element.
    for (const title of ["Ambiguous one", "Ambiguous two"]) {
      await page.getByTestId("open-create").click();
      await page.getByLabel("Task name").fill(title);
      await page.getByTestId("submit-create").click();
      await page.getByTestId("flash").waitFor({ state: "visible", timeout: 5000 });
    }
    const matches = await page.getByText("Ambiguous").count();
    assert.ok(matches >= 2, `expected several matches, found ${matches}`);

    const ctx = ctxFor(fixture);
    const step = { id: "ambiguous", action: "click", target: { text: "Ambiguous" } };
    const outcome = await executeStep(page, step, ctx);
    assert.equal(outcome.status, "failed", "a strict-mode violation must fail the step");
    assert.match(outcome.error?.message ?? "", /strict mode|resolved to \d+ elements/i);
  });
});

/* ------------------------------------------------------------------ */
/* Assertions                                                          */
/* ------------------------------------------------------------------ */

test("every supported assertion kind reports pass and fail honestly", async (t) => {
  await withPage(t, async ({ page, fixture }) => {
    await fixture.reset();
    await page.goto(new URL("/tasks", fixture.baseUrl).toString());

    const run = async (expect, target = { css: "h1" }) => {
      const step = { target, expect };
      const info = buildLocator(page, target);
      return evaluateExpect(page, step, info, 5000);
    };

    assert.equal((await run({ visible: true })).passed, true);
    assert.equal((await run({ hidden: false })).passed, true);
    assert.equal((await run({ text: "Task" })).passed, true);
    assert.equal((await run({ notText: "zzz" })).passed, true);
    assert.equal((await run({ state: "visible" })).passed, true);
    assert.equal((await run({ url: "/tasks" })).passed, true);
    assert.equal((await run({ url: "/nope" })).passed, false);
    assert.equal((await run({ count: 1 })).passed, true);

    // Failures must report why, not just that.
    const failed = await run({ text: "definitely not present" });
    assert.equal(failed.passed, false);
    assert.match(failed.detail, /does not contain/);
  });
});

test("an assertion on a missing element fails instead of quietly passing", async (t) => {
  await withPage(t, async ({ page, fixture }) => {
    await page.goto(new URL("/tasks", fixture.baseUrl).toString());
    const step = { target: { css: "#never-rendered" }, expect: { visible: true } };
    const info = buildLocator(page, step.target);
    const result = await evaluateExpect(page, step, info, 1500);
    assert.equal(result.passed, false, "asserting visibility of an absent element must fail");

    const hidden = await evaluateExpect(
      page,
      { target: { css: "#never-rendered" }, expect: { hidden: true } },
      info,
      1500
    );
    assert.equal(hidden.passed, true, "an absent element is legitimately hidden");
  });
});

test("input value assertions read the real field", async (t) => {
  await withPage(t, async ({ page, fixture }) => {
    await fixture.reset();
    await page.goto(new URL("/tasks", fixture.baseUrl).toString());
    await page.getByTestId("open-create").click();
    await page.getByLabel("Task name").fill("Real value");

    const target = { label: "Task name" };
    const info = buildLocator(page, target);
    assert.equal((await evaluateExpect(page, { target, expect: { value: "Real value" } }, info, 5000)).passed, true);
    assert.equal((await evaluateExpect(page, { target, expect: { value: "Wrong" } }, info, 5000)).passed, false);
  });
});

test("url matching supports substrings and globs without inventing matches", () => {
  assert.equal(matchUrl("http://x.test/tasks?page=2", "/tasks").ok, true);
  assert.equal(matchUrl("http://x.test/tasks/7", "*/tasks/*").ok, true);
  assert.equal(matchUrl("http://x.test/tasks/7", "/projects").ok, false);
  assert.equal(matchUrl("http://x.test/tasks", 42).ok, false);
  // A glob must not be treated as a substring search.
  assert.equal(matchUrl("http://x.test/tasks/7/extra", "*/tasks/7").ok, false);
});

/* ------------------------------------------------------------------ */
/* Step execution                                                      */
/* ------------------------------------------------------------------ */

test("goto, fill, click and waitFor really change the page state", async (t) => {
  await withPage(t, async ({ page, fixture }) => {
    await fixture.reset();
    const ctx = ctxFor(fixture);

    const steps = [
      { id: "open", action: "goto", path: "/tasks" },
      { id: "dialog", action: "click", target: { testId: "open-create" }, assertOn: { testId: "create-form" }, expect: { visible: true } },
      { id: "title", action: "fill", target: { label: "Task name" }, value: "Ship the demo" },
      { id: "pick", action: "select", target: { label: "Priority" }, value: "high" },
      { id: "save", action: "click", target: { role: "button", name: "Create task" } },
      {
        id: "flash",
        action: "waitFor",
        target: { testId: "flash" },
        expect: { visible: true, text: "Ship the demo" },
      },
      {
        id: "list",
        action: "assert",
        target: { text: "Ship the demo", exact: true },
        expect: { count: 1 },
      },
    ];
    for (const step of steps) {
      const outcome = await executeStep(page, step, ctx);
      assert.equal(outcome.status, "ok", `${step.id}: ${outcome.error ?? ""}`);
    }

    const state = await fixture.state();
    const created = state.tasks.find((task) => task.title === "Ship the demo");
    assert.ok(created, "the workflow must have actually created the task server-side");
    assert.equal(created.priority, "high", "the selected priority must have been submitted");
  });
});

test("a step whose assertion does not hold fails, and says which check failed", async (t) => {
  await withPage(t, async ({ page, fixture }) => {
    await fixture.reset();
    await page.goto(new URL("/tasks", fixture.baseUrl).toString());
    const ctx = ctxFor(fixture);
    const step = {
      id: "wrong",
      action: "click",
      target: { testId: "open-create" },
      assertOn: { role: "heading", name: "Tasks" },
      expect: { text: "Something that is not a heading" },
    };
    const outcome = await executeStep(page, step, ctx);
    assert.equal(outcome.status, "failed");
    assert.ok(outcome.assertion, "a failed assertion must be reported as an assertion failure");
    assert.equal(outcome.assertion.passed, false);
    assert.match(outcome.assertion.detail, /does not contain/);
  });
});

test("a failed action is reported with the error, not swallowed", async (t) => {
  await withPage(t, async ({ page, fixture }) => {
    await page.goto(new URL("/tasks", fixture.baseUrl).toString());
    const ctx = { ...ctxFor(fixture), defaultTimeoutMs: 1500 };
    const outcome = await executeStep(
      page,
      { id: "missing", action: "click", target: { role: "button", name: "Not a real button" } },
      ctx
    );
    assert.equal(outcome.status, "failed");
    assert.ok(outcome.error, "the failure must carry a message");
    assert.match(outcome.error.message, /Not a real button|Timeout|locator/i);
    assert.equal(outcome.error.locator, 'role="button" name="Not a real button"', "the failing selector is named");
  });
});

test("scroll steps reach the real document extremes", async (t) => {
  await withPage(t, async ({ page, fixture }) => {
    await page.goto(new URL("/tasks", fixture.baseUrl).toString());
    const ctx = ctxFor(fixture);
    // Give the page something to scroll.
    await page.setViewportSize({ width: 400, height: 300 });
    await page.evaluate(() => {
      const filler = document.createElement("div");
      filler.style.height = "3000px";
      filler.id = "filler";
      document.body.appendChild(filler);
    });

    await executeStep(page, { id: "down", action: "scroll", to: "bottom" }, ctx);
    const atBottom = await page.evaluate(() => window.scrollY > 1000);
    assert.equal(atBottom, true, "scrolling to the bottom must move the document");

    await executeStep(page, { id: "up", action: "scroll", to: "top" }, ctx);
    assert.equal(await page.evaluate(() => window.scrollY), 0);
  });
});

test("the fixture's own validation and failure routes behave as the plan assumes", async (t) => {
  // The fixture is the yardstick for every eval, so its failure modes are
  // asserted directly rather than assumed.
  await withPage(t, async ({ page, fixture }) => {
    await fixture.reset();
    await page.goto(new URL("/tasks", fixture.baseUrl).toString());
    await page.getByTestId("open-create").click();
    await page.getByLabel("Task name").fill("ab");
    await page.getByRole("button", { name: "Create task" }).click();
    await page.getByTestId("title-error").waitFor({ state: "visible", timeout: 5000 });
    assert.match(await page.getByTestId("title-error").textContent(), /at least 3/i);

    const broken = await page.goto(new URL("/broken", fixture.baseUrl).toString());
    assert.equal(broken.status(), 500, "the deliberate failure route must really fail");

    const protectedRes = await page.request.get(new URL("/private", fixture.baseUrl).toString());
    assert.equal(protectedRes.status(), 401, "the protected route must really require auth");
  });
});
