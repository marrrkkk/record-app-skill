#!/usr/bin/env node
/**
 * Build a contact sheet of representative frames from the finished video.
 *
 * The frames are chosen from the recorded timeline — opening state, each scene
 * boundary, every step whose action was verified, and the final state — so the
 * sheet shows what the workflow actually did rather than arbitrary snapshots.
 * A machine-readable report maps each cell back to its timestamp and step.
 *
 * Usage:
 *   node build-contact-sheet.mjs --run-dir <dir> [--cols 4] [--cell-width 480]
 *
 * Exit codes: 0 ok · 2 usage · 4 missing dependency · 6 no video/plan
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { EXIT, readJsonFile, redactSecrets, isMainModule } from "./lib.mjs";
import { checkFfmpeg, runFfmpeg, findFont as sharedFindFont } from "./ffmpeg.mjs";
import { probeMedia } from "./media-probe.mjs";

const HELP = `Build a contact sheet of representative frames.

  node build-contact-sheet.mjs --run-dir <dir> [options]

  --run-dir <dir>     run directory (required)
  --input <file>      video to sample (default: demo.mp4, falls back to raw-recording.webm)
  --cols <n>          grid columns (default: 4)
  --cell-width <px>   width of each cell (default: 480)
  --max-frames <n>    cap on sampled frames (default: 12)
  --json              machine-readable result

Exit codes: 0 ok · 2 usage · 4 missing FFmpeg · 6 no video or timeline
`;

function parseArgs(argv) {
  const args = { runDir: null, input: null, cols: 4, cellWidth: 480, maxFrames: 12, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${a}`);
      return v;
    };
    switch (a) {
      case "--run-dir": args.runDir = next(); break;
      case "--input": args.input = next(); break;
      case "--cols": args.cols = Number(next()); break;
      case "--cell-width": args.cellWidth = Number(next()); break;
      case "--max-frames": args.maxFrames = Number(next()); break;
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

function fail(code, message, extra = {}) {
  process.stdout.write(JSON.stringify({ ok: false, code, error: message, ...extra }, null, 2) + "\n");
  process.exit(code);
}

/** Find a font file for frame labels. Labels are optional. */
function findFont() {
  return sharedFindFont();
}

/**
 * Choose sample points from the recorded timeline.
 * Returns [{ms, label, stepId, kind}] sorted ascending and deduplicated.
 */
/**
 * A short, human label for a step, used on the contact sheet.
 *
 * `title` defaults to the action name, so on its own it produces labels like
 * "Verified: waitFor". Pairing it with the selector it ran against makes the
 * sheet readable without opening the plan.
 */
export function describeStep(step) {
  const title = step.title && step.title !== step.action ? step.title : null;
  const target = step.selector ?? step.assertSelector ?? "";
  const text = [title ?? step.action, target].filter(Boolean).join(" ");
  return text.length > 46 ? `${text.slice(0, 45)}…` : text;
}

/**
 * Choose sample points from the recorded timeline.
 *
 * Two subtleties matter here, both of which produced empty frames before they
 * were handled:
 *
 *  - The timeline is in *capture wall-clock* milliseconds, while the encoded
 *    video is CFR and usually slightly shorter. Sample times are therefore
 *    scaled into video time.
 *  - Whatever is left of that drift is clamped short of the end, because a
 *    timestamp past the last frame decodes to nothing at all.
 *
 * Returns [{ms, label, stepId, kind, sourceMs, clamped?}] sorted ascending and
 * deduplicated. `ms` is a time in the video, `sourceMs` is the original
 * timeline time.
 *
 * @param {object} timeline        parsed timeline.json
 * @param {number} durationMs      real duration of the video being sampled
 * @param {number} maxFrames       cap on the number of samples
 * @param {object} [options]
 * @param {number} [options.sourceDurationMs] duration of the timeline (defaults
 *   to `durationMs`, i.e. no scaling — correct when the file was not re-encoded)
 * @param {number} [options.guardMs] distance to stay clear of the end
 */
export function chooseSamples(timeline, durationMs, maxFrames, options = {}) {
  const known = Number.isFinite(durationMs) && durationMs > 0;
  const sourceDurationMs =
    Number.isFinite(options.sourceDurationMs) && options.sourceDurationMs > 0
      ? options.sourceDurationMs
      : durationMs;
  const guardMs = Number.isFinite(options.guardMs) ? Math.max(0, options.guardMs) : 120;
  const scale = known && sourceDurationMs > 0 ? durationMs / sourceDurationMs : 1;
  const limit = known ? Math.max(0, durationMs - guardMs) : null;

  const samples = [];
  const push = (s) => {
    const raw = Number(s.ms);
    if (!Number.isFinite(raw) || raw < 0) return;
    // `unscaled` samples are already expressed in video time.
    const scaled = s.unscaled ? Math.round(raw) : Math.round(raw * scale);
    const ms = limit === null ? scaled : Math.max(0, Math.min(scaled, limit));
    samples.push({
      ...s,
      ms,
      sourceMs: raw,
      ...(limit !== null && scaled > limit ? { clamped: true } : {}),
    });
  };

  // The opening and closing frames are the two cells a viewer looks at first,
  // so they are protected from the deduplication below.
  push({ ms: 0, kind: "start", label: "Opening state", stepId: null, priority: 3 });

  for (const scene of timeline.scenes ?? []) {
    push({ ms: scene.startMs, kind: "scene", label: scene.name, stepId: scene.stepIds?.[0] ?? null, priority: 2 });
  }

  for (const step of timeline.steps ?? []) {
    // Prefer frames where something was actually verified or changed state.
    if (step.assertion?.passed) {
      push({
        ms: step.endedAtMs,
        kind: "verified",
        label: `Verified: ${describeStep(step)}`,
        stepId: step.id,
        priority: 1,
      });
    } else if (step.status === "failed" || step.status === "failed-optional") {
      push({
        ms: step.endedAtMs,
        kind: "failed",
        label: `Failed: ${describeStep(step)}`,
        stepId: step.id,
        // A failure outranks everything: a contact sheet must never hide one.
        priority: 4,
      });
    }
  }

  // The closing frame is the last frame of the video, short of the guard.
  push({
    ms: limit === null ? Math.max(0, sourceDurationMs - 250) : limit,
    kind: "end",
    label: "Final state",
    stepId: null,
    priority: 3,
    unscaled: true,
  });

  // Deduplicate by half-second bucket. Within a bucket the higher-priority
  // sample wins (so the sheet keeps its first, last and failed frames), and
  // ties keep the earliest. Nothing is lost: the winner records the step ids it
  // absorbed and whether any of them had to be clamped.
  const order = { start: 0, scene: 1, verified: 2, failed: 3, end: 4 };
  const buckets = new Map();
  for (const s of samples.sort((a, b) => a.ms - b.ms || (order[a.kind] ?? 9) - (order[b.kind] ?? 9))) {
    const key = Math.round(s.ms / 500);
    const existing = buckets.get(key);
    if (!existing) {
      buckets.set(key, s);
      continue;
    }
    const winner = (s.priority ?? 0) > (existing.priority ?? 0) ? s : existing;
    const loser = winner === s ? existing : s;
    const absorbed = new Set([
      ...(winner.mergedSteps ?? []),
      ...(winner.stepId ? [winner.stepId] : []),
      ...(loser.mergedSteps ?? []),
      ...(loser.stepId ? [loser.stepId] : []),
    ]);
    absorbed.delete(winner.stepId);
    buckets.set(key, {
      ...winner,
      ...(absorbed.size ? { mergedSteps: [...absorbed] } : {}),
      ...(winner.clamped || loser.clamped ? { clamped: true } : {}),
    });
  }
  const deduped = [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([, s]) => s);

  if (deduped.length <= maxFrames) return deduped;
  // Always keep first and last; thin the middle evenly.
  const picked = [deduped[0]];
  const middle = deduped.slice(1, -1);
  const slots = maxFrames - 2;
  for (let i = 0; i < slots; i++) {
    picked.push(middle[Math.round((i * (middle.length - 1)) / Math.max(1, slots - 1))]);
  }
  picked.push(deduped[deduped.length - 1]);
  return picked.filter(Boolean);
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
  if (!args.runDir) {
    process.stderr.write(`--run-dir is required\n\n${HELP}`);
    process.exit(EXIT.INVALID_PLAN);
  }

  const runDir = path.resolve(args.runDir);
  const timelinePath = path.join(runDir, "timeline.json");
  if (!fs.existsSync(timelinePath)) {
    fail(EXIT.ENVIRONMENT_FAILED, `no timeline.json in ${runDir}; run record-workflow.mjs first`);
  }
  const timeline = readJsonFile(timelinePath);

  const demoPath = path.join(runDir, "demo.mp4");
  const rawPath = path.join(runDir, "raw-recording.webm");
  const input = args.input
    ? path.resolve(args.input)
    : fs.existsSync(demoPath)
      ? demoPath
      : fs.existsSync(rawPath)
        ? rawPath
        : null;
  if (!input || !fs.existsSync(input)) {
    fail(EXIT.ENVIRONMENT_FAILED, `no video to sample in ${runDir}; expected demo.mp4 or raw-recording.webm`);
  }

  const ff = checkFfmpeg({ requireMp4: false, override: null });
  if (!ff.ffmpeg) fail(EXIT.MISSING_DEPENDENCY, "ffmpeg is required to build a contact sheet", { guidance: ff.guidance });

  const info = probeMedia(input);
  const videoDurationMs = Math.max(0, (info?.durationSeconds ?? timeline.captureDurationMs / 1000) * 1000);
  // The timeline counts in capture wall-clock time; the video is CFR. Sampling
  // is done on the video's own clock, with a guard short of the final frame.
  const guardMs = Math.max(120, Math.round(2000 / (info?.fps || 30)));
  const samples = chooseSamples(timeline, videoDurationMs, args.maxFrames, {
    sourceDurationMs: timeline.captureDurationMs,
    guardMs,
  });
  if (samples.length === 0) fail(EXIT.ENVIRONMENT_FAILED, "could not choose any sample frames");

  // Pad to a full grid so the tile filter has exactly cols*rows inputs.
  const cols = Math.max(1, Math.min(args.cols, samples.length));
  const rows = Math.ceil(samples.length / cols);
  const needed = cols * rows;
  const padded = [...samples];
  while (padded.length < needed) padded.push({ ...samples[samples.length - 1], duplicateOf: samples[samples.length - 1].ms });

  const framesDir = path.join(runDir, ".contact-sheet-frames");
  fs.rmSync(framesDir, { recursive: true, force: true });
  fs.mkdirSync(framesDir, { recursive: true, mode: 0o700 });

  const font = findFont();
  const cellW = Math.max(160, Math.round(args.cellWidth));
  const cellH = info?.width && info?.height ? Math.round((cellW * info.height) / info.width / 2) * 2 : Math.round(cellW * 0.5625 / 2) * 2;

  const cells = [];
  for (let i = 0; i < padded.length; i++) {
    const sample = padded[i];
    const framePath = path.join(framesDir, `frame-${String(i).padStart(2, "0")}.png`);
    const filters = [`scale=${cellW}:${cellH}:flags=lanczos`];
    if (font) {
      const seconds = (sample.ms / 1000).toFixed(1);
      // Labels sit top-left so they never collide with the in-video captions,
      // which are rendered at the bottom of the recorded frame.
      const suffix =
        sample.duplicateOf !== undefined
          ? "  (repeat of previous frame)"
          : [
              sample.clamped ? "(closest available frame)" : null,
              sample.mergedSteps?.length ? `(+${sample.mergedSteps.length} more step${sample.mergedSteps.length === 1 ? "" : "s"})` : null,
            ]
              .filter(Boolean)
              .join("  ")
              .replace(/^/, "  ")
              .trimEnd();
      const label = `${seconds}s  ${sample.label}${suffix}`.replace(/[':\\]/g, " ");
      filters.push(
        `drawtext=fontfile='${font.replace(/\\/g, "/").replace(/'/g, "")}':text='${label}':` +
          `x=8:y=8:fontsize=13:fontcolor=white:box=1:boxcolor=black@0.62:boxborderw=6`
      );
    }
    const res = runFfmpeg(ff.ffmpeg, [
      "-hide_banner", "-nostdin",
      "-ss", (sample.ms / 1000).toFixed(3),
      "-i", input,
      "-frames:v", "1",
      "-vf", filters.join(","),
      "-y", framePath,
    ]);
    if (res.code !== 0 || !fs.existsSync(framePath)) {
      fs.rmSync(framesDir, { recursive: true, force: true });
      // "nothing was encoded" is what a timestamp past the last frame looks
      // like: ffmpeg succeeds and writes no file. Say so instead of printing an
      // empty reason.
      const produced = fs.existsSync(framePath);
      const detail = produced
        ? ""
        : `ffmpeg produced no frame at ${(sample.ms / 1000).toFixed(3)}s of ${(info?.durationSeconds ?? 0).toFixed(3)}s ` +
          `(exit ${res.code}). The sample time may be past the last frame.`;
      const stderr = String(res.stderr ?? "")
        .split("\n")
        .filter((line) => line.trim())
        .slice(-3)
        .join(" ");
      fail(
        EXIT.INTERNAL,
        `could not extract a frame at ${(sample.ms / 1000).toFixed(2)}s: ${detail}${stderr ? ` ${redactSecrets(stderr)}` : ""}`.trim()
      );
    }
    cells.push({
      index: i,
      timeMs: sample.ms,
      timeSeconds: Number((sample.ms / 1000).toFixed(3)),
      sourceTimeSeconds: Number((sample.sourceMs / 1000).toFixed(3)),
      kind: sample.kind,
      label: sample.label,
      stepId: sample.stepId,
      // Steps whose frame had to share this cell are recorded, so the report
      // never implies a step was skipped.
      ...(sample.mergedSteps?.length ? { mergedSteps: sample.mergedSteps } : {}),
      ...(sample.clamped ? { clamped: true } : {}),
      // Padded cells repeat a real captured frame to complete the grid; they are
      // flagged here and labelled in the image so the sheet is never misleading.
      repeated: sample.duplicateOf !== undefined,
      file: path.basename(framePath),
    });
  }

  const sheetPath = path.join(runDir, "contact-sheet.png");
  const tileRes = runFfmpeg(ff.ffmpeg, [
    "-hide_banner", "-nostdin",
    "-framerate", "1",
    "-i", path.join(framesDir, "frame-%02d.png"),
    "-frames:v", "1",
    "-vf", `tile=${cols}x${rows}:padding=8:margin=8:color=0x11151c`,
    "-y", sheetPath,
  ]);

  if (tileRes.code !== 0 || !fs.existsSync(sheetPath) || fs.statSync(sheetPath).size === 0) {
    fs.rmSync(framesDir, { recursive: true, force: true });
    fail(EXIT.INTERNAL, `could not tile the contact sheet: ${redactSecrets(tileRes.stderr.split("\n").slice(-6).join(" "))}`);
  }

  fs.rmSync(framesDir, { recursive: true, force: true });

  const report = {
    generatedAt: new Date().toISOString(),
    skill: "record-app-skill",
    input: path.basename(input),
    inputDurationSeconds: Number((videoDurationMs / 1000).toFixed(3)),
    sourceDurationSeconds: Number(((timeline.captureDurationMs ?? videoDurationMs) / 1000).toFixed(3)),
    guardMs,
    grid: { cols, rows, cells: cols * rows, sampledFrames: samples.length },
    cellSize: { width: cellW, height: cellH },
    labelsRendered: Boolean(font),
    font: font ?? null,
    sheet: path.basename(sheetPath),
    sheetBytes: fs.statSync(sheetPath).size,
    cells,
  };
  fs.writeFileSync(path.join(runDir, "contact-sheet.json"), JSON.stringify(report, null, 2) + "\n", "utf8");

  const payload = {
    ok: true,
    code: EXIT.OK,
    runDir,
    sheet: sheetPath,
    sheetBytes: report.sheetBytes,
    grid: report.grid,
    labelsRendered: report.labelsRendered,
    cells: cells.map((c) => ({ t: c.timeSeconds, kind: c.kind, label: c.label, stepId: c.stepId })),
  };

  if (args.json) process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
  else {
    process.stdout.write(
      `\nContact sheet: ${sheetPath}\n` +
        `  source : ${path.basename(input)} (${(videoDurationMs / 1000).toFixed(1)}s)\n` +
        `  grid   : ${cols}x${rows} from ${samples.length} sampled frame(s)\n` +
        `  labels : ${report.labelsRendered ? "yes" : "no (no font found; cells are unlabelled)"}\n` +
        `  report : contact-sheet.json\n`
    );
  }
  process.exit(EXIT.OK);
}

// Only run when invoked as a command: the sampling logic is unit-tested by
// importing this module.
if (isMainModule(import.meta.url)) {
  main().catch((err) => fail(EXIT.INTERNAL, redactSecrets(err?.stack ?? String(err))));
}
