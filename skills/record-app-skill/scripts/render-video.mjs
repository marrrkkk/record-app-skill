#!/usr/bin/env node
/**
 * Render the raw browser recording into the final H.264 MP4.
 *
 * The raw recording is always preserved: it is the fidelity reference and the
 * diagnostic evidence. The MP4 is a transcode to a documented constant frame
 * rate, which is what makes the timeline, captions and contact sheet line up.
 *
 * Usage:
 *   node render-video.mjs --run-dir <dir> [--quality high] [--fps 60] [--crf 18] [--preset slow]
 *
 * Exit codes: 0 ok · 1 internal · 2 usage · 3 output conflict ·
 *             4 missing dependency (FFmpeg) · 6 no raw recording
 */

import fs from "node:fs";
import path from "node:path";
import {
  EXIT,
  QUALITY_NAMES,
  QUALITY_PRESETS,
  DEFAULT_FPS,
  readJsonFile,
  formatBytes,
  redactSecrets,
} from "./lib.mjs";
import { checkFfmpeg, runFfmpeg, ffprobeMedia, isPlaywrightBundled } from "./ffmpeg.mjs";
import { probeMedia } from "./media-probe.mjs";

const HELP = `Render the raw recording into demo.mp4.

  node render-video.mjs --run-dir <dir> [options]

  --run-dir <dir>     run directory produced by record-workflow.mjs (required)
  --quality <name>    high | balanced | compact (default: plan media.quality or high)
  --fps <n>           constant output frame rate (default: plan media.fps or ${DEFAULT_FPS})
  --crf <n>           x264 quality, lower is better (default: from the quality preset)
  --preset <name>     x264 preset (default: from the quality preset)
  --ffmpeg <path>     explicit ffmpeg binary
  --force             overwrite an existing demo.mp4
  --json              machine-readable result

Exit codes: 0 ok · 2 usage · 3 output conflict · 4 missing FFmpeg · 6 no raw recording
`;

function parseArgs(argv) {
  const args = { runDir: null, quality: null, fps: null, crf: null, preset: null, ffmpeg: null, force: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${a}`);
      return v;
    };
    switch (a) {
      case "--run-dir": args.runDir = next(); break;
      case "--quality": args.quality = next(); break;
      case "--fps": args.fps = Number(next()); break;
      case "--crf": args.crf = Number(next()); break;
      case "--preset": args.preset = next(); break;
      case "--ffmpeg": args.ffmpeg = next(); break;
      case "--force": args.force = true; break;
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
  if (!fs.existsSync(runDir)) fail(EXIT.INVALID_PLAN, `run directory does not exist: ${runDir}`);

  const rawPath = path.join(runDir, "raw-recording.webm");
  if (!fs.existsSync(rawPath) || fs.statSync(rawPath).size === 0) {
    fail(
      EXIT.ENVIRONMENT_FAILED,
      `no raw recording found at ${rawPath}. ` +
        `The recording step must succeed before rendering. See report.md in the run directory.`
    );
  }

  // Plan values are the defaults; CLI flags override.
  let plan = null;
  try {
    plan = readJsonFile(path.join(runDir, "workflow.json"));
  } catch {
    /* the plan copy is advisory for rendering */
  }

  const qualityName = args.quality ?? plan?.media?.quality ?? "high";
  if (!QUALITY_NAMES.includes(qualityName)) {
    fail(EXIT.INVALID_PLAN, `--quality must be one of ${QUALITY_NAMES.join(", ")} (got ${qualityName})`);
  }
  const quality = QUALITY_PRESETS[qualityName];
  const fps = args.fps ?? plan?.media?.fps ?? plan?.capture?.fps ?? DEFAULT_FPS;
  if (!Number.isInteger(fps) || fps < 1 || fps > 60) {
    fail(EXIT.INVALID_PLAN, `--fps must be an integer between 1 and 60 (got ${fps})`);
  }
  // An explicit --quality chooses the encoder settings. Without it, the plan's
  // own crf/preset win because the plan may intentionally override one field.
  const crf = args.crf ?? (args.quality ? quality.crf : (plan?.media?.crf ?? quality.crf));
  const preset = args.preset ?? (args.quality ? quality.preset : (plan?.media?.preset ?? quality.preset));

  const outPath = path.join(runDir, "demo.mp4");
  if (fs.existsSync(outPath) && !args.force) {
    fail(
      EXIT.OUTPUT_CONFLICT,
      `refusing to overwrite the existing ${outPath}. Pass --force to replace it, ` +
        `or delete it yourself if you are sure.`
    );
  }

  // ---- dependency check ----------------------------------------------
  const ff = checkFfmpeg({ requireMp4: true, override: args.ffmpeg });
  if (!ff.ok) {
    fail(
      EXIT.MISSING_DEPENDENCY,
      `cannot render an MP4: ${ff.problems.join("; ")}`,
      {
        rawRecording: rawPath,
        rawBytesHuman: formatBytes(fs.statSync(rawPath).size),
        guidance: ff.guidance,
        note: "The raw recording is valid and was preserved. No MP4 was produced.",
      }
    );
  }

  const rawInfo = probeMedia(rawPath);
  const src = ff.ffprobe ? ffprobeMedia(ff.ffprobe, rawPath) ?? rawInfo : rawInfo;

  // ---- encode ---------------------------------------------------------
  // -vf fps=<n> resamples to a constant frame rate; -fps_mode cfr guarantees a
  // CFR output timeline. scale=trunc(...) keeps dimensions even for yuv420p, a
  // no-op when the capture size is already even.
  const filters = [`fps=${fps}`, "scale=trunc(iw/2)*2:trunc(ih/2)*2", "format=yuv420p"].join(",");
  const encodeArgs = [
    "-hide_banner",
    "-nostdin",
    "-i", rawPath,
    "-an", // explicit: the deliverable has no audio track
    "-vf", filters,
    "-fps_mode", "cfr",
    "-c:v", "libx264",
    "-preset", String(preset),
    "-crf", String(crf),
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    "-y",
    outPath,
  ];

  const started = Date.now();
  const result = runFfmpeg(ff.ffmpeg, encodeArgs);
  const elapsedMs = Date.now() - started;

  if (result.code !== 0 || !fs.existsSync(outPath) || fs.statSync(outPath).size === 0) {
    const tail = (result.stderr || result.stdout || "").trim().split("\n").slice(-12).join("\n");
    fail(EXIT.INTERNAL, `ffmpeg failed to encode ${outPath}\n${redactSecrets(tail)}`, {
      rawRecording: rawPath,
      ffmpeg: ff.ffmpeg,
      playwrightBundled: isPlaywrightBundled(ff.ffmpeg),
    });
  }

  const outInfo = ff.ffprobe ? ffprobeMedia(ff.ffprobe, outPath) ?? probeMedia(outPath) : probeMedia(outPath);

  // ---- record render metadata in the manifest -------------------------
  const manifestPath = path.join(runDir, "manifest.json");
  let manifest = null;
  if (fs.existsSync(manifestPath)) {
    try {
      manifest = readJsonFile(manifestPath);
      manifest.render = {
        renderedAt: new Date().toISOString(),
        ffmpeg: ff.ffmpeg,
        ffprobe: ff.ffprobe ?? null,
        ffmpegVersion: ff.ffmpegReport.version,
        quality: qualityName,
        requestedFps: fps,
        crf,
        preset,
        filterChain: filters,
        elapsedMs,
        source: { file: "raw-recording.webm", ...pick(src) },
        output: { file: "demo.mp4", ...pick(outInfo) },
      };
      manifest.files = { ...(manifest.files ?? {}), demo: "demo.mp4" };
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
    } catch {
      /* manifest is advisory; the encode succeeded */
    }
  }

  const payload = {
    ok: true,
    code: EXIT.OK,
    runDir,
    demo: outPath,
    sizeBytes: fs.statSync(outPath).size,
    sizeHuman: formatBytes(fs.statSync(outPath).size),
    quality: qualityName,
    fps,
    crf,
    preset,
    source: pick(src),
    output: pick(outInfo),
    elapsedMs,
    ffmpeg: ff.ffmpeg,
    ffprobeUsed: Boolean(ff.ffprobe),
  };

  if (args.json) process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
  else {
    process.stdout.write(
      `\nRendered ${path.basename(outPath)} (${payload.sizeHuman})\n` +
        `  ${outInfo?.videoCodec ?? "?"} ${outInfo?.width ?? "?"}x${outInfo?.height ?? "?"} @ ${outInfo?.fps ?? "?"} fps, ` +
        `${outInfo?.durationSeconds ? outInfo.durationSeconds.toFixed(1) + "s" : "?"}, audio=${outInfo?.hasAudio ? "yes" : "none"}\n` +
        `  quality: ${qualityName} (CRF ${crf}, preset ${preset})\n` +
        `  memory/time: ${(elapsedMs / 1000).toFixed(1)}s\n` +
        `\nNext: node validate-video.mjs --run-dir "${runDir}"\n`
    );
  }
  process.exit(EXIT.OK);
}

function pick(info) {
  if (!info) return {};
  return {
    container: info.container ?? null,
    videoCodec: info.videoCodec ?? null,
    audioCodec: info.audioCodec ?? null,
    width: info.width ?? null,
    height: info.height ?? null,
    fps: info.fps ?? null,
    nbFrames: info.nbFrames ?? null,
    durationSeconds: info.durationSeconds ?? null,
    hasAudio: info.hasAudio ?? null,
    fileSizeBytes: info.fileSizeBytes ?? null,
  };
}

main().catch((err) => fail(EXIT.INTERNAL, redactSecrets(err?.stack ?? String(err))));
