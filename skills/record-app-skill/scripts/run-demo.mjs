#!/usr/bin/env node
/**
 * One-command demonstration delivery.
 *
 *   node run-demo.mjs --plan plan.json [--quality high] [--fps 60]
 *
 * This is the path an agent should use. It:
 *
 *   1. validates the plan before creating any output directory,
 *   2. allocates the next pair under `.video`: `<n>/` for the video and
 *      `.video/.work/<n>/` for the evidence,
 *   3. records, renders, builds the contact sheet and validates,
 *   4. copies only the finished `demo.mp4` into the numbered folder,
 *   5. writes `delivery.json` next to the evidence and prints one consistent
 *      handoff block containing the video URL.
 *
 * A failed workflow never puts a video in the numbered folder.
 *
 * Exit codes: 0 delivered (validated or partial) · 1 internal ·
 *             2 invalid plan or arguments · 4 missing dependency ·
 *             5 workflow or verification failed · 6 recording failed.
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  EXIT,
  DEFAULT_FPS,
  QUALITY_NAMES,
  consequentialReason,
  failureStatus,
  formatBytes,
  readJsonFile,
  redactSecrets,
  validatePlan,
} from "./lib.mjs";
import {
  allocateNumberedPair,
  appendDeliveryReport,
  finalizeDelivery,
  formatDeliveryBlock,
  resolveOutputBase,
  resolveQuality,
  resolveRenderSettings,
  writeDeliveryRecord,
} from "./output.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = {
    plan: null,
    outDir: null,
    quality: null,
    fps: null,
    backend: null,
    headed: false,
    allowConsequential: false,
    maxDurationMs: 240000,
    skipDecode: false,
    json: false,
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
      case "--quality": args.quality = next(); break;
      case "--fps": args.fps = Number(next()); break;
      case "--backend": args.backend = next(); break;
      case "--headed": args.headed = true; break;
      case "--allow-consequential": args.allowConsequential = true; break;
      case "--max-duration-ms": args.maxDurationMs = Number(next()); break;
      case "--skip-decode": args.skipDecode = true; break;
      case "--production": args.production = true; break;
      case "--app-root": args.appRoot = next(); break;
      case "--build": args.build = next(); break;
      case "--serve": args.serve = next(); break;
      case "--serve-url": args.serveUrl = next(); break;
      case "--json": args.json = true; break;
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

const HELP = `Record, render, validate and deliver one workflow demonstration.

  node run-demo.mjs --plan <workflow.json> [options]

  --plan <file>            workflow plan (required)
  --quality <name>         high | balanced | compact (default: plan media.quality or high)
  --fps <n>                capture and render frame rate (default: plan capture.fps or ${DEFAULT_FPS})
  --out-dir <dir>          output base (default: .video in the current directory)
  --backend <name>         auto | native | local-playwright | windows-native
  --headed                 run with a visible browser window
  --allow-consequential    authorize steps flagged as externally consequential
  --max-duration-ms <n>    hard bound on the recording (default 240000)
  --production             build the app and record against the production bundle
  --app-root <dir>         application root (default: the plan's directory)
  --build <script>         npm script that produces the production build
  --serve <script>         npm script that serves the built application
  --serve-url <url>        where the served application is reachable
  --skip-decode            skip the full-file decode during validation (weaker)
  --json                   emit a machine-readable result

The video is written to <out-dir>/<n>/demo.mp4. Evidence — raw recording,
timeline, contact sheet, validation and report — stays in <out-dir>/.work/<n>/.
`;

function fail(code, message, extra = {}) {
  process.stdout.write(JSON.stringify({ ok: false, code, error: message, ...extra }, null, 2) + "\n");
  process.exit(code);
}

/** Run one pipeline script, returning its exit code and parsed JSON output. */
function runStep(script, args) {
  const result = spawnSync(process.execPath, [path.join(HERE, script), ...args], {
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    timeout: 0,
    env: process.env,
  });
  let json = null;
  const trimmed = (result.stdout ?? "").trim();
  if (trimmed.startsWith("{")) {
    try {
      json = JSON.parse(trimmed);
    } catch {
      json = null;
    }
  }
  return {
    script,
    code: result.status ?? -1,
    json,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    signal: result.signal ?? null,
  };
}

function reasonFromStep(step, label) {
  if (step.json?.error) return String(step.json.error).split("\n")[0];
  const tail = `${step.stderr}\n${step.stdout}`.trim().split("\n").filter(Boolean).slice(-3).join(" | ");
  return tail || `${label} failed with exit code ${step.code}`;
}

/** Read a JSON file if it is there; the manifest is evidence, never a blocker. */
function readJsonIfPresent(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function removeIfEmpty(dir) {
  try {
    if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch {
    /* the numbered folder is not a delivery; cleanup is best effort */
  }
}

function buildDelivery({ plan, pair, quality, fps, status, validation, timeline, reportPath }) {
  const media = validation.media ?? {};
  const steps = timeline.steps ?? [];
  const failed = steps.filter((s) => s.status === "failed").length;
  const optionalFailed = steps.filter((s) => s.status === "failed-optional").length;
  const assertions = steps.filter((s) => s.assertion);
  const counts = validation.counts ?? {};
  const manifest = readJsonIfPresent(path.join(pair.workDir, "manifest.json"));
  const browser = manifest?.backend?.browser?.name
    ? `${manifest.backend.browser.name} (${manifest.backend.resolved})`
    : manifest?.backend?.channel
      ? `${manifest.backend.channel} (${manifest.backend.resolved})`
      : null;
  const app = manifest?.app
    ? manifest.app.mode === "production"
      ? `production — ${manifest.app.build?.command ?? "build"} → ${manifest.app.serve?.command ?? "serve"}`
      : "the already-running application"
    : null;
  return {
    skill: "record-app-skill",
    deliveredAt: new Date().toISOString(),
    delivered: true,
    status,
    title: plan.title,
    description: plan.description ?? null,
    application: plan.baseUrl,
    videoUrl: pair.video.url,
    videoPath: pair.video.path,
    outputDir: pair.outputDir,
    workDir: pair.workDir,
    quality,
    fps,
    media: {
      file: "demo.mp4",
      videoCodec: media.videoCodec ?? "h264",
      width: media.width ?? plan.browser.viewport.width,
      height: media.height ?? plan.browser.viewport.height,
      fps: media.fps ?? fps,
      durationSeconds: media.durationSeconds ?? null,
      sizeBytes: pair.video.bytes,
      sizeHuman: formatBytes(pair.video.bytes),
      hasAudio: media.hasAudio ?? false,
    },
    steps: {
      total: steps.length,
      ok: steps.filter((s) => s.status === "ok").length,
      failed,
      optionalFailed,
    },
    assertions: {
      total: assertions.length,
      passed: assertions.filter((s) => s.assertion?.passed).length,
    },
    checks: {
      total: counts.total ?? 0,
      passed: counts.passed ?? 0,
      failed: counts.failed ?? 0,
      warnings: counts.warnings ?? 0,
    },
    browser,
    app,
    report: reportPath,
    validation: path.join(pair.workDir, "validation.json"),
    note: "The numbered output folder contains only demo.mp4; evidence lives in the hidden .work folder.",
  };
}

function markdownFor(delivery) {
  if (!delivery.delivered) {
    return [
      `- No video delivered. Status: **${delivery.status}**.`,
      delivery.reason ? `- Reason: ${delivery.reason}` : null,
      `- Evidence stays in this folder: \`${delivery.workDir}\`.`,
    ]
      .filter(Boolean)
      .join("\n");
  }
  return [
    `- Video: ${delivery.videoUrl}`,
    `- Output folder: \`${delivery.outputDir}\` (contains only \`demo.mp4\`)`,
    `- Status: **${delivery.status}**`,
    `- Quality: ${delivery.quality.name} (CRF ${delivery.quality.crf}, preset ${delivery.quality.preset}), ${delivery.fps} fps`,
    delivery.browser ? `- Browser: ${delivery.browser}` : null,
    delivery.app ? `- Build: ${delivery.app}` : null,
    `- Duration: ${delivery.media.durationSeconds?.toFixed(1) ?? "?"}s, ${delivery.media.sizeHuman}`,
    `- Steps: ${delivery.steps.ok}/${delivery.steps.total} ok, ${delivery.assertions.passed}/${delivery.assertions.total} assertions passed`,
    `- Checks: ${delivery.checks.passed}/${delivery.checks.total} passed`,
    `- Evidence: \`${delivery.workDir}\` (raw recording, timeline, contact sheet, validation, report)`,
  ]
    .filter(Boolean)
    .join("\n");
}

function report(delivery, args) {
  if (args.json) {
    process.stdout.write(
      JSON.stringify(
        {
          ok: delivery.delivered,
          code: delivery.delivered ? EXIT.OK : EXIT.WORKFLOW_FAILED,
          ...delivery,
          block: formatDeliveryBlock(delivery),
        },
        null,
        2
      ) + "\n"
    );
  } else {
    process.stdout.write(`${formatDeliveryBlock(delivery)}\n`);
  }
}

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
    process.stderr.write("--max-duration-ms must be a positive number\n");
    process.exit(EXIT.INVALID_PLAN);
  }

  const planPath = path.resolve(args.plan);
  let planInput;
  try {
    planInput = readJsonFile(planPath);
  } catch (err) {
    fail(EXIT.INVALID_PLAN, `could not read plan: ${err.message}`);
  }

  // Validate before allocating anything: a refused plan must leave no empty
  // numbered folder behind.
  const { errors, plan } = validatePlan(planInput);
  if (errors.length) {
    process.stderr.write("Plan validation failed:\n");
    for (const error of errors) process.stderr.write(`  - ${redactSecrets(error)}\n`);
    fail(EXIT.INVALID_PLAN, `plan has ${errors.length} validation error(s)`, {
      errors: errors.map(redactSecrets),
    });
  }

  const consequential = plan.steps.filter((step) => step.consequential === true || consequentialReason(step));
  if (consequential.length && !args.allowConsequential) {
    fail(
      EXIT.INVALID_PLAN,
      `${consequential.length} step(s) are externally consequential (${consequential
        .map((step) => step.id)
        .join(", ")}) but this run did not authorize them. ` +
        "Confirm with the user, then re-run with --allow-consequential.",
      { steps: consequential.map((step) => step.id) }
    );
  }

  let quality;
  try {
    quality = resolveQuality(args.quality ?? plan.media.quality);
  } catch (err) {
    fail(EXIT.INVALID_PLAN, err.message);
  }
  const fps = args.fps ?? plan.capture.fps ?? DEFAULT_FPS;
  if (!Number.isInteger(fps) || fps < 1 || fps > 60) {
    fail(EXIT.INVALID_PLAN, `--fps must be an integer between 1 and 60 (got ${fps})`);
  }
  if (args.quality && !QUALITY_NAMES.includes(args.quality)) {
    fail(EXIT.INVALID_PLAN, `--quality must be one of ${QUALITY_NAMES.join(", ")}`);
  }

  const base = resolveOutputBase(args.outDir);
  const pair = allocateNumberedPair(base);
  process.stderr.write(
    `Recording ${path.basename(planPath)} at ${fps} fps (${quality.name}) into ${pair.workDir}\n` +
      (args.production ? "  mode     : production build\n" : "")
  );

  const common = [];
  if (args.backend) common.push("--backend", args.backend);
  if (args.headed) common.push("--headed");
  if (args.allowConsequential) common.push("--allow-consequential");
  // The production build and its server are the difference between a smooth
  // demo and one that shows a development server's lag.
  if (args.production) common.push("--production");
  if (args.appRoot) common.push("--app-root", args.appRoot);
  if (args.build) common.push("--build", args.build);
  if (args.serve) common.push("--serve", args.serve);
  if (args.serveUrl) common.push("--serve-url", args.serveUrl);

  // ---- record ---------------------------------------------------------
  const record = runStep("record-workflow.mjs", [
    "--plan", planPath,
    "--run-dir", pair.workDir,
    "--out-dir", pair.outputDir,
    "--quality", quality.name,
    "--fps", String(fps),
    "--max-duration-ms", String(args.maxDurationMs),
    ...common,
    "--json",
  ]);
  if (!record.json) {
    removeIfEmpty(pair.outputDir);
    fail(EXIT.INTERNAL, `record-workflow.mjs produced no result: ${record.stdout}${record.stderr}`.trim());
  }
  if (record.code !== EXIT.OK) {
    removeIfEmpty(pair.outputDir);
    const delivery = {
      skill: "record-app-skill",
      deliveredAt: new Date().toISOString(),
      delivered: false,
      // The recorder distinguishes "workflow failed" from "could not record";
      // the handoff vocabulary uses "verification-failed" for the former.
      status:
        record.json.status === "workflow-failed"
          ? "verification-failed"
          : (record.json.status ?? failureStatus(record.code)),
      title: plan.title,
      application: plan.baseUrl,
      outputDir: pair.outputDir,
      workDir: pair.workDir,
      reason:
        record.json.failure
          ? `${record.json.failure.name ?? "WorkflowFailure"} at step ${record.json.failure.stepId ?? "?"}: ${record.json.failure.message ?? "unknown error"}`
          : reasonFromStep(record, "recording"),
      report: path.join(pair.workDir, "report.md"),
    };
    writeDeliveryRecord(pair.workDir, delivery);
    appendDeliveryReport(pair.workDir, markdownFor(delivery));
    report(delivery, args);
    process.exit(record.code);
  }

  // ---- render ---------------------------------------------------------
  const renderSettings = resolveRenderSettings(plan, quality, { explicitQuality: Boolean(args.quality) });
  const render = runStep("render-video.mjs", [
    "--run-dir", pair.workDir,
    "--quality", renderSettings.name,
    "--crf", String(renderSettings.crf),
    "--preset", renderSettings.preset,
    "--fps", String(fps),
    "--json",
  ]);
  if (render.code !== EXIT.OK) {
    removeIfEmpty(pair.outputDir);
    const delivery = {
      skill: "record-app-skill",
      deliveredAt: new Date().toISOString(),
      delivered: false,
      status: render.code === EXIT.MISSING_DEPENDENCY ? "missing-dependency" : "recording-failed",
      title: plan.title,
      outputDir: pair.outputDir,
      workDir: pair.workDir,
      reason: reasonFromStep(render, "render"),
      report: path.join(pair.workDir, "report.md"),
    };
    writeDeliveryRecord(pair.workDir, delivery);
    appendDeliveryReport(pair.workDir, markdownFor(delivery));
    report(delivery, args);
    process.exit(render.code);
  }

  // ---- contact sheet --------------------------------------------------
  const sheet = runStep("build-contact-sheet.mjs", ["--run-dir", pair.workDir, "--json"]);
  if (sheet.code !== EXIT.OK) {
    removeIfEmpty(pair.outputDir);
    const delivery = {
      skill: "record-app-skill",
      deliveredAt: new Date().toISOString(),
      delivered: false,
      status: "recording-failed",
      title: plan.title,
      outputDir: pair.outputDir,
      workDir: pair.workDir,
      reason: reasonFromStep(sheet, "contact sheet"),
      report: path.join(pair.workDir, "report.md"),
    };
    writeDeliveryRecord(pair.workDir, delivery);
    appendDeliveryReport(pair.workDir, markdownFor(delivery));
    report(delivery, args);
    process.exit(sheet.code);
  }

  // ---- validate -------------------------------------------------------
  const validateArgs = ["--run-dir", pair.workDir, "--require-contact-sheet", "--json"];
  if (args.skipDecode) validateArgs.push("--skip-decode");
  const validate = runStep("validate-video.mjs", validateArgs);
  if (!validate.json) {
    removeIfEmpty(pair.outputDir);
    fail(EXIT.INTERNAL, `validate-video.mjs produced no result: ${validate.stdout}${validate.stderr}`.trim());
  }

  // ---- deliver --------------------------------------------------------
  const status = validate.json.status;
  if (status === "validated" || status === "partial") {
    let video;
    try {
      video = finalizeDelivery({ workDir: pair.workDir, outputDir: pair.outputDir });
    } catch (err) {
      removeIfEmpty(pair.outputDir);
      fail(EXIT.OUTPUT_CONFLICT, err.message, { workDir: pair.workDir });
    }
    const timeline = readJsonFile(path.join(pair.workDir, "timeline.json"));
    const delivery = buildDelivery({
      plan,
      pair: { ...pair, video },
      quality: renderSettings,
      fps,
      status,
      validation: validate.json,
      timeline,
      reportPath: path.join(pair.workDir, "report.md"),
    });
    writeDeliveryRecord(pair.workDir, delivery);
    appendDeliveryReport(pair.workDir, markdownFor(delivery));
    report(delivery, args);
    process.exit(EXIT.OK);
  }

  // Nothing usable to deliver. Keep the evidence, remove the empty numbered
  // folder, and say exactly what failed.
  removeIfEmpty(pair.outputDir);
  const timeline = fs.existsSync(path.join(pair.workDir, "timeline.json"))
    ? readJsonFile(path.join(pair.workDir, "timeline.json"))
    : { steps: [] };
  const delivery = {
    skill: "record-app-skill",
    deliveredAt: new Date().toISOString(),
    delivered: false,
    status,
    title: plan.title,
    application: plan.baseUrl,
    outputDir: pair.outputDir,
    workDir: pair.workDir,
    reason: validate.json.summary ?? validate.json.failedChecks?.[0]?.description ?? "validation failed",
    report: path.join(pair.workDir, "report.md"),
    validation: path.join(pair.workDir, "validation.json"),
    steps: timeline.steps?.length ?? 0,
  };
  writeDeliveryRecord(pair.workDir, delivery);
  appendDeliveryReport(pair.workDir, markdownFor(delivery));
  report(delivery, args);
  process.exit(validate.code === EXIT.OK ? EXIT.WORKFLOW_FAILED : validate.code);
}

main().catch((err) => fail(EXIT.INTERNAL, redactSecrets(err?.stack ?? String(err))));
