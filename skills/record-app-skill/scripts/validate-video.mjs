#!/usr/bin/env node
/**
 * Validate a finished demo run.
 *
 * Successful encoding is not success. This script answers four separate
 * questions and keeps them separate in its output:
 *
 *   1. Did the workflow actually work?   (recorded assertions)
 *   2. Is the media real and correctly shaped? (metadata, full decode)
 *   3. Do the artifacts cross-reference correctly? (captions, timeline, scenes)
 *   4. Did anything secret leak, or is any output missing?
 *
 * Resulting statuses:
 *   validated             workflow passed and the recording is verified
 *   verification-failed   recording is fine but an application assertion failed
 *   partial               some steps failed or were skipped
 *   recording-failed      the recording or the encoding failed
 *
 * Usage:
 *   node validate-video.mjs --run-dir <dir> [--require-contact-sheet] [--json]
 *
 * Exit codes: 0 validated · 4 missing dependency · 5 workflow verification
 *             failed · 6 recording or encoding failed
 */

import fs from "node:fs";
import path from "node:path";
import { EXIT, readJsonFile, scanArtifactsForSecrets, formatBytes, redactSecrets } from "./lib.mjs";
import { checkFfmpeg, runFfmpeg, ffprobeMedia } from "./ffmpeg.mjs";
import { probeMedia } from "./media-probe.mjs";

const HELP = `Validate a finished demo run.

  node validate-video.mjs --run-dir <dir> [options]

  --run-dir <dir>            run directory (required)
  --require-contact-sheet    fail when contact-sheet.png is missing
  --skip-decode              skip the full-file decode (faster, weaker)
  --json                     machine-readable result

Exit codes: 0 validated · 4 missing dependency · 5 verification failed · 6 recording failed
`;

function parseArgs(argv) {
  const args = { runDir: null, requireContactSheet: false, skipDecode: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--run-dir": args.runDir = argv[++i]; break;
      case "--require-contact-sheet": args.requireContactSheet = true; break;
      case "--skip-decode": args.skipDecode = true; break;
      case "--json": args.json = true; break;
      case "-h":
      case "--help": args.help = true; break;
      default: throw new Error(`unknown option: ${a}`);
    }
  }
  return args;
}

function fail(code, message, extra = {}) {
  process.stdout.write(JSON.stringify({ ok: false, code, error: message, ...extra }, null, 2) + "\n");
  process.exit(code);
}

/* ------------------------------------------------------------------ */
/* Check collection                                                    */
/* ------------------------------------------------------------------ */

class Checks {
  constructor() {
    this.items = [];
  }
  add(id, description, passed, { severity = "error", expected = null, actual = null, detail = null } = {}) {
    this.items.push({ id, description, passed: Boolean(passed), severity, expected, actual, detail });
    return passed;
  }
  get errors() {
    return this.items.filter((c) => !c.passed && c.severity === "error");
  }
  get warnings() {
    return this.items.filter((c) => !c.passed && c.severity === "warning");
  }
  get passed() {
    return this.items.filter((c) => c.passed);
  }
}

/** Relative tolerance comparison used for media timing/rate checks. */
function withinTolerance(actual, expected, relTol, absTol = 0) {
  if (actual === null || actual === undefined || !Number.isFinite(actual)) return false;
  const diff = Math.abs(actual - expected);
  return diff <= absTol || diff <= Math.abs(expected) * relTol;
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
  if (!args.runDir) {
    process.stderr.write(`--run-dir is required\n\n${HELP}`);
    process.exit(EXIT.INVALID_PLAN);
  }

  const runDir = path.resolve(args.runDir);
  if (!fs.existsSync(runDir)) fail(EXIT.ENVIRONMENT_FAILED, `run directory does not exist: ${runDir}`);

  const checks = new Checks();
  const notes = [];

  // ---- load artifacts -------------------------------------------------
  const timelinePath = path.join(runDir, "timeline.json");
  const manifestPath = path.join(runDir, "manifest.json");
  const workflowPath = path.join(runDir, "workflow.json");
  const rawPath = path.join(runDir, "raw-recording.webm");
  const demoPath = path.join(runDir, "demo.mp4");
  const srtPath = path.join(runDir, "captions.srt");
  const sheetPath = path.join(runDir, "contact-sheet.png");

  let timeline = null;
  let manifest = null;
  let plan = null;
  try {
    timeline = fs.existsSync(timelinePath) ? readJsonFile(timelinePath) : null;
  } catch (err) {
    notes.push(`timeline.json could not be parsed: ${err.message}`);
  }
  try {
    manifest = fs.existsSync(manifestPath) ? readJsonFile(manifestPath) : null;
  } catch (err) {
    notes.push(`manifest.json could not be parsed: ${err.message}`);
  }
  try {
    plan = fs.existsSync(workflowPath) ? readJsonFile(workflowPath) : null;
  } catch (err) {
    notes.push(`workflow.json could not be parsed: ${err.message}`);
  }

  // ---- 1. required artifacts exist ------------------------------------
  checks.add("artifacts.timeline", "timeline.json exists", fs.existsSync(timelinePath));
  checks.add("artifacts.manifest", "manifest.json exists", fs.existsSync(manifestPath));
  checks.add("artifacts.workflow", "workflow.json exists", fs.existsSync(workflowPath));
  checks.add("artifacts.raw", "raw-recording.webm exists and is non-empty", fileNonEmpty(rawPath), {
    actual: sizeOf(rawPath),
  });
  const demoExists = fileNonEmpty(demoPath);
  checks.add("artifacts.demo", "demo.mp4 exists and is non-empty", demoExists, { actual: sizeOf(demoPath) });
  checks.add("artifacts.storyboard", "storyboard.md exists", fs.existsSync(path.join(runDir, "storyboard.md")));

  const expectsSheet = args.requireContactSheet;
  checks.add(
    "artifacts.contactSheet",
    "contact-sheet.png exists",
    fileNonEmpty(sheetPath),
    { severity: expectsSheet ? "error" : "warning", actual: sizeOf(sheetPath) }
  );

  if (!demoExists) {
    // Nothing further can be checked about a video that does not exist, and we
    // must not report success. Explain precisely why.
    const reason = manifest?.status === "failed" || timeline?.status === "failed"
      ? "the workflow recording failed, so no demo was rendered"
      : "demo.mp4 was not produced (the render step was not run, or FFmpeg was unavailable)";
    return finish({
      args, runDir, checks, notes,
      status: "recording-failed",
      summary: `No demo.mp4 in ${runDir}: ${reason}`,
    });
  }

  // ---- 2. media metadata ---------------------------------------------
  const ff = checkFfmpeg({ requireMp4: false });
  const ownProbe = probeMedia(demoPath);
  const ffProbe = ff.ffprobe ? ffprobeMedia(ff.ffprobe, demoPath) : null;
  const media = ffProbe ?? ownProbe;
  const probeSource = ffProbe ? "ffprobe" : "built-in container parser";

  if (!media) {
    checks.add("media.readable", "video metadata can be read", false, { detail: "neither ffprobe nor the built-in parser recognized the file" });
    return finish({ args, runDir, checks, notes, status: "recording-failed", summary: "demo.mp4 is not a recognizable media file" });
  }
  checks.add("media.readable", "video metadata can be read", true, { detail: `via ${probeSource}` });

  // Cross-check the two probes when both are available; disagreement means one
  // of them is wrong and the numbers cannot be trusted.
  if (ffProbe && ownProbe) {
    const agree =
      ffProbe.width === ownProbe.width &&
      ffProbe.height === ownProbe.height &&
      (ffProbe.hasAudio === ownProbe.hasAudio);
    checks.add("media.probeAgreement", "ffprobe and the built-in parser agree on dimensions and audio", agree, {
      severity: "warning",
      expected: `${ownProbe.width}x${ownProbe.height} audio=${ownProbe.hasAudio}`,
      actual: `${ffProbe.width}x${ffProbe.height} audio=${ffProbe.hasAudio}`,
    });
  }

  const wantFps = plan?.media?.fps ?? plan?.capture?.fps ?? 60;
  const wantW = plan?.browser?.viewport?.width ?? null;
  const wantH = plan?.browser?.viewport?.height ?? null;

  checks.add("media.container", "container is MP4", media.container === "mp4", { expected: "mp4", actual: media.container });
  checks.add("media.codec", "video codec is H.264", media.videoCodec === "h264", { expected: "h264", actual: media.videoCodec });
  checks.add("media.silent", "no audio stream is present", media.hasAudio === false, {
    expected: "no audio",
    actual: media.audioCodec ? `audio: ${media.audioCodec}` : "no audio",
  });
  checks.add("media.fps", `constant frame rate is ~${wantFps} fps`, withinTolerance(media.fps, wantFps, 0.02, 0.2), {
    expected: wantFps,
    actual: media.fps,
  });
  if (wantW && wantH) {
    checks.add("media.dimensions", `dimensions match the capture viewport (${wantW}x${wantH})`, media.width === wantW && media.height === wantH, {
      expected: `${wantW}x${wantH}`,
      actual: `${media.width}x${media.height}`,
    });
  }
  const durationsMatch = rawPath && fs.existsSync(rawPath) ? probeMedia(rawPath)?.durationSeconds : null;
  checks.add(
    "media.duration",
    "duration is plausible (matches the recorded timeline)",
    withinTolerance(media.durationSeconds, timeline?.captureDurationMs ? timeline.captureDurationMs / 1000 : media.durationSeconds, 0.25, 2.5),
    { expected: timeline?.captureDurationMs ? (timeline.captureDurationMs / 1000).toFixed(2) : null, actual: media.durationSeconds }
  );
  if (durationsMatch) {
    checks.add("media.durationVsRaw", "MP4 duration is close to the raw recording duration", withinTolerance(media.durationSeconds, durationsMatch, 0.25, 2.5), {
      severity: "warning",
      expected: durationsMatch.toFixed(2),
      actual: media.durationSeconds,
    });
  }
  checks.add("media.frameCount", "frame count is consistent with duration x fps", frameCountSane(media), {
    severity: "warning",
    expected: media.durationSeconds && media.fps ? Math.round(media.durationSeconds * media.fps) : null,
    actual: media.nbFrames,
  });

  // ---- 3. full decode -------------------------------------------------
  if (!args.skipDecode) {
    if (!ff.ffmpeg) {
      checks.add("media.decode", "the complete video decodes without errors", false, {
        severity: "warning",
        detail: "ffmpeg is not available, so a full decode could not be performed",
      });
      notes.push("Full decode was skipped because ffmpeg is unavailable. Metadata checks still passed.");
    } else {
      const dec = runFfmpeg(ff.ffmpeg, ["-hide_banner", "-nostdin", "-v", "error", "-i", demoPath, "-f", "null", "-"]);
      const stderr = (dec.stderr || "").trim();
      const ok = dec.code === 0 && stderr.length === 0;
      checks.add("media.decode", "the complete video decodes without errors", ok, {
        detail: ok ? "decoded the entire file cleanly" : redactSecrets(stderr.split("\n").slice(0, 6).join(" | ") || `ffmpeg exited ${dec.code}`),
      });
    }
  } else {
    notes.push("Full decode was skipped by request (--skip-decode).");
  }

  // ---- 4. timeframe sanity vs timeline --------------------------------
  const tlDurationMs = timeline?.captureDurationMs ?? null;
  if (tlDurationMs && media.durationSeconds) {
    const delta = Math.abs(media.durationSeconds * 1000 - tlDurationMs);
    checks.add("media.vsTimeline", "video length corresponds to the recorded workflow length", delta < 8000, {
      severity: "warning",
      expected: `~${(tlDurationMs / 1000).toFixed(1)}s`,
      actual: `${media.durationSeconds.toFixed(1)}s (delta ${(delta / 1000).toFixed(1)}s)`,
    });
  }

  return continueValidation({ args, runDir, checks, notes, timeline, manifest, plan, media, mediaSource: probeSource, srtPath, sheetPath, ff, ownProbe, ffProbe });
}

function fileNonEmpty(p) {
  try {
    return fs.statSync(p).size > 0;
  } catch {
    return false;
  }
}

function sizeOf(p) {
  try {
    return formatBytes(fs.statSync(p).size);
  } catch {
    return null;
  }
}

function frameCountSane(media) {
  if (!media.nbFrames || !media.durationSeconds || !media.fps) return true; // unknown -> not a failure
  const expected = media.durationSeconds * media.fps;
  return Math.abs(media.nbFrames - expected) / expected < 0.05;
}

/* ------------------------------------------------------------------ */
/* Part 2: workflow, cross-reference and privacy checks                */
/* ------------------------------------------------------------------ */

function continueValidation({ args, runDir, checks, notes, timeline, manifest, plan, media, mediaSource, srtPath, sheetPath, ff, ownProbe, ffProbe }) {
  const steps = timeline?.steps ?? [];

  // ---- 5. the workflow itself ----------------------------------------
  checks.add("workflow.status", "the recording reports a successful workflow", timeline?.status !== "failed", {
    expected: "recorded",
    actual: timeline?.status ?? "unknown",
  });

  const failedRequired = steps.filter((s) => s.status === "failed");
  const failedOptional = steps.filter((s) => s.status === "failed-optional");
  const ok = steps.filter((s) => s.status === "ok");

  checks.add("workflow.noFailedSteps", "no required step failed", failedRequired.length === 0, {
    expected: "0 failed steps",
    actual: `${failedRequired.length} failed${failedRequired.length ? `: ${failedRequired.map((s) => s.id).join(", ")}` : ""}`,
  });

  // Every plan step must appear in the timeline, or the recording does not
  // cover what was planned.
  if (plan?.steps?.length) {
    const plannedIds = plan.steps.map((s, i) => s.id ?? `${i + 1}-${s.action}`);
    const recordedIds = new Set(steps.map((s) => s.id));
    const missing = plannedIds.filter((id) => !recordedIds.has(id));
    checks.add("workflow.coverage", "every planned step was attempted", missing.length === 0, {
      expected: `${plannedIds.length} steps`,
      actual: `${recordedIds.size} recorded${missing.length ? `, missing: ${missing.join(", ")}` : ""}`,
    });
  }

  // Assertions are what separate a demo from a claim. A plan with none cannot
  // be verified, which is worth flagging even though nothing "failed".
  const stepsWithExpect = Array.isArray(plan?.steps) ? plan.steps.filter((s) => s.expect) : [];
  const allAssertionsPassed = steps.filter((s) => s.assertion).every((s) => s.assertion.passed);
  checks.add("workflow.assertionsPassed", "all recorded assertions passed", allAssertionsPassed, {
    actual: `${steps.filter((s) => s.assertion && s.assertion.passed).length}/${steps.filter((s) => s.assertion).length} passed`,
  });
  if (plan && stepsWithExpect.length === 0) {
    checks.add("workflow.hasAssertions", "the plan verifies at least one outcome", false, {
      severity: "warning",
      detail: "no step in this plan declares an `expect`; the demo shows actions but proves nothing about the result",
    });
    notes.push("This plan has no assertions. Consider adding `expect` to the steps whose result matters.");
  }

  // The final visible state must be a verified result, not an action.
  const assertingSteps = steps.filter((s) => s.assertion?.passed);
  const lastStep = steps[steps.length - 1];
  checks.add(
    "workflow.finalStateVerified",
    "a verified result is shown (not just an action)",
    assertingSteps.length > 0,
    { severity: "error", detail: assertingSteps.length ? `${assertingSteps.length} verified step(s)` : "no step's outcome was verified" }
  );
  if (lastStep && lastStep.action === "click" && !lastStep.assertion) {
    checks.add("workflow.endsOnResult", "the workflow ends on a result rather than a final click", false, {
      severity: "warning",
      detail: `the last step (${lastStep.id}) is a click with no verification; the viewer never sees the outcome`,
    });
  }

  // ---- 6. captions and scene cross-references -------------------------
  const captionSteps = steps.filter((s) => s.caption);
  const srtExists = fs.existsSync(srtPath);
  if (captionSteps.length) {
    checks.add("captions.srtExists", "captions.srt exists because captions were recorded", srtExists, { severity: "error" });
    if (srtExists) {
      const srt = fs.readFileSync(srtPath, "utf8");
      const blocks = srt.split(/\n\s*\n/).filter((b) => b.trim());
      checks.add("captions.srtEntries", "captions.srt has one entry per captioned step", blocks.length === captionSteps.length, {
        expected: captionSteps.length,
        actual: blocks.length,
      });
      const worst = captionSteps
        .map((s) => (s.captionWindow ? s.captionWindow.endMs : 0))
        .reduce((a, b) => Math.max(a, b), 0);
      checks.add("captions.withinVideo", "captions fall inside the video duration", media.durationSeconds ? worst <= media.durationSeconds * 1000 + 1500 : true, {
        severity: "warning",
        expected: `<= ${(media.durationSeconds * 1000).toFixed(0)}ms`,
        actual: `${worst}ms`,
      });
    }
  } else {
    // Captions are off by default. Only warn when the plan explicitly asked
    // for captions but none reached the recording.
    if (plan?.capture?.captions?.enabled === true) {
      checks.add("captions.present", "captions were enabled but no step declares one", false, {
        severity: "warning",
        detail: "enable captions only when requested, or remove captions from the plan's capture settings",
      });
    }
  }

  const scenes = timeline?.scenes ?? [];
  if (scenes.length) {
    const stepIds = new Set(steps.map((s) => s.id));
    const badRefs = scenes.flatMap((sc) => (sc.stepIds ?? []).filter((id) => !stepIds.has(id)));
    checks.add("scenes.referencesValid", "every scene references a real recorded step", badRefs.length === 0, {
      actual: badRefs.length ? `unknown step ids: ${badRefs.join(", ")}` : `${scenes.length} scenes`,
    });
    const withinDuration = scenes.every((sc) => sc.endMs <= (timeline.captureDurationMs ?? 0) + 1000);
    checks.add("scenes.withinTimeline", "scene timings fall inside the recorded timeline", withinDuration, { severity: "warning" });
  }

  // ---- 7. contact sheet cross-reference ------------------------------
  const sheetReportPath = path.join(runDir, "contact-sheet.json");
  if (fileNonEmpty(sheetPath)) {
    if (fs.existsSync(sheetReportPath)) {
      try {
        const sheet = readJsonFile(sheetReportPath);
        const cells = sheet.cells ?? [];
        const realCells = cells.filter((c) => !c.repeated);
        const inRange = realCells.every((c) => c.timeSeconds <= (media.durationSeconds ?? Infinity) + 1);
        checks.add("contactSheet.samplesInRange", "contact-sheet frames come from inside the video", inRange, {
          severity: "warning",
          actual: `${realCells.length} real frames, latest at ${Math.max(0, ...realCells.map((c) => c.timeSeconds)).toFixed(1)}s of ${media.durationSeconds?.toFixed(1)}s`,
        });
        const kinds = new Set(realCells.map((c) => c.kind));
        const representative = kinds.has("start") && kinds.has("end");
        checks.add("contactSheet.representative", "contact sheet includes the opening and final states", representative, {
          actual: [...kinds].join(", "),
        });
      } catch (err) {
        checks.add("contactSheet.reportReadable", "contact-sheet.json is readable", false, { severity: "warning", detail: err.message });
      }
    } else {
      checks.add("contactSheet.reportPresent", "contact-sheet.json describes the sheet", false, {
        severity: "warning",
        detail: "the sheet exists but has no report mapping frames to timestamps",
      });
    }
  }

  // ---- 8. privacy ----------------------------------------------------
  const leaks = scanArtifactsForSecrets(runDir);
  checks.add("privacy.noSecrets", "no credential-shaped value appears in generated text artifacts", leaks.length === 0, {
    actual: leaks.length ? leaks.map((l) => `${path.relative(runDir, l.where)} (${l.label})`).join("; ") : "clean",
  });

  // ---- 9. overall status ---------------------------------------------
  let status;
  if (!checks.items.find((c) => c.id === "media.readable")?.passed) status = "recording-failed";
  else if (failedRequired.length > 0 || !allAssertionsPassed || timeline?.status === "failed") status = "verification-failed";
  else if (failedOptional.length > 0) status = "partial";
  else if (checks.errors.length > 0) status = "recording-failed";
  else status = "validated";

  const summary = summarize(status, { steps, failedRequired, failedOptional, ok, media });

  const exitCode =
    status === "validated" ? EXIT.OK : status === "recording-failed" ? EXIT.ENVIRONMENT_FAILED : EXIT.WORKFLOW_FAILED;

  return finish({ args, runDir, checks, notes, status, summary, timeline, manifest, plan, media, mediaSource, exitCode, sheetPath });
}

function summarize(status, { steps, failedRequired, failedOptional, ok, media }) {
  const base = `${steps.length} step(s): ${ok.length} ok, ${failedRequired.length} failed, ${failedOptional.length} optional-failed`;
  const dur = media?.durationSeconds ? `${media.durationSeconds.toFixed(1)}s ${media.videoCodec ?? ""} ${media.width ?? "?"}x${media.height ?? "?"}` : "no video";
  switch (status) {
    case "validated":
      return `Workflow succeeded and the recording is validated (${base}; ${dur}).`;
    case "verification-failed":
      return `Recording completed but workflow verification failed (${base}). The assertions in the plan did not all pass — this is not a successful demonstration.`;
    case "partial":
      return `Recording partially completed (${base}). Optional steps failed; the required workflow steps passed.`;
    default:
      return `Recording or encoding failed (${base}; ${dur}).`;
  }
}

/* ------------------------------------------------------------------ */
/* Reporting                                                           */
/* ------------------------------------------------------------------ */

function finish({ args, runDir, checks, notes, status, summary, timeline = null, manifest = null, plan = null, media = null, mediaSource = null, exitCode = EXIT.ENVIRONMENT_FAILED, sheetPath = null }) {
  const report = {
    skill: "record-app-skill",
    validatedAt: new Date().toISOString(),
    runDir,
    status,
    summary,
    exitCode,
    media: media
      ? {
          file: "demo.mp4",
          probeSource: mediaSource,
          container: media.container,
          videoCodec: media.videoCodec,
          audioCodec: media.audioCodec,
          hasAudio: media.hasAudio,
          width: media.width,
          height: media.height,
          fps: media.fps,
          nbFrames: media.nbFrames,
          durationSeconds: media.durationSeconds,
          fileSizeBytes: media.fileSizeBytes,
        }
      : null,
    checks: checks.items,
    counts: {
      total: checks.items.length,
      passed: checks.passed.length,
      failed: checks.errors.length,
      warnings: checks.warnings.length,
    },
    failedChecks: checks.errors.map((c) => ({ id: c.id, description: c.description, expected: c.expected, actual: c.actual, detail: c.detail })),
    warningChecks: checks.warnings.map((c) => ({ id: c.id, description: c.description, detail: c.detail, actual: c.actual })),
    notes,
    steps: (timeline?.steps ?? []).map((s) => ({
      id: s.id,
      action: s.action,
      title: s.title,
      status: s.status,
      verified: Boolean(s.assertion?.passed),
      selector: s.selector,
      startedAtMs: s.startedAtMs,
      durationMs: s.durationMs,
      error: s.error?.message ?? null,
    })),
  };

  fs.writeFileSync(path.join(runDir, "validation.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
  fs.writeFileSync(
    path.join(runDir, "report.md"),
    buildFinalReport({ runDir, status, summary, checks, notes, timeline, manifest, plan, media, mediaSource, sheetPath }),
    "utf8"
  );

  const payload = {
    ok: status === "validated",
    code: exitCode,
    status,
    summary,
    runDir,
    validation: path.join(runDir, "validation.json"),
    report: path.join(runDir, "report.md"),
    counts: report.counts,
    failedChecks: report.failedChecks,
    warnings: report.warningChecks,
    media: report.media,
  };

  if (args.json) process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
  else {
    const icon = status === "validated" ? "✅" : status === "partial" ? "⚠️" : "❌";
    process.stdout.write(`\n${icon} ${status.toUpperCase()} — ${summary}\n`);
    process.stdout.write(`  checks : ${report.counts.passed}/${report.counts.total} passed, ${report.counts.failed} failed, ${report.counts.warnings} warning(s)\n`);
    if (report.media) {
      process.stdout.write(
        `  video  : ${report.media.videoCodec} ${report.media.width}x${report.media.height} @ ${report.media.fps} fps, ` +
          `${report.media.durationSeconds?.toFixed(1)}s, audio=${report.media.hasAudio ? "yes" : "none"} (${mediaSource})\n`
      );
    }
    for (const f of report.failedChecks) process.stdout.write(`  FAIL   : ${f.id} — ${f.description}${f.actual ? ` (${f.actual})` : ""}\n`);
    for (const w of report.warningChecks) process.stdout.write(`  warn   : ${w.id} — ${w.description}${w.detail ? ` (${w.detail})` : ""}\n`);
    for (const n of notes) process.stdout.write(`  note   : ${n}\n`);
    process.stdout.write(`\n  report : ${path.join(runDir, "report.md")}\n`);
  }

  process.exit(exitCode);
}

function buildFinalReport({ runDir, status, summary, checks, notes, timeline, manifest, plan, media, mediaSource, sheetPath }) {
  const L = [];
  const title = plan?.title ?? manifest?.workflow?.title ?? path.basename(runDir);
  L.push(`# ${title}`);
  L.push("");
  L.push(`**Status: ${status.toUpperCase()}** — ${summary}`);
  L.push("");
  if (plan?.description) {
    L.push(plan.description);
    L.push("");
  }

  L.push("## Run");
  L.push("");
  L.push(`- Application: \`${plan?.baseUrl ?? manifest?.workflow?.baseUrl ?? "unknown"}\``);
  L.push(`- Backend: \`${manifest?.backend?.resolved ?? "unknown"}\` — ${manifest?.backend?.reason ?? ""}`);
  const browser = manifest?.backend?.browser;
  L.push(
    `- Browser: ${browser?.name ?? `\`${manifest?.backend?.channel ?? "?"}\``}` +
      `${browser?.version ? ` ${browser.version}` : ""}` +
      ` on ${manifest?.environment?.hostLabel ?? manifest?.environment?.platform ?? "?"}` +
      `${browser?.source ? ` [${browser.source}]` : ""}`
  );
  L.push(`- Playwright: ${manifest?.environment?.playwright ?? "?"}`);
  L.push(`- Recorded: ${timeline ? (timeline.captureDurationMs / 1000).toFixed(1) + "s" : "unknown"}`);
  if (media) {
    L.push(
      `- Video: \`demo.mp4\` — ${media.videoCodec} ${media.width}x${media.height} @ ${media.fps} fps, ` +
        `${media.durationSeconds?.toFixed(1)}s, audio ${media.hasAudio ? "**present**" : "none"}, probed with ${mediaSource}`
    );
    if (plan?.media?.quality) {
      L.push(`- Quality preset: \`${plan.media.quality}\` (CRF ${plan.media.crf}, preset ${plan.media.preset})`);
    }
  }
  L.push("");

  L.push("## Result");
  L.push("");
  L.push("| Step | Action | Outcome | Verified | Selector |");
  L.push("| ---- | ------ | ------- | -------- | -------- |");
  for (const s of timeline?.steps ?? []) {
    const outcome = s.status === "ok" ? "ok" : s.status === "failed-optional" ? "optional failure" : "failed";
    L.push(`| ${s.title ?? s.id} | \`${s.action}\` | ${outcome} | ${s.assertion?.passed ? "yes" : "—"} | ${s.selector ? `\`${s.selector}\`` : "—"} |`);
  }
  L.push("");

  const failures = checks.errors;
  const warns = checks.warnings;
  L.push("## Validation");
  L.push("");
  L.push(`${checks.passed.length}/${checks.items.length} checks passed.`);
  L.push("");
  if (failures.length) {
    L.push("Failed checks:");
    L.push("");
    for (const f of failures) L.push(`- **${f.id}** — ${f.description}${f.actual ? ` (got: ${f.actual}${f.expected ? `, expected: ${f.expected}` : ""})` : ""}${f.detail ? ` — ${f.detail}` : ""}`);
    L.push("");
  }
  if (warns.length) {
    L.push("Warnings:");
    L.push("");
    for (const w of warns) L.push(`- ${w.id} — ${w.description}${w.detail ? ` (${w.detail})` : ""}`);
    L.push("");
  }

  L.push("## Outputs");
  L.push("");
  for (const f of ["demo.mp4", "raw-recording.webm", "storyboard.md", "workflow.json", "timeline.json", "captions.srt", "contact-sheet.png", "contact-sheet.json", "manifest.json", "validation.json"]) {
    if (fs.existsSync(path.join(runDir, f))) L.push(`- \`${f}\``);
  }
  L.push("");

  L.push("## Limitations");
  L.push("");
  L.push("- The MP4 is a transcode of the raw browser recording; `raw-recording.webm` is the fidelity reference.");
  if (timeline?.steps?.some((s) => s.captionWindow)) {
    L.push(
      "- Captions are rendered in-page by the browser during recording, so changing caption text requires a re-record. `captions.srt` is provided for downstream editing."
    );
  }
  if (!media) L.push("- No video was produced, so no media claims are made.");
  if (sheetPath && !fs.existsSync(sheetPath)) L.push("- No contact sheet was generated.");
  L.push("- This report describes only what the application actually did during the recorded run. Nothing is inferred or simulated.");
  L.push("");

  if (notes.length) {
    L.push("## Notes");
    L.push("");
    for (const n of notes) L.push(`- ${n}`);
    L.push("");
  }
  return L.join("\n");
}

export { Checks, withinTolerance, fileNonEmpty, sizeOf, frameCountSane, finish, continueValidation, parseArgs, HELP, fail, buildFinalReport };

main().catch((err) => fail(EXIT.INTERNAL, redactSecrets(err?.stack ?? String(err))));
