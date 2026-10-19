/**
 * Browser capture engine.
 *
 * Owns: browser launch, recording start/stop, the step loop, on-screen cursor
 * and caption decoration, and the per-step timeline. It deliberately does not
 * know about output directories or artifacts — `record-workflow.mjs` orchestrates
 * that, and the Windows worker re-enters that same orchestrator.
 */

import fs from "node:fs";
import path from "node:path";
import { SKILL_DIR, detectSystemBrowserChannel } from "./browser-env.mjs";
import { executeStep } from "./runner.mjs";
import { redactSecrets } from "./lib.mjs";

const CURSOR_STYLE_FILE = path.join(SKILL_DIR, "assets", "cursor", "cursor-style.json");

/** Escape text destined for the caption overlay so plan text can never inject HTML. */
export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Load the cursor preset. Falls back to built-in defaults. */
export function loadCursorStyle() {
  const fallback = {
    // Playwright's action title leaks raw selector text into a product demo.
    title: "display: none",
  };
  try {
    const raw = JSON.parse(fs.readFileSync(CURSOR_STYLE_FILE, "utf8"));
    return { ...fallback, ...raw };
  } catch {
    return fallback;
  }
}

/**
 * Caption overlay markup.
 * `pointer-events: none` is mandatory: the overlay must never intercept a click
 * or change hit testing. Position is limited to top/bottom so it cannot cover
 * the centre of the UI where the interaction happens.
 */
export function captionOverlayHtml(text, { position = "bottom", width = "70vw" } = {}) {
  const vertical = position === "top" ? "top: 24px" : "bottom: 24px";
  return (
    `<div style="position:fixed;left:50%;transform:translateX(-50%);${vertical};` +
    `pointer-events:none;z-index:2147483647;` +
    `font: 500 17px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;` +
    `color:#fff;background:rgba(17,19,24,.88);padding:10px 18px;border-radius:10px;` +
    `max-width:${width};text-align:center;box-shadow:0 6px 24px rgba(0,0,0,.35);` +
    `-webkit-font-smoothing:antialiased">${escapeHtml(text)}</div>`
  );
}

/**
 * Browser flags this skill never passes.
 *
 * The list is not a style choice:
 *
 *   --user-data-dir        Chrome 136+ requires a *non-default* profile for
 *                          remote debugging, and pointing it at the everyday
 *                          "User Data" directory is exactly what must never
 *                          happen. Playwright's `launch()` already uses a
 *                          throwaway profile, so no profile flag is needed.
 *   --remote-debugging-*   opens a control port. The skill never attaches to
 *                          a running browser, so it never needs one.
 *   --disable-lcd-text     turns sub-pixel antialiasing off, which changes how
 *                          text looks. Grayscale rendering is an explicit
 *                          choice, never a default.
 *   --load-extension       would run the user's extensions in the recording.
 *   --proxy-server         would send the recording through something else.
 */
export const FORBIDDEN_BROWSER_ARGS = [
  "--user-data-dir",
  "--remote-debugging-port",
  "--remote-debugging-pipe",
  "--disable-lcd-text",
  "--force-color-profile",
  "--load-extension",
  "--disable-extensions-except",
  "--proxy-server",
];

/**
 * The browser channel that will actually be used.
 *
 * The Windows worker sets RECORD_APP_SKILL_FORCE_CHANNEL so a Windows-side run
 * always drives the host's branded browser rather than a bundled Linux
 * download. The backend's resolved channel wins over detection, because the
 * backend already decided which browser the *rendering host* has; detection
 * only knows about the machine this process happens to run on.
 *
 * The plan's own default is "auto": the user's installed browser wins, because
 * that is the one whose fonts the demo should match. Playwright's bundled
 * Chromium is a different build with different font handling, which is
 * exactly the difference a demo must not have.
 */
export function resolveLaunchChannel(plan, { detect = detectSystemBrowserChannel, resolved = null } = {}) {
  const forced = process.env.RECORD_APP_SKILL_FORCE_CHANNEL;
  if (forced) return forced;
  const requested = plan.browser?.channel;
  if (requested && requested !== "auto") return requested;
  if (resolved) return resolved;
  return detect() ?? "chromium";
}

/** Translate plan channel names into Playwright launch options. */
export function launchOptionsFor(plan, options = {}) {
  const channel = resolveLaunchChannel(plan, options);
  const launch = { headless: plan.browser.headless };
  if (channel && channel !== "chromium") launch.channel = channel;
  return launch;
}

/**
 * The browser context's rendering settings.
 *
 * `colorScheme` and `reducedMotion` default to `null`, which means "the
 * host's own preference". Playwright's own defaults are `'light'` and
 * `'no-preference'`, which *override* a system set to dark or to reduced
 * motion — so a recording would not look like the machine it came from.
 * Passing `null` restores the host's behaviour.
 */
export function contextOptionsFor(plan, { storageState = null } = {}) {
  const browser = plan.browser ?? {};
  const options = {
    viewport: browser.viewport,
    deviceScaleFactor: browser.deviceScaleFactor,
  };
  if (browser.locale) options.locale = browser.locale;
  if (browser.colorScheme) options.colorScheme = browser.colorScheme;
  if (browser.reducedMotion) options.reducedMotion = browser.reducedMotion;
  if (storageState) options.storageState = storageState;
  return options;
}

/**
 * The rendering settings a recording actually used, for the manifest.
 *
 * `null` is reported as "system", because that is what it means: the browser
 * used whatever the host was set to.
 */
export function renderingSettingsFor(plan) {
  const browser = plan.browser ?? {};
  return {
    locale: browser.locale ?? "system",
    colorScheme: browser.colorScheme ?? "system",
    reducedMotion: browser.reducedMotion ?? "system",
    deviceScaleFactor: browser.deviceScaleFactor ?? 1,
    viewport: browser.viewport,
    fontsInjected: false,
    applicationCssOverridden: false,
    grayscaleProfile: "off",
  };
}

/**
 * Run a validated plan inside an already-launched page while recording.
 *
 * @param {object} params
 * @param {import('playwright').Page} params.page
 * @param {object} params.plan     fully defaulted + validated plan
 * @param {object} params.capture  the page.screencast object
 * @param {string} params.rawPath  where the screencast writes its file
 * @param {(msg: string) => void} [params.log]
 */
export async function runCapture({ page, plan, capture, rawPath, log = () => {} }) {
  const capture_ = plan.capture;
  const fps = capture_.fps;
  const startedAt = Date.now();

  const cursorStyle = loadCursorStyle();
  const warnings = [];
  const steps = [];
  const warningsFromPlan = [];

  const deadline = startedAt + (plan.maxDurationMs ?? 240000);

  // --- start recording -------------------------------------------------
  const viewport = plan.browser.viewport;
  await capture.start({
    path: rawPath,
    size: { width: viewport.width, height: viewport.height },
    fps,
  });
  // The recording window starts when the encoder is running. Everything
  // before this point is setup, and everything after the stop below is the
  // encoder flushing the file — neither is in the video.
  const captureStartedAt = Date.now();

  let actionDecorations = null;
  if (capture_.cursor.enabled) {
    // Only the pointer itself is drawn. Playwright's click point and element
    // highlight are intentionally omitted: a product demo should look like a
    // person using the app, not like an annotated test run.
    actionDecorations = await capture.showActions({
      cursor: "pointer",
      duration: capture_.cursor.duration,
      style: {
        title: cursorStyle.title,
      },
    });
  }

  // --- shared decoration hooks ----------------------------------------
  const showCaption = async (text, durationMs) => {
    if (!capture_.captions.enabled) return;
    const duration = durationMs ?? capture_.captions.duration;
    await capture.showOverlay(captionOverlayHtml(text, { position: capture_.captions.position }), { duration });
  };

  const showChapter = async (title, { description, duration } = {}) => {
    if (!capture_.chapters.enabled) return;
    await capture.showChapter(title, {
      ...(description ? { description } : {}),
      duration: duration ?? capture_.chapters.duration,
    });
  };

  // Opening title card, so the demo starts from an understood state.
  if (capture_.chapters.enabled) {
    await showChapter(plan.title, { description: plan.description ?? undefined });
    await page.waitForTimeout(capture_.chapters.duration);
  }

  const ctx = {
    baseUrl: plan.baseUrl,
    defaultTimeoutMs: plan.browser.timeoutMs,
    typingDelayMs: capture_.typingDelayMs,
    smoothScroll: capture_.smoothScroll,
    scrollDurationMs: capture_.scrollDurationMs,
    showCaption,
    showChapter,
  };

  // --- step loop -------------------------------------------------------
  let failure = null;
  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    const id = step.id ?? `${i + 1}-${step.action}`;
    const title = step.title ?? step.action;
    const scene = step.scene ?? null;

    if (Date.now() > deadline) {
      failure = {
        stepId: id,
        name: "MaxDurationExceeded",
        message: `the workflow exceeded the maximum duration of ${Math.round((plan.maxDurationMs ?? 240000) / 1000)}s before step ${id}; increase --max-duration-ms or shorten the plan`,
      };
      warnings.push(failure.message);
      break;
    }

    const stepStart = Date.now();
    // A `caption` step narrates itself through `text`; every other action can
    // carry a caption in its `caption` field.
    const isCaptionStep = step.action === "caption";
    const captionText = isCaptionStep ? step.text : (step.caption ?? null);
    let captionWindow = null;
    let captionHoldMs = 0;

    // The caption is shown *before* the action so it is readable while the
    // interaction happens underneath it.
    if (step.caption && capture_.captions.enabled && !isCaptionStep) {
      const duration = capture_.captions.duration;
      await showCaption(step.caption);
      captionWindow = { startMs: stepStart - startedAt, endMs: stepStart - startedAt + duration };
      captionHoldMs = duration;
    }

    let outcome;
    try {
      outcome = await executeStep(page, step, ctx);
    } catch (err) {
      outcome = {
        status: "failed",
        error: {
          name: err?.name ?? "Error",
          message: redactSecrets(err?.message ?? String(err)),
        },
      };
    }

    // A caption step holds its own overlay; give it a real time window so it is
    // readable in the recording and produces a real subtitle entry.
    if (isCaptionStep && capture_.captions.enabled) {
      const duration =
        Number.isFinite(step.durationMs) && step.durationMs > 0 ? step.durationMs : capture_.captions.duration;
      captionWindow = { startMs: stepStart - startedAt, endMs: stepStart - startedAt + duration };
      captionHoldMs = duration;
    }

    // Hold until the caption has been on screen for its configured duration.
    if (captionHoldMs > 0) {
      const remaining = stepStart - startedAt + captionHoldMs - (Date.now() - startedAt);
      if (remaining > 0) await page.waitForTimeout(remaining);
    }
    if (capture_.settleMs > 0) await page.waitForTimeout(capture_.settleMs);

    const endedAt = Date.now();
    const record = {
      id,
      index: i,
      action: step.action,
      title,
      scene,
      caption: captionText,
      optional: step.optional === true,
      status: outcome.status,
      selector: outcome.locator?.description ?? null,
      selectorStrategy: outcome.locator?.strategy ?? null,
      assertSelector: outcome.assertLocator?.description ?? null,
      startedAtMs: stepStart - startedAt,
      endedAtMs: endedAt - startedAt,
      durationMs: endedAt - stepStart,
      captionWindow,
      assertion: outcome.assertion
        ? { passed: outcome.assertion.passed, checks: outcome.assertion.checks ?? [] }
        : null,
      error: outcome.error ?? null,
    };

    if (outcome.status === "failed" && step.optional) {
      record.status = "failed-optional";
      warnings.push(`optional step ${id} (${title}) failed: ${outcome.error?.message ?? "unknown error"}`);
    }

    steps.push(record);

    if (record.status === "failed" && !step.optional) {
      failure = { stepId: id, ...outcome.error };
      log(`step ${id} (${title}) FAILED: ${outcome.error?.message ?? "unknown error"}`);
      break;
    }
  }

  // --- stop recording --------------------------------------------------
  // The recording window ends here. `capture.stop()` then makes the encoder
  // flush and close the file, which on a loaded machine can take seconds;
  // that time is *not* in the video, so counting it would make a correct
  // take look like a truncated one.
  const captureEndedAt = Date.now();
  // Always stop so whatever was captured survives, even on failure.
  let stopError = null;
  try {
    if (actionDecorations) await actionDecorations.dispose();
    await capture.hideOverlays().catch(() => {});
    await capture.stop();
  } catch (err) {
    stopError = redactSecrets(err?.message ?? String(err));
    warnings.push(`stopping the screencast reported an error: ${stopError}`);
  }

  const endedAt = Date.now();
  return {
    steps,
    warnings,
    warningsFromPlan,
    failure,
    stopError,
    captureStartedAtMs: captureStartedAt - startedAt,
    captureDurationMs: captureEndedAt - startedAt,
    captureTeardownMs: endedAt - captureEndedAt,
    rootDir: startedAt,
    scenes: buildScenes(steps),
  };
}

/** Group steps into scenes using the `scene` label, falling back to captions. */
function buildScenes(steps) {
  const scenes = [];
  let current = null;
  for (const step of steps) {
    const key = step.scene ?? (step.caption ? step.title : null);
    if (key === null) {
      // Steps with no scene label still belong to the timeline; append to the
      // current scene when one is open so the storyboard stays readable.
      if (current) current.stepIds.push(step.id);
      continue;
    }
    if (!current || current.name !== key || current.closed) {
      current = {
        name: key,
        startMs: step.startedAtMs,
        endMs: step.endedAtMs,
        stepIds: [step.id],
        captions: [],
        assertions: [],
      };
      scenes.push(current);
    } else {
      current.stepIds.push(step.id);
    }
    current.endMs = step.endedAtMs;
    if (step.caption) current.captions.push(step.caption);
    if (step.assertion) current.assertions.push({ stepId: step.id, passed: step.assertion.passed });
  }
  return scenes;
}

/** Build an SRT document from the recorded caption windows. */
export function buildSrt(steps) {
  const entries = steps.filter((s) => s.caption && s.captionWindow);
  if (entries.length === 0) return "";
  const fmt = (ms) => {
    const total = Math.max(0, Math.round(ms));
    const h = String(Math.floor(total / 3600000)).padStart(2, "0");
    const m = String(Math.floor((total % 3600000) / 60000)).padStart(2, "0");
    const s = String(Math.floor((total % 60000) / 1000)).padStart(2, "0");
    const millis = String(total % 1000).padStart(3, "0");
    return `${h}:${m}:${s},${millis}`;
  };
  return (
    entries
      .map((step, i) => {
        const start = fmt(step.captionWindow.startMs);
        // Guarantee a visible minimum so a very short step still shows its caption.
        const end = fmt(Math.max(step.captionWindow.endMs, step.captionWindow.startMs + 800));
        return `${i + 1}\n${start} --> ${end}\n${step.caption}\n`;
      })
      .join("\n") + "\n"
  );
}

/** Render the storyboard markdown from the recorded timeline. */
export function buildStoryboard({ plan, timeline }) {
  const lines = [];
  lines.push(`# Storyboard — ${plan.title}`);
  lines.push("");
  if (plan.description) {
    lines.push(plan.description);
    lines.push("");
  }
  lines.push(`- Application: \`${plan.baseUrl}\``);
  lines.push(`- Starting route: \`${plan.startRoute}\``);
  lines.push(`- Scenes: ${timeline.scenes.length} · Steps: ${timeline.steps.length}`);
  lines.push(`- Recorded duration: ${(timeline.captureDurationMs / 1000).toFixed(1)}s`);
  lines.push("");

  const sceneHeader = (scene, i) => {
    const start = (scene.startMs / 1000).toFixed(1);
    const end = (scene.endMs / 1000).toFixed(1);
    lines.push(`## Scene ${i + 1} — ${scene.name}`);
    lines.push("");
    lines.push(`_${start}s → ${end}s_`);
    lines.push("");
  };

  if (timeline.scenes.length === 0) {
    lines.push("## Steps");
    lines.push("");
    lines.push("| # | Time | Step | Purpose | Result |");
    lines.push("| - | ---- | ---- | ------- | ------ |");
    for (const step of timeline.steps) {
      lines.push(
        `| ${step.index + 1} | ${(step.startedAtMs / 1000).toFixed(1)}s | ${step.title} | ${step.caption ?? ""} | ${statusLabel(step)} |`
      );
    }
  } else {
    const byId = new Map(timeline.steps.map((s) => [s.id, s]));
    timeline.scenes.forEach((scene, i) => {
      sceneHeader(scene, i);
      lines.push("| # | Time | Step | Purpose | Selector | Result |");
      lines.push("| - | ---- | ---- | ------- | -------- | ------ |");
      for (const id of scene.stepIds) {
        const step = byId.get(id);
        if (!step) continue;
        lines.push(
          `| ${step.index + 1} | ${(step.startedAtMs / 1000).toFixed(1)}s | ${step.title} | ${step.caption ?? ""} | ${step.selector ? `\`${step.selector}\`` : "—"} | ${statusLabel(step)} |`
        );
      }
      lines.push("");
    });
  }
  return lines.join("\n") + "\n";
}

function statusLabel(step) {
  if (step.status === "ok") return step.assertion ? "✅ verified" : "✅";
  if (step.status === "failed-optional") return "⚠️ optional step failed";
  if (step.status === "failed") return "❌ failed";
  return step.status;
}
