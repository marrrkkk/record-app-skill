#!/usr/bin/env node
/**
 * Record a validated workflow plan against a live application.
 *
 * Usage:
 *   node record-workflow.mjs --plan workflow.json [options]
 *
 * Options:
 *   --plan <file>            workflow plan (required)
 *   --out-dir <dir>          base output directory (default: plan.output.dir or .video)
 *   --run-dir <dir>          use this exact run directory (no timestamp)
 *   --run-name <name>        label used in the run directory name
 *   --allow-existing         reuse an existing run directory instead of failing
 *   --quality <name>         high | balanced | compact (default: plan media.quality)
 *   --fps <n>                capture and render frame rate (default: plan capture.fps)
 *   --backend <name>         auto | native | local-playwright | windows-native
 *   --headed                 run with a visible browser window
 *   --allow-consequential    authorize steps flagged as externally consequential
 *   --max-duration-ms <n>    hard bound on the recorded workflow (default 240000)
 *   --production             build the app and record against the production bundle
 *   --app-root <dir>         application root (default: the plan's directory)
 *   --build <script>         npm script that produces the production build
 *   --serve <script>         npm script that serves the built application
 *   --serve-url <url>        where the served application is reachable
 *   --json                   emit a machine-readable result on stdout
 *
 * Exit codes: 0 ok · 1 internal · 2 invalid plan · 3 output conflict ·
 *             4 missing dependency · 5 workflow failed · 6 environment failed
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  EXIT,
  QUALITY_PRESETS,
  QUALITY_NAMES,
  DEFAULT_OUTPUT_DIR,
  consequentialReason,
  validatePlan,
  readJsonFile,
  resolveRunDir,
  assertStateOutsideOutput,
  scanForSecrets,
  redactSecrets,
  formatBytes,
  writeFailureReport,
} from "./lib.mjs";
import { allocateNumberedDir } from "./output.mjs";
import {
  resolvePlaywright,
  resolveBackend,
  probeUrl,
  hostLabel,
  SKILL_DIR,
} from "./browser-env.mjs";
import { browserName } from "./host-env.mjs";
import {
  runCapture,
  buildSrt,
  buildStoryboard,
  launchOptionsFor,
  resolveLaunchChannel,
  contextOptionsFor,
  renderingSettingsFor,
} from "./capture.mjs";
import { resolveAppConfig, runProductionBuild, startPreviewServer } from "./app-server.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const args = {
    plan: null,
    outDir: null,
    runDir: null,
    runName: null,
    allowExisting: false,
    backend: null,
    headed: false,
    allowConsequential: false,
    maxDurationMs: 240000,
    quality: null,
    fps: null,
    json: false,
    internalBackend: null,
    production: false,
    appRoot: null,
    build: null,
    serve: null,
    serveUrl: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${a}`);
      return v;
    };
    switch (a) {
      case "--plan": args.plan = next(); break;
      case "--out-dir": args.outDir = next(); break;
      case "--run-dir": args.runDir = next(); break;
      case "--run-name": args.runName = next(); break;
      case "--allow-existing": args.allowExisting = true; break;
      case "--backend": args.backend = next(); break;
      case "--headed": args.headed = true; break;
      case "--allow-consequential": args.allowConsequential = true; break;
      case "--max-duration-ms": args.maxDurationMs = Number(next()); break;
      case "--quality": args.quality = next(); break;
      case "--fps": args.fps = Number(next()); break;
      case "--production": args.production = true; break;
      case "--app-root": args.appRoot = next(); break;
      case "--build": args.build = next(); break;
      case "--serve": args.serve = next(); break;
      case "--serve-url": args.serveUrl = next(); break;
      case "--json": args.json = true; break;
      case "--internal-backend": args.internalBackend = next(); break;
      case "-h":
      case "--help":
        args.help = true;
        break;
      default:
        throw new Error(`unknown option: ${a}`);
    }
  }
  return args;
}

const HELP = `Record a workflow plan against a live application.

  node record-workflow.mjs --plan <workflow.json> [options]

  --plan <file>            workflow plan (required)
  --out-dir <dir>          base output directory (default: plan.output.dir or .video)
  --run-dir <dir>          use this exact run directory instead of a timestamped one
  --run-name <name>        label used in the run directory name
  --allow-existing         reuse an existing run directory instead of failing
  --quality <name>         high | balanced | compact
  --fps <n>                capture and render frame rate (1-60)
  --backend <name>         auto | native | local-playwright | windows-native
  --headed                 run with a visible browser window
  --allow-consequential    authorize steps flagged as externally consequential
  --max-duration-ms <n>    hard bound on the recorded workflow (default 240000)
  --production             build the app and record against the production bundle
  --app-root <dir>         application root (default: the plan's directory)
  --build <script>         npm script that produces the production build
  --serve <script>         npm script that serves the built application
  --serve-url <url>        where the served application is reachable
  --json                   emit a machine-readable result on stdout
`;

function fail(code, message, extra = {}) {
  const payload = { ok: false, code, error: message, ...extra };
  process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
  process.exit(code);
}

/**
 * Record a failure that happened before recording started.
 *
 * A run directory that exists must explain itself: an empty directory looks
 * like a silent no-op, and it would also collide with the next run of the same
 * name. Writing the reason down keeps the failure auditable and keeps the
 * "never silently overwrite" rule meaningful.
 */
function failInRunDir(runDir, code, message, extra = {}) {
  // One implementation of "a run directory that explains itself", shared with
  // the Windows worker path so both backends produce the same two files.
  writeFailureReport(runDir, code, message, extra);
  // The caller needs to know where the explanation was written.
  fail(code, message, { runDir, ...extra });
}

/* ------------------------------------------------------------------ */
/* Artifact writing                                                    */
/* ------------------------------------------------------------------ */

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}

/**
 * What was built and how it was served.
 *
 * The preparation happens once, in the process that owns the application's
 * source. The recording process may be a different one (the Windows worker),
 * so the evidence is written next to the recording and read back from there.
 */
function readAppEvidence(runDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(runDir, "app.json"), "utf8"));
  } catch {
    return null;
  }
}

function buildManifest({ plan, backend, runDir, files, result, startedAt, versions, authorizedOnCommandLine, app, launchWarnings, internalBackend, host }) {
  const channel = resolveLaunchChannel(plan, { resolved: backend.channel });
  const browser = backend.browser ?? {
    id: channel,
    name: channel ? browserName(channel) : null,
    source: channel && channel !== "chromium" ? "system-installed" : "playwright-bundled",
    version: versions.browserVersion ?? null,
  };
  return {
    skill: "record-app-skill",
    schemaVersion: plan.schemaVersion,
    generatedAt: new Date().toISOString(),
    startedAt: startedAt.toISOString(),
    workflow: {
      title: plan.title,
      description: plan.description ?? null,
      baseUrl: plan.baseUrl,
      startRoute: plan.startRoute,
      stepCount: plan.steps.length,
    },
    backend: {
      requested: backend.requested,
      // The Windows worker re-enters this script on the Windows side, where
      // the local Playwright backend *is* the native browser. The truth is the
      // backend that was asked for, not the name the helper uses for it.
      resolved: internalBackend ?? backend.backend,
      strategy: internalBackend === "windows-native" ? "windows-worker" : (backend.strategy ?? null),
      reason: internalBackend
        ? `recording on the Windows side with native ${browserName(channel)}`
        : backend.reason,
      // `channel` is the browser actually launched; the plan's request is kept
      // separately so a forced channel is never misreported.
      channel,
      channelRequested: plan.browser.channel,
      // The browser that really drew the frames, and where it came from.
      // "system-default" is the user's registered default; "playwright-bundled"
      // is the portable build and is never called the user's own browser.
      browser: {
        id: browser.id,
        name: browser.name,
        source: browser.source,
        version: browser.version ?? versions.browserVersion ?? null,
      },
      headless: plan.browser.headless,
    },
    environment: {
      // The operating system whose browser drew the frames. Inside WSL this is
      // "win32" while the agent itself runs on Linux.
      platform: process.platform,
      // Where the agent process ran, which is not always the rendering host.
      // The Windows worker learns it from the side that delegated the run.
      shellPlatform: process.env.RECORD_APP_SKILL_SHELL_PLATFORM ?? host?.shellPlatform ?? process.platform,
      hostKind: host?.kind ?? null,
      hostLabel: hostLabel(host),
      arch: process.arch,
      node: process.version,
      osRelease: safeOsRelease(),
      playwright: versions.playwright,
      browserVersion: versions.browserVersion ?? null,
      display: process.env.DISPLAY ? "display-server" : "headless-capable",
    },
    // What the recording was actually made against. "production" means the
    // application was built and served the way it ships, which is what keeps
    // a demo free of development-server lag.
    app: app ?? null,
    launchWarnings: launchWarnings ?? [],
    capture: {
      fps: plan.capture.fps,
      viewport: plan.browser.viewport,
      deviceScaleFactor: plan.browser.deviceScaleFactor,
      // The rendering settings that were in force, so the video can be judged
      // against the environment it was made in.
      rendering: renderingSettingsFor(plan),
      cursor: plan.capture.cursor,
      captions: plan.capture.captions,
      chapters: plan.capture.chapters,
      settleMs: plan.capture.settleMs,
      typingDelayMs: plan.capture.typingDelayMs,
      smoothScroll: plan.capture.smoothScroll,
      scrollDurationMs: plan.capture.scrollDurationMs,
      recordedDurationMs: result?.captureDurationMs ?? null,
    },
    media: plan.media,
    // An audit trail for the safety rules: what the plan asked for, and what
    // the caller actually authorized on the command line. A grader (and a
    // reviewer) can then tell an authorized destructive run from an
    // unauthorized one without trusting the video.
    safety: {
      allowConsequential: plan.safety.allowConsequential === true,
      authorizedOnCommandLine: authorizedOnCommandLine === true,
      allowedHosts: plan.safety.allowedHosts ?? [],
      authMode: plan.auth.mode,
      storageStateFile: plan.auth.storageStateFile ?? null,
    },
    status: result?.failure ? "failed" : "recorded",
    files,
  };
}

function safeOsRelease() {
  try {
    return `${osType()} ${fs.readFileSync("/proc/version", "utf8").trim().split(" ").slice(0, 3).join(" ")}`;
  } catch {
    return osType();
  }
}
function osType() {
  return `${process.platform}/${process.arch}`;
}

/* ------------------------------------------------------------------ */
/* Windows delegation                                                  */
/* ------------------------------------------------------------------ */

async function delegateToWindows({ plan, runDir, args, backend, planFile }) {
  const { runWindowsRecording } = await import("./win-exec.mjs");
  return runWindowsRecording({
    plan,
    runDirLinux: runDir,
    planFile: planFile ?? args.plan,
    maxDurationMs: args.maxDurationMs,
    allowConsequential: args.allowConsequential,
    headed: args.headed,
    quality: args.quality,
    fps: args.fps,
    backend,
    channel: backend.channel,
    json: args.json === true,
  });
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n\n${HELP}`);
    process.exit(EXIT.INVALID_PLAN);
  }
  if (args.help) {
    process.stdout.write(HELP);
    process.exit(EXIT.OK);
  }
  if (!args.plan) {
    process.stderr.write(`--plan is required\n\n${HELP}`);
    process.exit(EXIT.INVALID_PLAN);
  }
  if (!Number.isFinite(args.maxDurationMs) || args.maxDurationMs <= 0) {
    process.stderr.write(`--max-duration-ms must be a positive number\n`);
    process.exit(EXIT.INVALID_PLAN);
  }

  const startedAt = new Date();

  // ---- load + validate ------------------------------------------------
  let planInput;
  try {
    planInput = readJsonFile(path.resolve(args.plan));
  } catch (err) {
    fail(EXIT.INVALID_PLAN, `could not read plan: ${err.message}`);
  }

  const { errors, warnings, plan } = validatePlan(planInput);
  if (errors.length) {
    process.stderr.write("Plan validation failed:\n");
    for (const e of errors) process.stderr.write(`  - ${redactSecrets(e)}\n`);
    fail(EXIT.INVALID_PLAN, `plan has ${errors.length} validation error(s)`, { errors: errors.map(redactSecrets) });
  }

  // CLI quality/fps win over the plan. They are validated here rather than
  // during schema validation because they describe this run, not the plan.
  if (args.fps !== null) {
    if (!Number.isInteger(args.fps) || args.fps < 1 || args.fps > 60) {
      fail(EXIT.INVALID_PLAN, "--fps must be an integer between 1 and 60");
    }
    plan.capture.fps = args.fps;
    plan.media.fps = args.fps;
  }
  if (args.quality !== null) {
    if (!QUALITY_NAMES.includes(args.quality)) {
      fail(EXIT.INVALID_PLAN, `--quality must be one of ${QUALITY_NAMES.join(", ")}`);
    }
    plan.media.quality = args.quality;
    plan.media.crf = QUALITY_PRESETS[args.quality].crf;
    plan.media.preset = QUALITY_PRESETS[args.quality].preset;
  }

  if (args.allowConsequential) {
    plan.safety.allowConsequential = true;
  }

  // Two-key authorization: the plan declares that it contains a consequential
  // step, and the person running the recording authorizes it on the command
  // line. A plan written by an agent must not be able to authorize itself, so
  // the plan field alone is not enough.
  const consequentialSteps = plan.steps.filter((s) => s.consequential === true || consequentialReason(s));
  if (consequentialSteps.length && !args.allowConsequential) {
    fail(
      EXIT.INVALID_PLAN,
      `${consequentialSteps.length} step(s) are externally consequential ` +
        `(${consequentialSteps.map((s) => s.id).join(", ")}) but this run did not authorize them.\n` +
        `Confirm with the user that these actions are acceptable, then re-run with --allow-consequential.`,
      { steps: consequentialSteps.map((s) => s.id) }
    );
  }
  if (args.headed) plan.browser.headless = false;
  if (args.backend) plan.browser.backend = args.backend;
  // When invoked as the Windows worker's child, the backend is already decided
  // by the parent. Record it accurately instead of re-deriving it.
  if (args.internalBackend) plan.browser.backend = args.internalBackend;
  plan.maxDurationMs = args.maxDurationMs;

  // Auth-state files are secrets: never inside the published artifacts.
  const outputBase = path.resolve(args.outDir ?? plan.output.dir ?? DEFAULT_OUTPUT_DIR);
  if (plan.auth.storageStateFile) {
    try {
      assertStateOutsideOutput(plan.auth.storageStateFile, outputBase);
    } catch (err) {
      fail(EXIT.INVALID_PLAN, err.message);
    }
    if (!fs.existsSync(plan.auth.storageStateFile)) {
      fail(EXIT.INVALID_PLAN, `auth.storageStateFile does not exist: ${plan.auth.storageStateFile}`);
    }
  }

  // ---- run directory --------------------------------------------------
  let runDir;
  if (args.runDir) {
    // An exact directory was requested (used by the Windows delegation path so
    // both sides agree on one path). It is never cleared: artifacts already in
    // it are left alone.
    runDir = path.resolve(args.runDir);
  } else if (outputBase === path.resolve(process.cwd(), DEFAULT_OUTPUT_DIR)) {
    // The default delivery layout: evidence lives in a numbered hidden folder,
    // `.video/.work/001`, while `.video/001` receives only the finished video.
    runDir = allocateNumberedDir(path.join(outputBase, ".work")).dir;
  } else {
    try {
      runDir = resolveRunDir(outputBase, { runName: args.runName ?? plan.title, allowExisting: args.allowExisting });
    } catch (err) {
      if (err.code === "OUTPUT_EXISTS") fail(EXIT.OUTPUT_CONFLICT, err.message);
      throw err;
    }
  }
  fs.mkdirSync(runDir, { recursive: true, mode: 0o755 });

  // ---- backend --------------------------------------------------------
  // The rendering environment is decided before anything expensive happens: a
  // run that cannot use the right browser should not build the application
  // first, and it must never quietly record in a different one.
  const backend = resolveBackend(plan.browser.backend, { channel: plan.browser.channel });
  if (backend.unavailable) {
    const explicit = plan.browser.backend !== "auto";
    const lines = [
      explicit
        ? `the requested browser backend is unavailable: ${backend.reason}`
        : `no native browser is available for the default backend: ${backend.reason}`,
    ];
    if (backend.requirements?.length) {
      lines.push("", "What it needs:", ...backend.requirements.map((r) => `  - ${r}`));
    }
    if (backend.alternatives?.length) {
      lines.push("", "What you can do instead:", ...backend.alternatives.map((a) => `  - ${a}`));
    }
    failInRunDir(runDir, EXIT.MISSING_DEPENDENCY, lines.join("\n"), {
      setup: `Run: node scripts/setup-check.mjs --backend ${plan.browser.backend}`,
      backend: { requested: backend.requested, resolved: backend.backend, reason: backend.reason },
    });
  }

  // ---- production build + server --------------------------------------
  // A development server is the slowest thing in a demo: hot-reload
  // machinery, unminified bundles and dev-only warnings all show up on
  // screen. When the plan or the command line asks for it, the application is
  // built the way it ships and served from the built output instead.
  const appConfig = resolveAppConfig({
    plan,
    planDir: path.dirname(path.resolve(args.plan)),
    cli: {
      production: args.production,
      appRoot: args.appRoot,
      build: args.build,
      serve: args.serve,
      serveUrl: args.serveUrl,
    },
  });
  if (appConfig.error) {
    failInRunDir(runDir, EXIT.INVALID_PLAN, appConfig.error, {
      appRoot: appConfig.root,
      setup: "See references/production-builds.md",
    });
  }

  const appEvidence = {
    mode: appConfig.mode,
    root: appConfig.root,
    build: null,
    serve: null,
  };
  let server = null;
  try {
    if (appConfig.enabled && appConfig.build) {
      const build = await runProductionBuild(appConfig, { log: (m) => process.stderr.write(`${m}\n`) });
      appEvidence.build = {
        command: build.command,
        script: appConfig.build.kind === "npm-script" ? appConfig.build.value : null,
        durationMs: build.durationMs,
        ok: build.ok,
      };
      if (!build.ok) {
        const logFile = path.join(runDir, "build.log");
        fs.writeFileSync(logFile, (build.output ?? []).join("\n") + "\n", "utf8");
        failInRunDir(
          runDir,
          EXIT.ENVIRONMENT_FAILED,
          `the production build failed: ${build.error}\n` +
            `Build log: ${logFile}`,
          { build: appEvidence.build }
        );
      }
    }
    if (appConfig.enabled && appConfig.serve) {
      server = await startPreviewServer(appConfig, { log: (m) => process.stderr.write(`${m}\n`) });
      appEvidence.serve = {
        command: server.command ?? null,
        script: appConfig.serve.kind === "npm-script" ? appConfig.serve.value : null,
        url: server.url ?? null,
        ok: server.ok,
      };
      if (!server.ok) {
        const logFile = path.join(runDir, "server.log");
        fs.writeFileSync(logFile, (server.output ?? []).join("\n") + "\n", "utf8");
        failInRunDir(
          runDir,
          EXIT.ENVIRONMENT_FAILED,
          `the production server did not start: ${server.error}\n` +
            `Server log: ${logFile}`,
          { serve: appEvidence.serve }
        );
      }
      // The recorded origin is the one the server actually answers on.
      plan.baseUrl = server.url;
    }
  } catch (err) {
    if (server?.stop) await server.stop().catch(() => {});
    throw err;
  }

  // The evidence of what was recorded against travels with the recording, so
  // the process that captures the frames can report it too. An existing file
  // wins: when the application was prepared elsewhere, that record is the
  // accurate one.
  if (!readAppEvidence(runDir)) {
    writeJson(path.join(runDir, "app.json"), appEvidence);
  }

  // ---- backend --------------------------------------------------------
  // Windows-native: hand off to the Windows-side worker, which re-enters this
  // same script under Windows Node so there is one executor, not two.
  if (backend.backend === "windows-native" && args.internalBackend !== "windows-native") {
    // The worker reads the plan from disk, so the resolved plan — with the
    // production server's URL in it — is written out and handed over. The
    // `app` section is left out on purpose: the application is already built
    // and serving, and the worker must not build it a second time.
    const recorderPlanPath = path.join(runDir, "plan.for-recorder.json");
    const { app: _prepared, ...planForWorker } = plan;
    writeJson(recorderPlanPath, planForWorker);
    let delegated;
    try {
      delegated = await delegateToWindows({ plan, runDir, args, backend, planFile: recorderPlanPath });
    } finally {
      if (server?.stop) await server.stop().catch(() => {});
    }
    if (args.json) {
      process.stdout.write(JSON.stringify(delegated, null, 2) + "\n");
    } else if (delegated.code !== EXIT.OK && delegated.status !== "workflow-failed") {
      // The local path writes a machine-readable payload for a failure that
      // happened before recording, with or without --json, so a caller can
      // always parse the reason. When the Windows side did record and a step
      // failed, its own human summary was forwarded instead.
      process.stdout.write(
        JSON.stringify(
          {
            ok: false,
            code: delegated.code,
            error: delegated.failure?.message ?? `the Windows worker failed (exit code ${delegated.code})`,
            runDir: delegated.runDir,
            status: delegated.status,
            backend: delegated.backend,
            failure: delegated.failure,
          },
          null,
          2
        ) + "\n"
      );
    }
    process.exit(delegated.code);
  }

  // ---- dependency + environment preflight -----------------------------
  let pw;
  try {
    pw = resolvePlaywright();
  } catch (err) {
    if (server?.stop) await server.stop().catch(() => {});
    failInRunDir(runDir, EXIT.MISSING_DEPENDENCY, err.message, {
      setup: path.join(SKILL_DIR, "scripts", "setup-check.mjs"),
    });
  }

  for (const w of [...warnings, ...backend.warnings]) {
    process.stderr.write(`warning: ${w}\n`);
  }

  const reach = await probeUrl(plan.baseUrl);
  if (!reach.ok) {
    if (server?.stop) await server.stop().catch(() => {});
    failInRunDir(
      runDir,
      EXIT.ENVIRONMENT_FAILED,
      `the application at ${plan.baseUrl} is not reachable.\n` +
        reach.attempts.map((a) => `  tried ${a.url}: ${a.status ?? a.error}`).join("\n") +
        `\nStart the application first, then re-run. If it listens on another host or port, update baseUrl.`,
      { attempts: reach.attempts }
    );
  }
  if (reach.resolvedUrl && reach.resolvedUrl.replace(/\/+$/, "") !== plan.baseUrl.replace(/\/+$/, "")) {
    process.stderr.write(
      `note: ${plan.baseUrl} resolved to ${reach.resolvedUrl}; recording against the reachable address\n`
    );
    plan.baseUrl = reach.resolvedUrl;
  } else if (reach.resolvedUrl) {
    plan.baseUrl = reach.resolvedUrl;
  }

  // The application this recording was made against, when another process
  // prepared it (the Windows worker is handed a ready-to-serve application).
  const preparedApp = readAppEvidence(runDir);
  if (preparedApp?.mode === "production") {
    plan.app = {
      ...plan.app,
      mode: "production",
      root: preparedApp.root ?? null,
      build: preparedApp.build?.script ?? null,
      serve: preparedApp.serve?.script ?? null,
      url: preparedApp.serve?.url ?? null,
    };
  }
  // The resolved plan is what actually ran: the URL that answered, the
  // defaults that applied, the backend that was chosen. It is written as
  // `workflow.json` at the end of the run, next to the rest of the evidence.

  // ---- launch ---------------------------------------------------------
  const rawName = "raw-recording.webm";
  const rawPath = path.join(runDir, rawName);
  const browserType = pw.playwright.chromium;
  let browser;
  let context;
  let result = null;
  let launchError = null;
  let browserVersion = null;
  const launchWarnings = [];

  try {
    // The user's own browser is the default. If it cannot be launched, the
    // bundled Chromium is used instead — and said so, because its fonts differ.
    try {
      browser = await browserType.launch(launchOptionsFor(plan, { resolved: backend.channel }));
    } catch (err) {
      const channel = resolveLaunchChannel(plan, { resolved: backend.channel });
      if (plan.browser.channel !== "auto" || channel === "chromium") throw err;
      process.stderr.write(
        `warning: ${channel} could not be launched (${err.message}); using Playwright's bundled Chromium instead — ` +
          `fonts may differ from your own browser\n`
      );
      launchWarnings.push(`system ${channel} could not be launched; bundled Chromium was used instead`);
      browser = await browserType.launch({ headless: plan.browser.headless });
    }
    browserVersion = browser.version();

    const contextOptions = contextOptionsFor(plan);
    if (plan.auth.storageStateFile) {
      const stateFile = path.resolve(plan.auth.storageStateFile);
      const stateSecrets = scanForSecrets(fs.readFileSync(stateFile, "utf8"), "auth state");
      if (stateSecrets.length) {
        // Expected: a storage-state file legitimately contains cookies/tokens.
        // It must never be copied into the artifacts, which is enforced elsewhere.
      }
      contextOptions.storageState = stateFile;
    }
    context = await browser.newContext(contextOptions);
    const page = await context.newPage();
    page.setDefaultTimeout(plan.browser.timeoutMs);
    page.setDefaultNavigationTimeout(Math.max(plan.browser.timeoutMs, 30000));

    // Manual sign-in happens *before* recording starts, so credentials are
    // never captured. Requires an interactive terminal.
    if (plan.auth.mode === "manual") {
      if (!process.stdin.isTTY) {
        failInRunDir(
          runDir,
          EXIT.INVALID_PLAN,
          'auth.mode is "manual" but stdin is not a terminal. ' +
            'Use auth.mode "storage-state" with a saved state file for non-interactive runs.'
        );
      }
      await page.goto(new URL(plan.startRoute, plan.baseUrl).toString(), { waitUntil: "domcontentloaded" });
      process.stderr.write(
        `\nSign in to ${plan.baseUrl} in the browser window that just opened.\n` +
          `Recording starts only after you press Enter here, so no credentials are captured.\n` +
          `Press Enter when you are signed in and on the right page... `
      );
      await waitForEnter();
      process.stderr.write("Continuing.\n");
    }

    // Start from a known route so the recording opens on real content.
    await page.goto(new URL(plan.startRoute, plan.baseUrl).toString(), { waitUntil: "domcontentloaded" });
    await page
      .waitForLoadState("load", { timeout: Math.min(plan.browser.timeoutMs, 8000) })
      .catch(() => {});

    result = await runCapture({
      page,
      plan,
      capture: page.screencast,
      rawPath,
      log: (m) => process.stderr.write(`${m}\n`),
    });

    // Close the context so the screencast file is flushed and complete.
    await context.close().catch(() => {});
    context = null;
  } catch (err) {
    launchError = redactSecrets(err?.message ?? String(err));
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    // The production server this run started is stopped here, so a finished
    // demo never leaves a process behind.
    if (server?.stop) await server.stop().catch(() => {});
  }

  if (launchError && !result) {
    failInRunDir(runDir, EXIT.INTERNAL, `recording failed: ${launchError}`);
  }

  // ---- artifacts ------------------------------------------------------
  const rawExists = fs.existsSync(rawPath) && fs.statSync(rawPath).size > 0;
  const hasCaptionWindows = result.steps.some((s) => s.caption && s.captionWindow);
  const files = {
    rawRecording: rawExists ? rawName : null,
    workflow: "workflow.json",
    app: fs.existsSync(path.join(runDir, "app.json")) ? "app.json" : null,
    timeline: "timeline.json",
    storyboard: "storyboard.md",
    captions: hasCaptionWindows ? "captions.srt" : null,
    manifest: "manifest.json",
    report: "report.md",
  };

  const timeline = {
    captureDurationMs: result.captureDurationMs,
    // The setup before the first frame and the encoder flush after the last
    // one. Neither is in the video; both are worth knowing about when a run
    // is slower than expected.
    captureSetupMs: result.captureStartedAtMs ?? 0,
    captureTeardownMs: result.captureTeardownMs ?? 0,
    recordedAt: startedAt.toISOString(),
    fps: plan.capture.fps,
    viewport: plan.browser.viewport,
    status: result.failure ? "failed" : "recorded",
    steps: result.steps,
    scenes: result.scenes,
    warnings: result.warnings,
  };

  writeJson(path.join(runDir, "workflow.json"), plan);
  writeJson(path.join(runDir, "timeline.json"), timeline);
  fs.writeFileSync(path.join(runDir, "storyboard.md"), buildStoryboard({ plan, timeline }), "utf8");
  const srt = buildSrt(result.steps);
  if (srt) fs.writeFileSync(path.join(runDir, "captions.srt"), srt, "utf8");

  const manifest = buildManifest({
    plan,
    backend,
    runDir,
    files,
    result,
    startedAt,
    versions: { playwright: pw.version, browserVersion },
    app: readAppEvidence(runDir) ?? appEvidence,
    launchWarnings,
    internalBackend: args.internalBackend,
    host: backend.host,
    // The two-key rule: the plan field and the flag are both recorded, so an
    // audit can tell what was declared from what was authorized.
    authorizedOnCommandLine: args.allowConsequential === true,
  });
  writeJson(path.join(runDir, "manifest.json"), manifest);

  // Interim report; validate-video.mjs rewrites this with the consolidated
  // final status once the media has been rendered and checked.
  fs.writeFileSync(
    path.join(runDir, "report.md"),
    buildReport({ plan, timeline, manifest, runDir, files, stage: "recording", extra: result.warnings }),
    "utf8"
  );

  const assertionFailures = result.steps.filter((s) => s.status === "failed" || s.status === "failed-optional");
  const launchedChannel = resolveLaunchChannel(plan, { resolved: backend.channel });
  // The Windows worker re-enters this script on the Windows side, where the
  // local Playwright backend *is* the native browser. The name the user is
  // told must be the backend that was asked for, not the helper's name.
  const resolvedBackend = args.internalBackend ?? backend.backend;
  const summary = {
    ok: !result.failure,
    code: result.failure ? EXIT.WORKFLOW_FAILED : EXIT.OK,
    runDir,
    status: result.failure ? "workflow-failed" : "recorded",
    backend: resolvedBackend,
    browser: browserName(launchedChannel),
    browserSource: backend.browser?.source ?? null,
    host: hostLabel(backend.host),
    quality: plan.media.quality,
    fps: plan.capture.fps,
    width: plan.browser.viewport.width,
    height: plan.browser.viewport.height,
    rawRecording: files.rawRecording ? path.join(runDir, rawName) : null,
    rawBytes: rawExists ? fs.statSync(rawPath).size : 0,
    rawBytesHuman: rawExists ? formatBytes(fs.statSync(rawPath).size) : null,
    durationMs: result.captureDurationMs,
    steps: result.steps.length,
    stepsFailed: assertionFailures.length,
    failure: result.failure ?? null,
    warnings: result.warnings,
    app: appEvidence,
    files: Object.fromEntries(Object.entries(files).filter(([, v]) => v).map(([k, v]) => [k, path.join(runDir, v)])),
  };

  if (args.json) {
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  } else {
    process.stdout.write(
      `\n${summary.ok ? "Recorded" : "Recording FAILED"} — ${plan.title}\n` +
        `  run dir    : ${runDir}\n` +
        `  backend    : ${resolvedBackend} (${backend.reason})\n` +
        `  browser    : ${browserName(launchedChannel)} on ${summary.host}\n` +
        `  app        : ${appEvidence.mode === "production" ? `production build (${appEvidence.build?.command ?? "?"})` : "already-running application"}\n` +
        `  quality    : ${plan.media.quality} (CRF ${plan.media.crf}, preset ${plan.media.preset}, ${plan.capture.fps} fps)\n` +
        `  raw video  : ${summary.rawRecording ?? "not produced"}${summary.rawBytesHuman ? ` (${summary.rawBytesHuman})` : ""}\n` +
        `  duration   : ${(result.captureDurationMs / 1000).toFixed(1)}s\n` +
        `  steps      : ${result.steps.length} (${assertionFailures.length} failed)\n` +
        (result.failure ? `  failed at  : ${result.failure.stepId} — ${result.failure.message}\n` : "") +
        (result.warnings.length ? `  warnings   : ${result.warnings.length}\n` : "") +
        `\nNext: node render-video.mjs --run-dir "${runDir}"\n`
    );
  }

  process.exit(summary.code);
}

function waitForEnter() {
  return new Promise((resolve) => {
    const onData = () => {
      process.stdin.pause();
      process.stdin.off("data", onData);
      resolve();
    };
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

function buildReport({ plan, timeline, manifest, runDir, files, stage, extra = [] }) {
  const L = [];
  L.push(`# ${plan.title}`);
  L.push("");
  L.push(`**Stage:** ${stage}`);
  L.push("");
  if (plan.description) {
    L.push(plan.description);
    L.push("");
  }
  L.push(`- Application: \`${plan.baseUrl}\``);
  L.push(`- Backend: \`${manifest.backend.resolved}\` (${manifest.backend.reason})`);
  L.push(`- Browser: ${manifest.backend.browser?.name ?? manifest.backend.channel} (${manifest.backend.browser?.source ?? "unknown source"}${manifest.backend.browser?.version ? `, version ${manifest.backend.browser.version}` : ""})`);
  L.push(`- Rendering host: ${manifest.environment?.hostLabel ?? manifest.environment?.platform ?? "unknown"}`);
  if (manifest.app) {
    L.push(
      `- Build: ${manifest.app.mode === "production" ? `\`${manifest.app.build?.command ?? "?"}\` then \`${manifest.app.serve?.command ?? "?"}\`` : "recording against the already-running application"}`
    );
  }
  L.push(`- Status: **${timeline.status}**`);
  L.push(`- Duration: ${(timeline.captureDurationMs / 1000).toFixed(1)}s`);
  L.push(`- Steps: ${timeline.steps.length}`);
  L.push("");
  if (extra.length) {
    L.push("## Warnings");
    L.push("");
    for (const w of extra) L.push(`- ${w}`);
    L.push("");
  }
  L.push("## Files");
  L.push("");
  for (const [k, v] of Object.entries(files)) {
    if (v) L.push(`- \`${v}\` — ${k}`);
  }
  L.push("");
  L.push(`Run directory: \`${runDir}\``);
  L.push("");
  return L.join("\n");
}

main().catch((err) => {
  fail(EXIT.INTERNAL, redactSecrets(err?.stack ?? String(err)));
});
