/**
 * System FFmpeg discovery and capability checking.
 *
 * Why capability checks instead of just checking that the binary exists:
 * Playwright ships its own FFmpeg, and it is built with `--disable-everything`
 * plus only libvpx-vp9, the webm muxer and pad/crop/scale. It has no H.264
 * encoder, no MP4 muxer and no text filters, so it can neither produce the
 * required deliverable nor burn captions. Detecting that case explicitly lets
 * the skill explain the real problem instead of emitting a confusing FFmpeg
 * error, or worse, reporting a finished MP4.
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const BINARIES = { ffmpeg: "ffmpeg", ffprobe: "ffprobe" };

function which(bin) {
  try {
    const out = execFileSync("which", [bin], { encoding: "utf8", timeout: 5000 }).trim();
    return out && fs.existsSync(out) ? out : null;
  } catch {
    return null;
  }
}

/**
 * Locate a system binary. An explicit override always wins, and is validated.
 */
export function findBinary(name, { override = null } = {}) {
  const envOverride = process.env[`RECORD_APP_SKILL_${name.toUpperCase()}`];
  const candidates = [override, envOverride].filter(Boolean);
  for (const c of candidates) {
    const resolved = c.includes(path.sep) ? c : which(c);
    if (resolved && fs.existsSync(resolved)) return resolved;
    return null; // an explicit path that does not exist is an error, not a fallback
  }
  return which(BINARIES[name] ?? name);
}

export function isPlaywrightBundled(binPath) {
  return /ms-playwright|playwright-core[\\/]\.local-browsers/.test(binPath ?? "");
}

/** Run `-hide_banner -<kind>` and return the raw listing. */
function listCapabilities(bin, kind) {
  try {
    return execFileSync(bin, ["-hide_banner", `-${kind}`], { encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    return String(err?.stdout ?? "");
  }
}

/**
 * Inspect an FFmpeg binary.
 * Returns { path, version, encoders:Set, muxers:Set, filters:Set, ... }
 */
export function inspectFfmpeg(binPath, { full = true } = {}) {
  const report = {
    path: binPath,
    exists: false,
    version: null,
    playwrightBundled: isPlaywrightBundled(binPath),
    hasH264: false,
    hasMp4: false,
    hasDrawtext: false,
    hasSubtitles: false,
    canRenderMp4: false,
  };
  if (!binPath || !fs.existsSync(binPath)) return report;
  report.exists = true;

  try {
    const v = execFileSync(binPath, ["-version"], { encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"] });
    report.version = (v.split("\n")[0] ?? "").trim();
    report.buildConfig = (v.match(/configuration:([^\n]*)/)?.[1] ?? "").trim();
  } catch {
    return report;
  }

  if (!full) return report;

  const encoders = listCapabilities(binPath, "encoders");
  const muxers = listCapabilities(binPath, "muxers");
  const filters = listCapabilities(binPath, "filters");

  report.hasH264 = /libx264|\s+h264\s/.test(encoders) || /\blibx264\b/.test(encoders);
  report.hasMp4 = /^\s*E\s+mp4\b/m.test(muxers) || /\bmp4\b/.test(muxers.split("\n").find((l) => /\bmp4\b/.test(l)) ?? "");
  report.hasDrawtext = /^\s*[.TSC]*\s+drawtext\b/m.test(filters);
  report.hasSubtitles = /^\s*[.TSC]*\s+subtitles\b/m.test(filters);
  report.hasFpsFilter = /^\s*[.TSC]*\s+fps\b/m.test(filters);
  report.canRenderMp4 = report.hasH264 && report.hasMp4;
  return report;
}

/**
 * Structured FFmpeg availability check with actionable guidance.
 * Never installs anything; the user stays in control of their system.
 */
export function checkFfmpeg({ requireMp4 = true, override = null } = {}) {
  const ffmpegPath = findBinary("ffmpeg", { override });
  const ffprobePath = findBinary("ffprobe");
  const ffmpeg = inspectFfmpeg(ffmpegPath);
  const problems = [];
  const guidance = [];

  if (!ffmpegPath || !ffmpeg.exists) {
    problems.push("ffmpeg was not found on PATH");
  } else if (requireMp4 && !ffmpeg.canRenderMp4) {
    if (ffmpeg.playwrightBundled) {
      problems.push(
        `the FFmpeg found at ${ffmpegPath} is Playwright's bundled build, which cannot encode H.264 or write MP4 ` +
          `(it is built with --disable-everything and only supports VP9/WebM)`
      );
    } else {
      problems.push(`the FFmpeg at ${ffmpegPath} cannot encode H.264 in MP4 (missing libx264 or the mp4 muxer)`);
    }
  }

  if (problems.length) {
    guidance.push(...installGuidance());
  }

  return {
    ok: problems.length === 0,
    ffmpeg: ffmpegPath,
    ffprobe: ffprobePath,
    ffmpegReport: ffmpeg,
    ffprobeAvailable: Boolean(ffprobePath),
    problems,
    guidance,
  };
}

export function installGuidance() {
  const os = process.platform;
  const lines = [
    "Install system FFmpeg (the bundled Playwright build cannot produce H.264 MP4):",
  ];
  if (os === "linux") {
    lines.push("  Debian/Ubuntu: sudo apt-get install ffmpeg");
    lines.push("  Fedora/RHEL:   sudo dnf install ffmpeg");
    lines.push("  Arch:          sudo pacman -S ffmpeg");
    lines.push("  Alpine:        sudo apk add ffmpeg");
  } else if (os === "darwin") {
    lines.push("  Homebrew: brew install ffmpeg");
    lines.push("  MacPorts: sudo port install ffmpeg");
  } else if (os === "win32") {
    lines.push("  winget install Gyan.FFmpeg");
    lines.push("  or: choco install ffmpeg");
    lines.push("  or download from https://www.gyan.dev/ffmpeg/builds/ and add its bin/ to PATH");
  }
  lines.push("");
  lines.push("Then confirm with: ffmpeg -version && ffprobe -version");
  lines.push("Or point the skill at a specific binary: RECORD_APP_SKILL_FFMPEG=/path/to/ffmpeg");
  lines.push("");
  lines.push("Until then the raw recording is preserved and no MP4 is reported.");
  return lines;
}

/**
 * Find a font file for drawing labels onto contact-sheet cells.
 * Returns null when no font can be found; labels are then skipped entirely
 * rather than failing the sheet.
 */
export function findFont() {
  const candidates = [
    process.env.RECORD_APP_SKILL_FONT,
    "/usr/share/fonts/TTF/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/liberation/LiberationSans-Regular.ttf",
    "/usr/share/fonts/TTF/LiberationSans-Regular.ttf",
    "/usr/share/fonts/Adwaita/AdwaitaSans-Regular.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "C:\\Windows\\Fonts\\arial.ttf",
  ].filter(Boolean);
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  // Last resort: ask fontconfig, which knows about distro-specific layouts.
  try {
    const out = execFileSync("fc-match", ["-f", "%{file}", "sans"], { encoding: "utf8", timeout: 5000 }).trim();
    if (out && fs.existsSync(out)) return out;
  } catch {
    /* no fontconfig */
  }
  return null;
}

/** Run ffmpeg, returning { code, stdout, stderr }. Never throws on non-zero exit. */
export function runFfmpeg(binPath, args, { timeout = 600000 } = {}) {
  try {
    const stdout = execFileSync(binPath, args, {
      encoding: "utf8",
      timeout,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    return {
      code: typeof err?.status === "number" ? err.status : 1,
      stdout: String(err?.stdout ?? ""),
      stderr: String(err?.stderr ?? err?.message ?? ""),
    };
  }
}

/**
 * Probe media with ffprobe when available.
 * Returns a normalized shape matching media-probe.mjs, or null.
 */
export function ffprobeMedia(ffprobePath, file, { timeout = 60000 } = {}) {
  if (!ffprobePath || !fs.existsSync(ffprobePath)) return null;
  const args = [
    "-v", "error",
    "-show_entries", "format=format_name,duration,size,nb_streams",
    "-show_entries", "stream=index,codec_name,codec_type,width,height,avg_frame_rate,nb_frames,channels",
    "-of", "json",
    file,
  ];
  const { code, stdout } = runFfmpeg(ffprobePath, args, { timeout });
  if (code !== 0 || !stdout.trim()) return null;
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const streams = parsed.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video");
  const audio = streams.find((s) => s.codec_type === "audio");
  const fmt = parsed.format ?? {};
  const parseRate = (r) => {
    if (!r || r === "0/0") return null;
    const [n, d] = String(r).split("/").map(Number);
    if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return null;
    return Math.round((n / d) * 1000) / 1000;
  };
  const formatName = String(fmt.format_name ?? "");
  return {
    container: formatName.includes("webm") ? "webm" : formatName.includes("mp4") || formatName.includes("mov") ? "mp4" : formatName,
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    width: video?.width ?? null,
    height: video?.height ?? null,
    fps: parseRate(video?.avg_frame_rate),
    nbFrames: video?.nb_frames ? Number(video.nb_frames) : null,
    durationSeconds: fmt.duration ? Number(fmt.duration) : null,
    hasAudio: Boolean(audio),
    fileSizeBytes: fmt.size ? Number(fmt.size) : null,
    file,
    source: "ffprobe",
  };
}
