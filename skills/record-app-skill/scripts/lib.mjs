/**
 * Shared contract for record-app-skill.
 *
 * This module is the single source of truth for:
 *   - the workflow-plan schema and its validation rules
 *   - the semantic-selector preference order
 *   - the safety rules (prohibited actions, consequential actions, URL allow-list)
 *   - secret detection and safe output-path handling
 *   - process exit codes
 *
 * Every other script imports from here. No script re-implements validation.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

/* ------------------------------------------------------------------ */
/* Contract constants                                                  */
/* ------------------------------------------------------------------ */

export const SCHEMA_VERSION = 1;

export const SKILL_NAME = "record-app-skill";

/** Stable exit-code contract, asserted by tests and documented in the README. */
export const EXIT = {
  OK: 0,
  INTERNAL: 1,
  INVALID_PLAN: 2,
  OUTPUT_CONFLICT: 3,
  MISSING_DEPENDENCY: 4,
  WORKFLOW_FAILED: 5,
  ENVIRONMENT_FAILED: 6,
};

/**
 * The backends a plan may ask for.
 *
 *   auto             detect the rendering host and use its real browser
 *   native           the host's registered default browser, or nothing
 *   local-playwright the portable build: Playwright's bundled Chromium
 *   windows-native   the Windows host's browser (the WSL case); kept as an
 *                    explicit name because plans and older scripts use it
 */
export const BROWSER_BACKENDS = ["auto", "native", "local-playwright", "windows-native"];

/**
 * The browsers a plan may name.
 *
 * "auto" uses the installed Chrome or Edge — the fonts the user sees;
 * "chromium" is Playwright's bundled build and is only used when the plan
 * asks for it explicitly. Firefox and Safari are deliberately absent:
 * Playwright's Firefox and WebKit are patched upstream builds, not the
 * installed products, so naming them would misrepresent what is recorded.
 */
export const BROWSER_CHANNELS = ["auto", "chromium", "chrome", "msedge"];

/** Channels that exist in the wild but cannot be driven as the real product. */
export const UNSUPPORTED_CHANNELS = {
  firefox:
    "Playwright's Firefox is a patched upstream build, not your Firefox. This skill does not drive the installed " +
    "Firefox, because the recording would not be your browser. Use an installed Chrome or Edge, or --backend local-playwright.",
  safari:
    "Playwright cannot drive the installed Safari (its WebKit is a patched build). Use an installed Chrome or Edge, " +
    "or --backend local-playwright.",
  webkit: "Playwright's WebKit is a patched upstream build, not Safari. Use an installed Chrome or Edge, or --backend local-playwright.",
};

/** Colour schemes a plan may request. `null` means "whatever the host uses". */
export const COLOR_SCHEMES = ["light", "dark", "no-preference"];
/** Motion preferences a plan may request. `null` means "whatever the host uses". */
export const REDUCED_MOTIONS = ["reduce", "no-preference"];

/** The desktop capture size, and the mobile one a mobile workflow asks for. */
export const DEFAULT_VIEWPORT = { width: 1440, height: 900 };
export const MOBILE_VIEWPORT = { width: 390, height: 844 };
export const APP_MODES = ["existing", "production"];
export const AUTH_MODES = ["none", "storage-state", "manual"];

/**
 * Render quality presets. `high` is the default so a delivered demo looks
 * sharp; the other two exist for people who explicitly want smaller files.
 */
export const QUALITY_PRESETS = {
  high: { crf: 18, preset: "slow" },
  balanced: { crf: 20, preset: "medium" },
  compact: { crf: 23, preset: "medium" },
};
export const QUALITY_NAMES = Object.keys(QUALITY_PRESETS);

/** Default capture rate. 60 fps keeps pointer and scroll motion smooth. */
export const DEFAULT_FPS = 60;

/** Everything is written under `.video` in the project directory by default. */
export const DEFAULT_OUTPUT_DIR = ".video";

/** Selector strategies in the required preference order. */
export const SELECTOR_STRATEGIES = ["role", "label", "placeholder", "testId", "text", "css"];

/**
 * Step actions that may appear in a plan. Anything not on this list — most
 * importantly anything resembling `evaluate`, `script`, or `inject` — is
 * rejected. A JSON plan is data, never code.
 */
export const STEP_ACTIONS = [
  "goto",
  "click",
  "fill",
  "select",
  "check",
  "uncheck",
  "press",
  "hover",
  "scroll",
  "waitFor",
  "assert",
  "caption",
  "checkpoint",
  "pause",
];

/** Actions that inherently change application data. */
export const MUTATING_ACTIONS = ["click", "fill", "select", "check", "uncheck", "press"];

/**
 * Words that indicate an action may be externally consequential: it sends,
 * pays, publishes, deletes, or otherwise escapes the local environment. Such
 * steps require explicit authorization in the plan *and* a CLI flag.
 *
 * Precision matters more than recall here, because a false positive blocks a
 * perfectly safe recording and forces the user through an authorization
 * prompt. Bare nouns that appear in ordinary product UI ("Cancel" on a modal,
 * "Post title", "Remove filter") are therefore deliberately not matched: they
 * are matched only in the object-taking form that implies a real effect.
 */
export const CONSEQUENTIAL_PATTERNS = [
  /\b(send|email|invite|notify|share|publish|deploy|release|tweet|broadcast)\b/i,
  /\b(pay|payment|purchase|checkout|charge|billing|invoice|refund|transfer|withdraw|wire)\b/i,
  /\b(delete|destroy|purge|revoke|terminate)\b/i,
  /\bremove\s+(?:the\s+|this\s+|my\s+)?(?:user|account|member|project|workspace|team|organisation|organization|repository|record|dataset|file|integration|subscription)\b/i,
  /\bcancel\s+(?:the\s+|this\s+|my\s+)?(?:subscription|order|booking|reservation|account|payment|plan|appointment)\b/i,
  /\b(place|submit|confirm)\s+order\b/i,
  /\bsign\s+(?:the\s+|this\s+)?(?:contract|agreement|lease)\b/i,
];

/** Assertion keys permitted inside a step's `expect` object. */
export const EXPECT_KEYS = [
  "visible",
  "hidden",
  "text",
  "notText",
  "value",
  "url",
  "count",
  "state",
  "timeoutMs",
];

/**
 * Every field a step may carry. Unknown fields are rejected so that a typo
 * cannot silently weaken an expectation.
 */
export const ALLOWED_STEP_KEYS = new Set([
  "id",
  "action",
  "title",
  "caption",
  "scene",
  "target",
  "assertOn",
  "expect",
  "timeoutMs",
  "consequential",
  "optional",
  // action-specific
  "path",
  "url",
  "value",
  "label",
  "index",
  "key",
  "to",
  "y",
  "ms",
  "state",
  "text",
  "description",
  "durationMs",
]);

/* ------------------------------------------------------------------ */
/* Small utilities                                                     */
/* ------------------------------------------------------------------ */

export function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readJsonFile(file) {
  const raw = fs.readFileSync(file, "utf8");
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${file}: not valid JSON (${err.message})`);
  }
}

/** Shallow-merge defaults into a plan, one level deep for known object keys. */
export function withDefaults(plan) {
  const defaults = {
    schemaVersion: SCHEMA_VERSION,
    startRoute: "/",
    browser: {
      backend: "auto",
      channel: "auto",
      viewport: { ...DEFAULT_VIEWPORT },
      deviceScaleFactor: 1,
      headless: true,
      timeoutMs: 15000,
      // Rendering fidelity. `null` means "whatever the host does", which is
      // what makes the recording match what the user actually sees: Playwright
      // otherwise forces a light colour scheme and no motion preference over
      // the system's own settings.
      locale: null,
      colorScheme: null,
      reducedMotion: null,
    },
    capture: {
      fps: DEFAULT_FPS,
      settleMs: 500,
      typingDelayMs: 45,
      scrollDurationMs: 550,
      smoothScroll: true,
      cursor: { enabled: true, duration: 800 },
      captions: { enabled: false, duration: 2800 },
      chapters: { enabled: false, duration: 1800 },
    },
    auth: { mode: "none", storageStateFile: null },
    safety: { allowedHosts: [], allowConsequential: false },
    output: { dir: DEFAULT_OUTPUT_DIR },
    // The application under the lens. `mode: "production"` builds the app and
    // records against the built output, which is what makes a demo smooth:
    // a development server's hot-reload machinery shows up in the video as lag.
    app: {
      mode: "existing",
      root: null,
      build: null,
      serve: null,
      url: null,
      buildTimeoutMs: 600000,
      readyTimeoutMs: 60000,
    },
    media: {
      container: "mp4",
      videoCodec: "h264",
      fps: DEFAULT_FPS,
      quality: "high",
      crf: QUALITY_PRESETS.high.crf,
      preset: QUALITY_PRESETS.high.preset,
    },
  };
  const merged = { ...defaults, ...plan };
  for (const key of [
    "browser",
    "capture",
    "auth",
    "safety",
    "output",
    "media",
    "app",
  ]) {
    merged[key] = { ...defaults[key], ...(isPlainObject(plan[key]) ? plan[key] : {}) };
  }
  merged.capture.cursor = { ...defaults.capture.cursor, ...(plan.capture?.cursor ?? {}) };
  merged.capture.captions = { ...defaults.capture.captions, ...(plan.capture?.captions ?? {}) };
  merged.capture.chapters = { ...defaults.capture.chapters, ...(plan.capture?.chapters ?? {}) };

  // Captions and chapters are off unless the plan actually uses them. An
  // explicit `enabled: false` always wins, so a plan can opt out even when it
  // contains a caption field for documentation purposes.
  const steps = Array.isArray(plan.steps) ? plan.steps : [];
  if (plan.capture?.captions?.enabled === undefined) {
    merged.capture.captions.enabled = steps.some(
      (step) =>
        step?.action === "caption" ||
        (step?.action !== "checkpoint" && typeof step?.caption === "string" && step.caption)
    );
  }
  if (plan.capture?.chapters?.enabled === undefined) {
    merged.capture.chapters.enabled = steps.some((step) => step?.action === "checkpoint");
  }

  // A quality preset only supplies settings the author did not choose.
  const requestedQuality = plan.media?.quality;
  if (requestedQuality !== undefined && QUALITY_PRESETS[requestedQuality]) {
    const preset = QUALITY_PRESETS[requestedQuality];
    if (plan.media?.crf === undefined) merged.media.crf = preset.crf;
    if (plan.media?.preset === undefined) merged.media.preset = preset.preset;
  }
  // The render rate follows the capture rate unless media.fps was explicit.
  if (plan.media?.fps === undefined) merged.media.fps = merged.capture.fps;
  return merged;
}

/* ------------------------------------------------------------------ */
/* Selector handling                                                   */
/* ------------------------------------------------------------------ */

/** Return the identifier of the highest-preference strategy present. */
export function selectorStrategy(target) {
  for (const s of SELECTOR_STRATEGIES) {
    if (target?.[s] !== undefined && target[s] !== null) return s;
  }
  return null;
}

export function describeSelector(target) {
  if (!isPlainObject(target)) return "<invalid target>";
  const s = selectorStrategy(target);
  if (!s) return "<no selector>";
  if (s === "role") {
    const name = target.name === undefined ? "" : ` name=${JSON.stringify(target.name)}`;
    return `role=${JSON.stringify(target.role)}${name}`;
  }
  if (s === "css") return `css=${JSON.stringify(target.css)}`;
  return `${s}=${JSON.stringify(target[s])}`;
}

/**
 * A target is valid only when it carries exactly one selector strategy.
 * Multiple strategies make the plan ambiguous about preference order and are
 * rejected rather than silently resolved.
 */
export function validateTarget(target, compileError) {
  if (!isPlainObject(target)) {
    compileError("target must be an object");
    return;
  }
  const present = SELECTOR_STRATEGIES.filter(
    (s) => target[s] !== undefined && target[s] !== null
  );
  if (present.length === 0) {
    compileError(
      `target has no selector; provide one of: ${SELECTOR_STRATEGIES.join(", ")}`
    );
    return;
  }
  if (present.length > 1) {
    compileError(
      `target has multiple selectors (${present.join(", ")}); keep exactly one so the preference order is unambiguous`
    );
  }
  for (const key of present) {
    if (typeof target[key] !== "string" || target[key].length === 0) {
      compileError(`target.${key} must be a non-empty string`);
    }
  }
  if (target.role !== undefined && target.name === undefined && target.exact === undefined) {
    // allowed: role-only locators are legitimate.
  }
  if (target.nth !== undefined) {
    if (!Number.isInteger(target.nth) || target.nth < 0) {
      compileError("target.nth must be a non-negative integer");
    }
  }
  if (target.exact !== undefined && typeof target.exact !== "boolean") {
    compileError("target.exact must be a boolean");
  }
}

/* ------------------------------------------------------------------ */
/* Consequential-action detection                                      */
/* ------------------------------------------------------------------ */

/**
 * Describe why a step looks externally consequential, or null when it does not.
 *
 * Two things keep this from firing on harmless steps:
 *
 *  - only *mutating* actions are considered, so a demo may freely assert that a
 *    destructive control exists, caption it, or scroll past it; and
 *  - machine-readable identifiers are normalised before matching, so a
 *    `#pay-now` button is caught even though its accessible name is unknown.
 */
export function consequentialReason(step) {
  if (!step || !MUTATING_ACTIONS.includes(step.action)) return null;
  const identifier = [step.target?.css, step.target?.testId]
    .filter((v) => typeof v === "string")
    .map((v) => v.replace(/[._#[\]()>-]+/g, " "))
    .join(" | ");
  const haystack = [
    step.title,
    step.caption,
    step.target?.name,
    step.target?.text,
    step.target?.label,
    step.target?.placeholder,
    step.assertOn?.name,
    step.assertOn?.text,
    identifier,
  ]
    .filter((v) => typeof v === "string" && v)
    .join(" | ");
  for (const re of CONSEQUENTIAL_PATTERNS) {
    const m = haystack.match(re);
    if (m) return `matches /${re.source}/ on "${m[0]}"`;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Plan validation                                                     */
/* ------------------------------------------------------------------ */

/**
 * Validate a workflow plan. Returns { errors, warnings, plan, steps }.
 * Never throws for plan content problems; the caller decides the exit code.
 */
export function validatePlan(input, options = {}) {
  const errors = [];
  const warnings = [];
  const err = (m) => errors.push(m);
  const warn = (m) => warnings.push(m);

  if (!isPlainObject(input)) {
    return { errors: ["plan must be a JSON object"], warnings, plan: null, steps: [] };
  }

  if (input.schemaVersion !== SCHEMA_VERSION) {
    err(`schemaVersion must be ${SCHEMA_VERSION} (got ${JSON.stringify(input.schemaVersion)})`);
  }
  if (typeof input.title !== "string" || !input.title.trim()) {
    err("title is required and must be a non-empty string");
  } else if (input.title.length > 120) {
    err("title must be at most 120 characters");
  }
  if (input.description !== undefined && typeof input.description !== "string") {
    err("description must be a string when present");
  }
  if (typeof input.baseUrl !== "string" || !input.baseUrl) {
    err("baseUrl is required");
  } else {
    let u;
    try {
      u = new URL(input.baseUrl);
    } catch {
      err(`baseUrl is not a valid URL: ${input.baseUrl}`);
    }
    if (u && !/^https?:$/.test(u.protocol)) {
      err(`baseUrl must be http or https (got ${u.protocol})`);
    }
  }

  const plan = withDefaults(input);
  const steps = Array.isArray(input.steps) ? input.steps : null;
  if (!steps) err("steps must be an array");
  if (steps && steps.length === 0) err("steps must contain at least one step");

  if (plan.browser) {
    if (!BROWSER_BACKENDS.includes(plan.browser.backend)) {
      err(`browser.backend must be one of ${BROWSER_BACKENDS.join(", ")}`);
    }
    if (!BROWSER_CHANNELS.includes(plan.browser.channel)) {
      const explanation = UNSUPPORTED_CHANNELS[plan.browser.channel];
      err(
        `browser.channel must be one of ${BROWSER_CHANNELS.join(", ")}` +
          (explanation ? ` — "${plan.browser.channel}" is not one of them: ${explanation}` : "")
      );
    }
    if (plan.browser.locale !== null && plan.browser.locale !== undefined) {
      if (typeof plan.browser.locale !== "string" || !/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(plan.browser.locale)) {
        err("browser.locale must be a BCP 47 language tag such as \"en-GB\", or null for the host's locale");
      }
    }
    if (plan.browser.colorScheme !== null && plan.browser.colorScheme !== undefined) {
      if (!COLOR_SCHEMES.includes(plan.browser.colorScheme)) {
        err(`browser.colorScheme must be one of ${COLOR_SCHEMES.join(", ")}, or null for the host's preference`);
      }
    }
    if (plan.browser.reducedMotion !== null && plan.browser.reducedMotion !== undefined) {
      if (!REDUCED_MOTIONS.includes(plan.browser.reducedMotion)) {
        err(`browser.reducedMotion must be one of ${REDUCED_MOTIONS.join(", ")}, or null for the host's preference`);
      }
    }
    if (plan.browser.deviceScaleFactor !== undefined) {
      if (!Number.isFinite(plan.browser.deviceScaleFactor) || plan.browser.deviceScaleFactor < 0.5 || plan.browser.deviceScaleFactor > 3) {
        err("browser.deviceScaleFactor must be a number between 0.5 and 3");
      }
    }
    const vp = plan.browser.viewport;
    if (!isPlainObject(vp) || !Number.isInteger(vp.width) || !Number.isInteger(vp.height)) {
      err("browser.viewport must be { width, height } integers");
    } else {
      for (const dim of ["width", "height"]) {
        if (vp[dim] < 200 || vp[dim] > 3840) err(`browser.viewport.${dim} must be between 200 and 3840`);
      }
      // Even dimensions keep H.264 chroma subsampling lossless.
      if (vp.width % 2 || vp.height % 2) {
        warn(
          `browser.viewport ${vp.width}x${vp.height} has an odd dimension; H.264 4:2:0 encoding requires even dimensions and the render step will round down`
        );
      }
    }
    if (typeof plan.browser.headless !== "boolean") err("browser.headless must be a boolean");
  }

  if (plan.capture) {
    if (!Number.isInteger(plan.capture.fps) || plan.capture.fps < 1 || plan.capture.fps > 60) {
      err("capture.fps must be an integer between 1 and 60");
    }
    if (!Number.isInteger(plan.capture.typingDelayMs) || plan.capture.typingDelayMs < 0 || plan.capture.typingDelayMs > 250) {
      err("capture.typingDelayMs must be an integer between 0 and 250");
    }
    if (
      !Number.isInteger(plan.capture.scrollDurationMs) ||
      plan.capture.scrollDurationMs < 0 ||
      plan.capture.scrollDurationMs > 3000
    ) {
      err("capture.scrollDurationMs must be an integer between 0 and 3000");
    }
    if (typeof plan.capture.smoothScroll !== "boolean") {
      err("capture.smoothScroll must be a boolean");
    }
    if (
      !isPlainObject(plan.capture.cursor) ||
      typeof plan.capture.cursor.enabled !== "boolean" ||
      !Number.isFinite(plan.capture.cursor.duration) ||
      plan.capture.cursor.duration < 0
    ) {
      err("capture.cursor must be { enabled: boolean, duration: non-negative number }");
    }
    for (const overlay of ["captions", "chapters"]) {
      const value = plan.capture[overlay];
      if (
        !isPlainObject(value) ||
        typeof value.enabled !== "boolean" ||
        !Number.isFinite(value.duration) ||
        value.duration < 0
      ) {
        err(`capture.${overlay} must be { enabled: boolean, duration: non-negative number }`);
      }
    }
    if (plan.capture.settleMs !== undefined && (!Number.isFinite(plan.capture.settleMs) || plan.capture.settleMs < 0)) {
      err("capture.settleMs must be a non-negative number");
    }
  }

  if (plan.media) {
    if (plan.media.container !== "mp4") err('media.container must be "mp4"');
    if (plan.media.videoCodec !== "h264") err('media.videoCodec must be "h264"');
    if (!Number.isInteger(plan.media.fps) || plan.media.fps < 1 || plan.media.fps > 60) {
      err("media.fps must be an integer between 1 and 60");
    }
    if (!QUALITY_NAMES.includes(plan.media.quality)) {
      err(`media.quality must be one of ${QUALITY_NAMES.join(", ")}`);
    }
    if (!Number.isInteger(plan.media.crf) || plan.media.crf < 0 || plan.media.crf > 51) {
      err("media.crf must be an integer between 0 and 51");
    }
    if (typeof plan.media.preset !== "string" || !plan.media.preset) {
      err("media.preset must be a non-empty string");
    }
  }

  if (plan.auth) {
    if (!AUTH_MODES.includes(plan.auth.mode)) {
      err(`auth.mode must be one of ${AUTH_MODES.join(", ")}`);
    }
    if (plan.auth.mode === "storage-state" && !plan.auth.storageStateFile) {
      err("auth.storageStateFile is required when auth.mode is storage-state");
    }
    if (plan.auth.storageStateFile !== null && plan.auth.storageStateFile !== undefined) {
      if (typeof plan.auth.storageStateFile !== "string") {
        err("auth.storageStateFile must be a string path or null");
      } else if (/^(https?:)?\/\//.test(plan.auth.storageStateFile)) {
        err("auth.storageStateFile must be a local file path, not a URL");
      }
    }
  }

  if (plan.safety) {
    if (!Array.isArray(plan.safety.allowedHosts)) {
      err("safety.allowedHosts must be an array of hostnames");
    } else {
      for (const h of plan.safety.allowedHosts) {
        if (typeof h !== "string" || !h) err("safety.allowedHosts entries must be non-empty strings");
      }
    }
    if (typeof plan.safety.allowConsequential !== "boolean") {
      err("safety.allowConsequential must be a boolean");
    }
  }

  if (!isPlainObject(plan.output) || typeof plan.output.dir !== "string" || !plan.output.dir) {
    err("output.dir must be a non-empty string");
  }

  if (plan.app) {
    if (!APP_MODES.includes(plan.app.mode)) {
      err(`app.mode must be one of ${APP_MODES.join(", ")}`);
    }
    for (const key of ["root", "build", "serve", "url"]) {
      const value = plan.app[key];
      if (value !== null && value !== undefined && typeof value !== "string") {
        err(`app.${key} must be a string or null`);
      }
    }
    if (plan.app.url) {
      let u;
      try {
        u = new URL(plan.app.url);
      } catch {
        err(`app.url is not a valid URL: ${plan.app.url}`);
      }
      if (u && !/^https?:$/.test(u.protocol)) {
        err(`app.url must be http or https (got ${u.protocol})`);
      }
    }
    for (const key of ["buildTimeoutMs", "readyTimeoutMs"]) {
      const value = plan.app[key];
      if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
        err(`app.${key} must be a positive integer`);
      }
    }
    // A plan names npm scripts; it never carries a shell command. Commands
    // come from the operator's command line, so a plan stays data.
    for (const key of ["build", "serve"]) {
      const value = plan.app[key];
      if (typeof value === "string" && value.startsWith("sh:")) {
        err(`app.${key} must name an npm script, not a shell command`);
      }
    }
  }

  // ---- URL allow-list -------------------------------------------------
  const baseHost = (() => {
    try {
      return new URL(plan.baseUrl).hostname;
    } catch {
      return null;
    }
  })();
  const allowedHosts = new Set([
    ...(baseHost ? [baseHost] : []),
    ...(plan.safety?.allowedHosts ?? []),
  ]);

  // ---- steps ----------------------------------------------------------
  const seenIds = new Set();
  const normalizedSteps = [];
  if (steps) {
    steps.forEach((step, i) => {
      const at = `steps[${i}]`;
      if (!isPlainObject(step)) {
        err(`${at} must be an object`);
        return;
      }
      const action = step.action;
      if (typeof action !== "string") {
        err(`${at}.action is required`);
        return;
      }
      if (!STEP_ACTIONS.includes(action)) {
        const hint = /^(eval|evaluate|script|inject|execute|exec|run|func|function)/i.test(action)
          ? " — arbitrary code execution is not representable in a workflow plan"
          : `; supported actions: ${STEP_ACTIONS.join(", ")}`;
        err(`${at}.action "${action}" is not supported${hint}`);
        return;
      }
      // Guard against a `script`-ish extra key riding along with a valid action.
      for (const bad of ["evaluate", "script", "inject", "eval", "expression", "code", "fn", "function"]) {
        if (step[bad] !== undefined) {
          err(`${at}.${bad} is not allowed — workflow plans are data, never code`);
        }
      }
      // Reject unknown keys so typos cannot silently weaken a step.
      for (const k of Object.keys(step)) {
        if (!ALLOWED_STEP_KEYS.has(k)) {
          err(`${at}.${k} is not a recognized step field (allowed: ${[...ALLOWED_STEP_KEYS].sort().join(", ")})`);
        }
      }

      const id = step.id ?? `${i + 1}-${action}`;
      if (typeof id !== "string" || !id) err(`${at}.id must be a non-empty string when present`);
      if (seenIds.has(id)) err(`${at}.id "${id}" is duplicated`);
      seenIds.add(id);
      // Persist the resolved id on a copy so every downstream artifact (the
      // timeline, the validation report) can be correlated back to the plan
      // even when the author omitted ids. The caller's object is left alone.
      normalizedSteps.push(step.id === undefined ? { ...step, id } : step);

      if (step.title !== undefined && typeof step.title !== "string") err(`${at}.title must be a string`);
      if (step.caption !== undefined && typeof step.caption !== "string") err(`${at}.caption must be a string`);
      if (step.scene !== undefined && typeof step.scene !== "string") err(`${at}.scene must be a string`);
      if (step.timeoutMs !== undefined && (!Number.isInteger(step.timeoutMs) || step.timeoutMs < 0)) {
        err(`${at}.timeoutMs must be a non-negative integer`);
      }
      if (step.consequential !== undefined && typeof step.consequential !== "boolean") {
        err(`${at}.consequential must be a boolean`);
      }
      if (step.optional !== undefined && typeof step.optional !== "boolean") {
        err(`${at}.optional must be a boolean — use it only for steps whose failure does not affect the demonstration`);
      }

      // --- per-action requirements
      const needsTarget = ["click", "fill", "select", "check", "uncheck", "hover", "waitFor"];
      if (needsTarget.includes(action) && step.target === undefined) {
        err(`${at} (${action}) requires a target`);
      }
      if (step.target !== undefined) {
        validateTarget(step.target, (m) => err(`${at}.target: ${m}`));
      }
      if (step.assertOn !== undefined) {
        validateTarget(step.assertOn, (m) => err(`${at}.assertOn: ${m}`));
      }

      if (action === "goto") {
        if (step.path === undefined && step.url === undefined) {
          err(`${at} (goto) requires either "path" or "url"`);
        }
        if (step.path !== undefined && step.url !== undefined) {
          err(`${at} (goto) must use either "path" or "url", not both`);
        }
        if (step.url !== undefined) {
          if (typeof step.url !== "string") {
            err(`${at}.url must be a string`);
          } else {
            let u;
            try {
              u = new URL(step.url, plan.baseUrl);
            } catch {
              err(`${at}.url is not a valid URL: ${step.url}`);
            }
            if (u && !allowedHosts.has(u.hostname)) {
              err(
                `${at}.url host "${u.hostname}" is not allowed; permitted hosts: ${[...allowedHosts].join(", ")}. Add it to safety.allowedHosts if this is intended.`
              );
            }
          }
        }
      }
      if (action === "fill" && typeof step.value !== "string") {
        err(`${at} (fill) requires a string "value"`);
      }
      if (action === "fill" && typeof step.value === "string") {
        // A credential typed into a password-shaped field is the one way a
        // secret can end up inside an artifact (the plan, the storyboard, the
        // trace). Sign-in is covered by auth.mode instead, where the value is
        // never written down.
        const hint = credentialTargetHint(step.target, step.assertOn);
        if (hint) {
          err(
            `${at} (fill) puts a literal value into a credential field (${hint}); ` +
              `plans must not contain secrets. Use auth.mode "manual" or "storage-state" for sign-in, ` +
              `or fill a non-credential field for the demonstration.`
          );
        }
      }
      if (action === "select") {
        if (step.value === undefined && step.label === undefined && step.index === undefined) {
          err(`${at} (select) requires "value", "label" or "index"`);
        }
      }
      if (action === "press" && typeof step.key !== "string") {
        err(`${at} (press) requires a string "key"`);
      }
      if (action === "scroll") {
        if (step.target === undefined && step.to === undefined && step.y === undefined) {
          err(`${at} (scroll) requires a "target", "to" (top|bottom) or numeric "y"`);
        }
        if (step.to !== undefined && !["top", "bottom"].includes(step.to)) {
          err(`${at}.to must be "top" or "bottom"`);
        }
      }
      if (action === "caption" && typeof step.text !== "string") {
        err(`${at} (caption) requires a string "text"`);
      }
      if (action === "checkpoint" && typeof step.title !== "string") {
        err(`${at} (checkpoint) requires a string "title"`);
      }
      if (action === "pause") {
        if (!Number.isInteger(step.ms) || step.ms < 0) {
          err(`${at} (pause) requires a non-negative integer "ms"`);
        } else if (step.ms > 5000) {
          err(`${at} (pause).ms must be at most 5000 — prefer waiting for a visible state`);
        } else if (step.ms > 1500) {
          warn(`${at} (pause) waits ${step.ms}ms; prefer an assertion or waitFor on a real UI state`);
        }
      }

      // --- expectations
      if (step.expect !== undefined) {
        if (!isPlainObject(step.expect)) {
          err(`${at}.expect must be an object`);
        } else {
          for (const k of Object.keys(step.expect)) {
            if (!EXPECT_KEYS.includes(k)) {
              err(`${at}.expect.${k} is not a supported assertion (allowed: ${EXPECT_KEYS.join(", ")})`);
            }
          }
          const vs = step.expect.visible ?? step.expect.hidden;
          if (vs !== undefined && typeof vs !== "boolean") {
            err(`${at}.expect.visible/hidden must be a boolean`);
          }
          const needsTargetForAssert = ["visible", "hidden", "text", "notText", "value", "count", "state"];
          const usesTarget = needsTargetForAssert.some((k) => step.expect[k] !== undefined);
          if (usesTarget && step.target === undefined && step.assertOn === undefined) {
            err(`${at}.expect requires a "target" (the action target) or an explicit "assertOn" target`);
          }
          if (step.expect.state !== undefined && !["attached", "detached", "visible", "hidden"].includes(step.expect.state)) {
            err(`${at}.expect.state must be attached, detached, visible or hidden`);
          }
          if (step.expect.count !== undefined && (!Number.isInteger(step.expect.count) || step.expect.count < 0)) {
            err(`${at}.expect.count must be a non-negative integer`);
          }
        }
      }

      // --- consequential gate
      const reason = consequentialReason(step);
      const declared = step.consequential === true;
      if ((reason || declared) && plan.safety?.allowConsequential !== true) {
        err(
          `${at} looks externally consequential (${reason ?? "declared by the author"}) but safety.allowConsequential is false. ` +
            `Set safety.allowConsequential to true only after confirming with the user that this action is authorized.`
        );
      }
      if (reason && !declared) {
        warn(
          `${at} was not marked "consequential": true but ${reason}. Add the marker for reviewability.`
        );
      }
    });
  }

  // Every validated plan exposes steps with resolved ids, so the recorder, the
  // timeline and the validation report all agree on what each step is called.
  if (steps && plan) plan.steps = normalizedSteps;

  // ---- selector-quality summary
  // The plan is the record of which selector each step uses, so a plan that
  // leans on last-resort CSS selectors is worth flagging for review.
  if (steps && steps.length) {
    const tally = new Map();
    for (const step of steps) {
      const s = selectorStrategy(step.target);
      if (s) tally.set(s, (tally.get(s) ?? 0) + 1);
    }
    const cssCount = tally.get("css") ?? 0;
    if (cssCount > 0) {
      const named = SELECTOR_STRATEGIES.filter((s) => tally.has(s))
        .map((s) => `${s}=${tally.get(s)}`)
        .join(", ");
      const message =
        `${cssCount} step(s) select by raw CSS (${named}); CSS is the last resort because it breaks when markup changes. ` +
        `Prefer role+name, then label/placeholder, then testId, then visible text.`;
      if (cssCount === steps.length) warn(message);
      else {
        // Partial CSS use is surfaced without being alarmist, but only when it
        // is a meaningful share of the plan.
        if (cssCount * 2 > steps.length) warn(message);
      }
    }
  }

  // ---- secrets in plan text
  for (const finding of scanForSecrets(JSON.stringify(input))) {
    if (finding.kind === "credential-in-fill") {
      err(`${finding.where}: fill values must not contain credentials or secrets (${finding.label})`);
    } else {
      warn(`plan may contain a secret at ${finding.where}: ${finding.label}`);
    }
  }

  return { errors, warnings, plan, steps: steps ? normalizedSteps : [] };
}

/**
 * Detect a target that represents a credential field.
 *
 * Only *password-shaped* hints count. Usernames, email addresses and search
 * boxes are ordinary demo material and must keep working.
 *
 * @returns {string|null} a description of the hint, or null when the target is
 *   not credential-shaped.
 */
export function credentialTargetHint(...targets) {
  for (const target of targets) {
    if (!isPlainObject(target)) continue;
    const hints = [];
    for (const key of ["label", "placeholder", "testId", "name", "text", "css"]) {
      if (typeof target[key] === "string") hints.push(target[key]);
    }
    for (const hint of hints) {
      const match =
        /\b(pass(?:word|phrase)?|passwd|pwd|secret|token|api[-_ ]?key|otp|totp|mfa|one[-_ ]?time[-_ ]?(?:code|password)|2fa|pin|credential)\b/i.exec(
          hint
        );
      if (match) return `${match[1]} in ${describeSelector(target)}`;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Secret detection                                                    */
/* ------------------------------------------------------------------ */

const SECRET_PATTERNS = [
  { label: "private key block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { label: "AWS access key id", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { label: "Slack token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { label: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { label: "OpenAI-style key", re: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { label: "JWT", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { label: "HTTP authorization header", re: /\b(?:basic|bearer)\s+[A-Za-z0-9+/=_.-]{8,}/i },
  { label: "basic-auth URL", re: /[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/i },
  { label: "password assignment", re: /\b(password|passwd|pwd|secret|token|api[_-]?key|authorization)\s*[:=]\s*\S{6,}/i },
];

/**
 * Scan text for credential-shaped values. Returns findings with the location of
 * the match redacted so the scanner itself never echoes the secret.
 */
export function scanForSecrets(text, where = "content") {
  const findings = [];
  if (typeof text !== "string") return findings;
  for (const { label, re } of SECRET_PATTERNS) {
    const m = text.match(re);
    if (m) findings.push({ where, label, kind: "secret" });
  }
  return findings;
}

/**
 * Redact possible secrets so diagnostic output stays safe to print.
 * Replaces the secret portion only, keeping the surrounding text readable.
 */
export function redactSecrets(text) {
  if (typeof text !== "string") return text;
  let out = text;
  for (const { re } of SECRET_PATTERNS) {
    out = out.replace(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"), "[REDACTED]");
  }
  return out;
}

/**
 * The status name a failure with this exit code is recorded under.
 *
 * Shared by both backends so a run directory means the same thing whether it
 * was produced locally or by the Windows worker.
 */
export function failureStatus(code) {
  return code === EXIT.MISSING_DEPENDENCY
    ? "missing-dependency"
    : code === EXIT.ENVIRONMENT_FAILED
      ? "environment-failed"
      : code === EXIT.OUTPUT_CONFLICT
        ? "output-conflict"
        : code === EXIT.INVALID_PLAN
          ? "invalid-plan"
          : "failed";
}

/**
 * Write the artifacts that make a failed run directory explain itself.
 *
 * A run directory that exists must say why: an empty directory looks like a
 * silent no-op, collides with the next run of the same name, and leaves the
 * caller with nothing to read. Both backends write the same two files, so
 * "read `report.md` in the run directory" is true on either one.
 *
 * Reporting must never mask the failure, so write errors are swallowed.
 *
 * @returns {boolean} whether the directory now explains itself
 */
export function writeFailureReport(runDir, code, message, extra = {}) {
  const status = failureStatus(code);
  try {
    fs.mkdirSync(runDir, { recursive: true, mode: 0o755 });
    fs.writeFileSync(
      path.join(runDir, "manifest.json"),
      JSON.stringify(
        {
          skill: SKILL_NAME,
          schemaVersion: SCHEMA_VERSION,
          generatedAt: new Date().toISOString(),
          status,
          exitCode: code,
          error: redactSecrets(message),
          ...(extra.attempts ? { attempts: extra.attempts } : {}),
          ...(extra.backend ? { backend: extra.backend } : {}),
          ...(extra.worker ? { worker: extra.worker } : {}),
        },
        null,
        2
      ) + "\n",
      "utf8"
    );
    fs.writeFileSync(
      path.join(runDir, "report.md"),
      [
        `# Recording failed — ${status}`,
        "",
        `No video was produced. Nothing in this directory is a validated recording.`,
        "",
        "```text",
        redactSecrets(message),
        "```",
        "",
        ...(extra.setup ? ["## How to fix", "", "```bash", extra.setup, "```", ""] : []),
        ...(extra.errors?.length
          ? ["## Plan errors", "", ...extra.errors.map((e) => `- ${e}`), ""]
          : []),
        "## What to check",
        "",
        "- Is the application running and reachable at the configured `baseUrl`?",
        "- Does the plan reference UI that exists on the page being shown?",
        "- Is `node scripts/setup-check.mjs` reporting any missing component?",
        "",
      ].join("\n"),
      "utf8"
    );
    return true;
  } catch {
    return false;
  }
}

/** Scan a directory tree of text artifacts for secrets. */
export function scanArtifactsForSecrets(dir, { extensions = [".json", ".md", ".srt", ".txt", ".log"] } = {}) {
  const findings = [];
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules") continue;
        walk(p);
      } else if (extensions.includes(path.extname(e.name).toLowerCase())) {
        if (/(storage-?state|auth-?state|profile)/i.test(e.name)) {
          findings.push({ where: p, label: "auth-state-like filename in output", kind: "policy" });
          continue;
        }
        let text;
        try {
          text = fs.readFileSync(p, "utf8");
        } catch {
          continue;
        }
        findings.push(...scanForSecrets(text, path.relative(dir, p)).map((f) => ({ ...f, where: p })));
      }
    }
  };
  walk(dir);
  return findings;
}

/* ------------------------------------------------------------------ */
/* Output-directory safety                                             */
/* ------------------------------------------------------------------ */

/**
 * Resolve a run directory. Refuses to reuse an existing directory unless
 * `allowExisting` is set, so a previous recording is never silently destroyed.
 */
export function resolveRunDir(baseDir, { runName = null, now = new Date(), allowExisting = false } = {}) {
  const base = path.resolve(baseDir);
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z")
    .replace("T", "-");
  const name = runName ? `${sanitizeName(runName)}-${stamp}` : `run-${stamp}`;
  const dir = path.join(base, name);
  if (fs.existsSync(dir) && !allowExisting) {
    const err = new Error(
      `Output directory already exists: ${dir}\n` +
        `This skill never overwrites an existing recording. Pass --allow-existing to reuse it, ` +
        `or choose a different --out-dir / --run-name.`
    );
    err.code = "OUTPUT_EXISTS";
    throw err;
  }
  return dir;
}

export function sanitizeName(name) {
  return String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "run";
}

/** Reject characters that would be unsafe when a path is handed to another process. */
export function assertSafeExternalPath(p, label = "path") {
  if (typeof p !== "string" || !p) throw new Error(`${label} must be a non-empty string`);
  if (/[\u0000-\u001f]/.test(p)) throw new Error(`${label} contains control characters`);
  if (p.startsWith("-")) throw new Error(`${label} must not begin with "-"`);
  return p;
}

/** Ensure a storage-state file stays outside the public output directory. */
export function assertStateOutsideOutput(stateFile, outputDir) {
  if (stateFile === null || stateFile === undefined || stateFile === "") return null;
  if (typeof stateFile !== "string") {
    throw new Error("auth.storageStateFile must be a string path when set");
  }
  const a = path.resolve(stateFile);
  const b = path.resolve(outputDir);
  if (a === b || a.startsWith(b + path.sep)) {
    throw new Error(
      `Refusing to use an auth state file inside the output directory (${stateFile}). ` +
        `Auth state is a secret and must live outside the published artifacts.`
    );
  }
  return a;
}

/**
 * True when the module at `importMetaUrl` is the process entry point.
 *
 * CLI scripts use this so their `main()` does not run when the module is
 * imported by a test. Without it, importing a script for its exported helpers
 * would execute the whole command with the test runner's argv.
 */
export function isMainModule(importMetaUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return path.resolve(entry) === path.resolve(fileURLToPath(importMetaUrl));
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Misc                                                                */
/* ------------------------------------------------------------------ */

export function formatBytes(n) {
  if (!Number.isFinite(n)) return "unknown";
  const units = ["B", "KiB", "MiB", "GiB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function logJson(label, value) {
  process.stdout.write(`${label} ${JSON.stringify(value, null, 2)}\n`);
}

export function tmpRoot() {
  const base = process.env.RECORD_APP_SKILL_TMP || path.join(os.tmpdir(), SKILL_NAME);
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  return base;
}
