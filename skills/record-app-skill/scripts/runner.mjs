/**
 * Workflow step execution engine.
 *
 * This is the single implementation of "what a step means". The local recorder
 * and the Windows-side worker both go through it, so behaviour cannot drift
 * between backends.
 *
 * Design notes:
 *  - Plans are data. The only JavaScript executed is the fixed, internal set of
 *    expressions in this file; nothing from the plan is ever evaluated.
 *  - Locators are resolved by the documented preference order
 *    (role > label > placeholder > testId > text > css). Ambiguous locators are
 *    left ambiguous so Playwright's strict mode reports them, rather than being
 *    silently narrowed with `.first()`.
 */

import { selectorStrategy, describeSelector } from "./lib.mjs";

/** Build a Playwright locator plus the provenance needed for the timeline. */
export function buildLocator(page, target) {
  const strategy = selectorStrategy(target);
  if (!strategy) throw new Error("target has no usable selector");
  let locator;
  switch (strategy) {
    case "role": {
      const opts = {};
      if (target.name !== undefined) opts.name = target.name;
      if (target.exact !== undefined) opts.exact = target.exact;
      if (target.checked !== undefined) opts.checked = target.checked;
      locator = page.getByRole(target.role, opts);
      break;
    }
    case "label":
      locator = page.getByLabel(target.label, target.exact !== undefined ? { exact: target.exact } : undefined);
      break;
    case "placeholder":
      locator = page.getByPlaceholder(target.placeholder, target.exact !== undefined ? { exact: target.exact } : undefined);
      break;
    case "testId":
      locator = page.getByTestId(target.testId);
      break;
    case "text":
      locator = page.getByText(target.text, target.exact !== undefined ? { exact: target.exact } : undefined);
      break;
    case "css":
      locator = page.locator(target.css);
      break;
    default:
      throw new Error(`unsupported selector strategy "${strategy}"`);
  }
  if (Number.isInteger(target.nth)) locator = locator.nth(target.nth);
  return { locator, strategy, description: describeSelector(target) };
}

/* ------------------------------------------------------------------ */
/* Assertions                                                          */
/* ------------------------------------------------------------------ */

/** Match a URL by exact string, substring, or `*` glob. */
export function matchUrl(actual, expected) {
  if (typeof expected !== "string") return { ok: false, detail: "expect.url must be a string" };
  if (expected.includes("*")) {
    const re = new RegExp("^" + expected.split("*").map(escapeRegExp).join(".*") + "$");
    const ok = re.test(actual);
    return { ok, detail: ok ? `url matches ${expected}` : `url ${actual} does not match ${expected}` };
  }
  const ok = actual.includes(expected);
  return { ok, detail: ok ? `url contains ${JSON.stringify(expected)}` : `url ${actual} does not contain ${JSON.stringify(expected)}` };
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function truncate(s, n = 160) {
  const str = String(s);
  return str.length > n ? `${str.slice(0, n)}…` : str;
}

/**
 * Evaluate a step's `expect` object.
 * Returns { passed, checks: [{kind, passed, detail}], fatalErrors }.
 * A check that cannot run (missing element) is a failure, never a pass.
 */
export async function evaluateExpect(page, step, locatorInfo, timeoutMs) {
  const expect = step.expect ?? {};
  const checks = [];
  const strategy = locatorInfo?.strategy ?? null;

  const needLocator = () =>
    ["visible", "hidden", "text", "notText", "value", "count", "state"].some((k) => expect[k] !== undefined);

  if (needLocator() && !locatorInfo) {
    return {
      passed: false,
      checks: [{ kind: "target", passed: false, detail: "expect requires a target" }],
    };
  }

  // --- presence / visibility
  if (expect.state !== undefined) {
    try {
      await locatorInfo.locator.waitFor({ state: expect.state, timeout: timeoutMs });
      checks.push({ kind: "state", passed: true, detail: `element reached state "${expect.state}"` });
    } catch (err) {
      checks.push({ kind: "state", passed: false, detail: `element did not reach state "${expect.state}": ${truncate(err.message)}` });
    }
  }
  if (expect.visible !== undefined) {
    const visible = await locatorInfo.locator.isVisible().catch(() => false);
    const passed = visible === expect.visible;
    checks.push({
      kind: "visible",
      passed,
      detail: passed
        ? `element visibility is ${visible} as expected`
        : `expected visible=${expect.visible} but element visibility is ${visible}`,
    });
  }
  if (expect.hidden !== undefined) {
    const visible = await locatorInfo.locator.isVisible().catch(() => false);
    const passed = visible === !expect.hidden;
    checks.push({
      kind: "hidden",
      passed,
      detail: passed ? `element hidden=${expect.hidden} as expected` : `expected hidden=${expect.hidden} but element visibility is ${visible}`,
    });
  }

  // --- text
  if (expect.text !== undefined || expect.notText !== undefined) {
    let text = "";
    let errored = null;
    try {
      text = (await locatorInfo.locator.first().textContent({ timeout: timeoutMs })) ?? "";
    } catch (err) {
      errored = err;
    }
    if (errored) {
      checks.push({ kind: "text", passed: false, detail: `could not read element text: ${truncate(errored.message)}` });
    } else {
      if (expect.text !== undefined) {
        const passed = text.includes(expect.text);
        checks.push({
          kind: "text",
          passed,
          detail: passed ? `text contains ${JSON.stringify(truncate(expect.text, 60))}` : `text ${JSON.stringify(truncate(text, 120))} does not contain ${JSON.stringify(truncate(expect.text, 60))}`,
        });
      }
      if (expect.notText !== undefined) {
        const passed = !text.includes(expect.notText);
        checks.push({
          kind: "notText",
          passed,
          detail: passed ? `text does not contain ${JSON.stringify(truncate(expect.notText, 60))}` : `text unexpectedly contains ${JSON.stringify(truncate(expect.notText, 60))}`,
        });
      }
    }
  }

  // --- input value
  if (expect.value !== undefined) {
    let value;
    let errored = null;
    try {
      value = await locatorInfo.locator.first().inputValue({ timeout: timeoutMs });
    } catch (err) {
      errored = err;
    }
    if (errored) {
      checks.push({ kind: "value", passed: false, detail: `could not read input value: ${truncate(errored.message)}` });
    } else {
      const passed = value === expect.value;
      checks.push({ kind: "value", passed, detail: passed ? "input value matches" : `input value ${JSON.stringify(value)} != expected ${JSON.stringify(expect.value)}` });
    }
  }

  // --- count
  if (expect.count !== undefined) {
    try {
      const count = await locatorInfo.locator.count();
      const passed = count === expect.count;
      checks.push({ kind: "count", passed, detail: passed ? `found exactly ${count} match(es)` : `found ${count} match(es), expected ${expect.count}` });
    } catch (err) {
      checks.push({ kind: "count", passed: false, detail: `could not count matches: ${truncate(err.message)}` });
    }
  }

  // --- url
  if (expect.url !== undefined) {
    const actual = page.url();
    const { ok, detail } = matchUrl(actual, expect.url);
    checks.push({ kind: "url", passed: ok, detail });
  }

  if (checks.length === 0) {
    return { passed: true, checks: [], detail: "no assertions requested" };
  }
  const passed = checks.every((c) => c.passed);
  return {
    passed,
    checks,
    detail: checks
      .filter((c) => !c.passed)
      .map((c) => `${c.kind}: ${c.detail}`)
      .join("; ") || "all checks passed",
    strategy,
  };
}

/* ------------------------------------------------------------------ */
/* Motion helpers: scrolling and typing                                */
/* ------------------------------------------------------------------ */

const DEFAULT_SCROLL_DURATION_MS = 550;

/**
 * Scroll the document to `targetY` with an eased animation.
 *
 * Playwright's built-in scrolling jumps instantly, which reads as a teleport
 * on video. This is the one animation the recorder adds to the page, and it
 * uses `requestAnimationFrame` so frames are real rather than a CSS transition
 * that a screenshot could catch halfway. The expression is fixed and never
 * built from plan text.
 */
export async function smoothScrollTo(page, targetY, durationMs = DEFAULT_SCROLL_DURATION_MS) {
  const duration = Number.isFinite(durationMs) ? Math.max(0, durationMs) : DEFAULT_SCROLL_DURATION_MS;
  if (duration === 0) {
    await page.evaluate((y) => window.scrollTo(0, y), targetY);
    return;
  }
  await page.evaluate(
    ({ targetY: wanted, durationMs: duration }) =>
      new Promise((resolve) => {
        const startY = window.scrollY;
        const maxY = Math.max(
          0,
          (document.scrollingElement?.scrollHeight ?? document.body.scrollHeight) - window.innerHeight
        );
        const endY = Math.min(Math.max(0, wanted), maxY);
        const delta = endY - startY;
        if (Math.abs(delta) < 1) {
          resolve();
          return;
        }
        const started = performance.now();
        const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
        const step = (now) => {
          const progress = Math.min(1, (now - started) / duration);
          window.scrollTo(0, startY + delta * ease(progress));
          if (progress < 1) requestAnimationFrame(step);
          else resolve();
        };
        requestAnimationFrame(step);
      }),
    { targetY, durationMs: duration }
  );
}

/**
 * Bring an element into the viewport before interacting with it, smoothly.
 * A no-op when the element is already comfortably visible.
 */
export async function smoothIntoView(page, locator, { durationMs = DEFAULT_SCROLL_DURATION_MS, margin = 64 } = {}) {
  if (!locator) return;
  const duration = Number.isFinite(durationMs) ? Math.max(0, durationMs) : DEFAULT_SCROLL_DURATION_MS;
  if (duration === 0) {
    await locator.scrollIntoViewIfNeeded().catch(() => {});
    return;
  }
  let box;
  try {
    box = await locator.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return {
        top: r.top,
        bottom: r.bottom,
        height: r.height,
        scrollY: window.scrollY,
        viewport: window.innerHeight,
      };
    });
  } catch {
    return;
  }
  if (box.top >= margin && box.bottom <= box.viewport - margin) return;
  const targetY = box.scrollY + box.top - Math.max(24, (box.viewport - box.height) / 2);
  await smoothScrollTo(page, targetY, duration);
}

/** Fill a field the way a person does: focus, clear, then type. */
async function typeNaturally(locator, value, ctx, timeoutMs) {
  const text = String(value);
  const delay = Number.isFinite(ctx.typingDelayMs) ? Math.max(0, ctx.typingDelayMs) : 0;
  if (ctx.naturalTyping === false || delay === 0 || text.length > 160) {
    await locator.fill(text, { timeout: timeoutMs });
    return;
  }
  await locator.fill("", { timeout: timeoutMs });
  await locator.pressSequentially(text, {
    delay,
    // Typing is deliberately paced, so the per-step timeout must not cut a
    // long-but-reasonable value short.
    timeout: Math.max(timeoutMs, 30000),
  });
}

/* ------------------------------------------------------------------ */
/* Step execution                                                      */
/* ------------------------------------------------------------------ */

/**
 * Execute one step.
 *
 * @returns {Promise<{status, assertion?, error?, executedAction}>}
 *   status is one of: ok | failed
 */
export async function executeStep(page, step, ctx) {
  const timeoutMs = step.timeoutMs ?? ctx.defaultTimeoutMs;
  const action = step.action;

  let locatorInfo = null;
  if (step.target) {
    locatorInfo = buildLocator(page, step.target);
  }
  // Assertions may target a different element than the action did — for example
  // clicking "Create" and then verifying the resulting confirmation banner.
  let assertInfo = locatorInfo;
  if (step.assertOn) {
    assertInfo = buildLocator(page, step.assertOn);
  }

  try {
    const motion = {
      durationMs: ctx.scrollDurationMs ?? DEFAULT_SCROLL_DURATION_MS,
    };
    switch (action) {
      case "goto": {
        const url = step.url ?? new URL(step.path ?? "/", ctx.baseUrl).toString();
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
        // `load` is best-effort: apps with long-polling never reach networkidle.
        await page.waitForLoadState("load", { timeout: Math.min(timeoutMs, 8000) }).catch(() => {});
        break;
      }
      case "click":
        await smoothIntoView(page, locatorInfo.locator, motion);
        await locatorInfo.locator.click({ timeout: timeoutMs });
        break;
      case "fill":
        await smoothIntoView(page, locatorInfo.locator, motion);
        await locatorInfo.locator.click({ timeout: timeoutMs });
        await typeNaturally(locatorInfo.locator, step.value, ctx, timeoutMs);
        break;
      case "select":
        await smoothIntoView(page, locatorInfo.locator, motion);
        await locatorInfo.locator.click({ timeout: timeoutMs });
        await locatorInfo.locator.selectOption(
          step.value !== undefined
            ? step.value
            : step.label !== undefined
              ? { label: step.label }
              : { index: step.index },
          { timeout: timeoutMs }
        );
        break;
      case "check":
        await smoothIntoView(page, locatorInfo.locator, motion);
        await locatorInfo.locator.check({ timeout: timeoutMs });
        break;
      case "uncheck":
        await smoothIntoView(page, locatorInfo.locator, motion);
        await locatorInfo.locator.uncheck({ timeout: timeoutMs });
        break;
      case "press":
        if (locatorInfo) {
          await smoothIntoView(page, locatorInfo.locator, motion);
          await locatorInfo.locator.press(step.key, { timeout: timeoutMs });
        } else {
          await page.keyboard.press(step.key);
        }
        break;
      case "hover":
        await smoothIntoView(page, locatorInfo.locator, motion);
        await locatorInfo.locator.hover({ timeout: timeoutMs });
        break;
      case "scroll": {
        if (locatorInfo) {
          await smoothIntoView(page, locatorInfo.locator, motion);
        } else if (step.to === "bottom") {
          const maxY = await page.evaluate(() =>
            Math.max(0, (document.scrollingElement?.scrollHeight ?? document.body.scrollHeight) - window.innerHeight)
          );
          await smoothScrollTo(page, maxY, motion.durationMs);
        } else if (step.to === "top") {
          await smoothScrollTo(page, 0, motion.durationMs);
        } else if (Number.isInteger(step.y)) {
          await smoothScrollTo(page, step.y, motion.durationMs);
        }
        break;
      }
      case "waitFor": {
        const state = step.state ?? "visible";
        await locatorInfo.locator.waitFor({ state, timeout: timeoutMs });
        break;
      }
      case "assert":
        // assertion-only step; handled below
        break;
      case "caption":
        await ctx.showCaption(step.text, step.durationMs);
        break;
      case "checkpoint":
        await ctx.showChapter(step.title, { description: step.description, duration: step.durationMs });
        break;
      case "pause":
        await page.waitForTimeout(step.ms);
        break;
      default:
        return { status: "failed", error: { name: "UnsupportedAction", message: `unsupported action "${action}"` } };
    }
  } catch (err) {
    // A step failure is data, not an exception: the caller records which step
    // failed and why, and the run is reported as failed. Throwing here would
    // lose that context.
    return {
      status: "failed",
      error: {
        name: err?.name ?? "Error",
        message: err?.message ?? String(err),
        locator: locatorInfo?.description ?? null,
      },
      locator: locatorInfo ? { strategy: locatorInfo.strategy, description: locatorInfo.description } : null,
    };
  }

  // --- assertions run against the post-action state, which is the point.
  let assertion;
  if (step.expect) {
    assertion = await evaluateExpect(page, step, assertInfo, timeoutMs);
    if (!assertion.passed) {
      return {
        status: "failed",
        assertion,
        error: { name: "AssertionFailed", message: assertion.detail },
      };
    }
  }

  return {
    status: "ok",
    assertion,
    locator: locatorInfo ? { strategy: locatorInfo.strategy, description: locatorInfo.description } : null,
    assertLocator: step.assertOn ? { strategy: assertInfo.strategy, description: assertInfo.description } : null,
  };
}
