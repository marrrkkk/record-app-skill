/**
 * Delivery layout.
 *
 * Every demonstration is published into a numbered folder under `.video` in
 * the project directory:
 *
 *   .video/001/demo.mp4          the only file in the output folder
 *   .video/.work/001/            recording evidence and validation artifacts
 *
 * The numbered folder is what the skill hands to the user. Keeping the raw
 * recording, timeline, contact sheet and reports in a hidden sibling directory
 * means a delivery can be "just the video" without losing the evidence.
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_OUTPUT_DIR, QUALITY_PRESETS } from "./lib.mjs";

export const NUMBER_PAD = 3;
const NUMBERED_RE = /^\d{3,}$/;

/** Resolve a quality name, with a clear error for an unknown one. */
export function resolveQuality(name, fallback = "high") {
  const value = name ?? fallback;
  if (!QUALITY_PRESETS[value]) {
    throw new Error(
      `unknown quality "${value}"; use one of: ${Object.keys(QUALITY_PRESETS).join(", ")}`
    );
  }
  return { name: value, ...QUALITY_PRESETS[value] };
}

/** Absolute output base. Defaults to `<cwd>/.video`. */
export function resolveOutputBase(outDir, { cwd = process.cwd() } = {}) {
  return path.resolve(cwd, outDir ?? DEFAULT_OUTPUT_DIR);
}

/**
 * Encoder settings for a delivery.
 *
 * A quality chosen on the command line owns its CRF and preset. Without that
 * explicit choice the plan's own values win, because a plan may deliberately
 * override one field while keeping the named preset.
 */
export function resolveRenderSettings(plan, quality, { explicitQuality = false } = {}) {
  return {
    name: quality.name,
    crf: explicitQuality ? quality.crf : plan.media.crf,
    preset: explicitQuality ? quality.preset : plan.media.preset,
  };
}

function numberedNames(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && NUMBERED_RE.test(entry.name))
      .map((entry) => Number(entry.name))
      .filter((n) => Number.isSafeInteger(n));
  } catch {
    return [];
  }
}

/**
 * Allocate a fresh numbered output + work pair.
 *
 * Both folders share the same number. Allocation is atomic: the folder is
 * claimed with `mkdirSync`, which fails with `EEXIST` rather than overwriting,
 * and a number is only used when both sides can be claimed. A partially
 * claimed pair is removed before trying the next number.
 *
 * @returns {{number:number, name:string, outputDir:string, workDir:string}}
 */
export function allocateNumberedPair(baseDir, { cwd = process.cwd() } = {}) {
  const base = resolveOutputBase(baseDir, { cwd });
  const outputRoot = base;
  const workRoot = path.join(base, ".work");
  fs.mkdirSync(outputRoot, { recursive: true, mode: 0o755 });
  fs.mkdirSync(workRoot, { recursive: true, mode: 0o755 });

  let next = Math.max(0, ...numberedNames(outputRoot), ...numberedNames(workRoot)) + 1;

  for (;;) {
    const name = String(next).padStart(NUMBER_PAD, "0");
    const outputDir = path.join(outputRoot, name);
    const workDir = path.join(workRoot, name);
    let claimedOutput = false;
    let claimedWork = false;
    try {
      fs.mkdirSync(outputDir, { mode: 0o755 });
      claimedOutput = true;
      fs.mkdirSync(workDir, { mode: 0o755 });
      claimedWork = true;
      return { number: next, name, outputDir, workDir };
    } catch (err) {
      if (err.code !== "EEXIST") {
        // Leave no half-claimed pair behind if something other than a name
        // collision happened.
        if (claimedWork) fs.rmSync(workDir, { recursive: true, force: true });
        if (claimedOutput) fs.rmSync(outputDir, { recursive: true, force: true });
        throw err;
      }
      // Another process (or an orphaned work folder) owns this number.
      if (claimedWork) fs.rmSync(workDir, { recursive: true, force: true });
      if (claimedOutput) fs.rmSync(outputDir, { recursive: true, force: true });
      next += 1;
    }
  }
}

/** Claim a single numbered directory. Exposed for tooling and tests. */
export function allocateNumberedDir(rootDir) {
  fs.mkdirSync(rootDir, { recursive: true, mode: 0o755 });
  let next = Math.max(0, ...numberedNames(rootDir)) + 1;
  for (;;) {
    const name = String(next).padStart(NUMBER_PAD, "0");
    const dir = path.join(rootDir, name);
    try {
      fs.mkdirSync(dir, { mode: 0o755 });
      return { number: next, name, dir };
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      next += 1;
    }
  }
}

/**
 * Copy the finished video into the numbered output folder.
 *
 * The output folder is deliberately strict: it must be empty apart from the
 * video. If anything else was placed there, publishing stops rather than
 * shipping a folder whose contents nobody accounted for.
 */
export function finalizeDelivery({ workDir, outputDir, videoName = "demo.mp4" }) {
  const source = path.join(workDir, videoName);
  if (!fs.existsSync(source) || fs.statSync(source).size === 0) {
    throw new Error(`no finished video found at ${source}`);
  }

  fs.mkdirSync(outputDir, { recursive: true, mode: 0o755 });
  const existing = fs.readdirSync(outputDir).filter((name) => name !== videoName);
  if (existing.length > 0) {
    throw new Error(
      `output folder ${outputDir} must contain only the final video, but also contains: ${existing.join(", ")}`
    );
  }

  const target = path.join(outputDir, videoName);
  fs.copyFileSync(source, target);
  return {
    file: videoName,
    path: target,
    url: pathToFileURL(target).href,
    bytes: fs.statSync(target).size,
  };
}

/** Write the machine-readable delivery record next to the evidence. */
export function writeDeliveryRecord(workDir, delivery) {
  const file = path.join(workDir, "delivery.json");
  fs.writeFileSync(file, JSON.stringify(delivery, null, 2) + "\n", "utf8");
  return file;
}

/** Append the delivery block to the work report, never to the video folder. */
export function appendDeliveryReport(workDir, block) {
  const report = path.join(workDir, "report.md");
  if (!fs.existsSync(report)) return false;
  fs.appendFileSync(report, `\n## Delivery\n\n${block.trim()}\n`, "utf8");
  return true;
}

/**
 * The one output block a person should see at the end of a run.
 *
 * It always answers the same questions in the same order, so two demos can be
 * compared without re-reading a wall of logs.
 */
export function formatDeliveryBlock(delivery) {
  if (!delivery?.delivered) {
    const L = [];
    L.push(`Demo not delivered — ${delivery?.title ?? "workflow"}`);
    L.push("");
    L.push(`Status : ${delivery?.status ?? "recording-failed"}`);
    if (delivery?.reason) L.push(`Reason : ${delivery.reason}`);
    if (delivery?.workDir) L.push(`Evidence: ${path.join(delivery.workDir, "report.md")}`);
    L.push("");
    L.push("No video was placed in the output folder. The evidence explains why.");
    return L.join("\n");
  }

  const media = delivery.media ?? {};
  const quality = delivery.quality ?? {};
  const steps = delivery.steps ?? {};
  const assertions = delivery.assertions ?? {};
  const checks = delivery.checks ?? {};
  const L = [];
  L.push(`Demo ready — ${delivery.title ?? "workflow"}`);
  L.push("");
  L.push(`Video    : ${delivery.videoUrl}`);
  L.push(`Folder   : ${delivery.outputDir}`);
  L.push(`Status   : ${delivery.status}`);
  L.push(
    `Quality  : ${quality.name ?? "high"} (CRF ${quality.crf ?? "?"}, preset ${quality.preset ?? "?"}, ` +
      `${media.width ?? "?"}x${media.height ?? "?"}, ${media.fps ?? delivery.fps ?? "?"} fps)`
  );
  L.push(
    `Duration : ${media.durationSeconds != null ? `${media.durationSeconds.toFixed(1)}s` : "?"} · ` +
      `${media.sizeHuman ?? "?"}`
  );
  L.push(
    `Steps    : ${steps.ok ?? 0}/${steps.total ?? 0} ok` +
      (steps.failed ? `, ${steps.failed} failed` : "") +
      (steps.optionalFailed ? `, ${steps.optionalFailed} optional failed` : "") +
      ` · ${assertions.passed ?? 0}/${assertions.total ?? 0} assertions passed`
  );
  L.push(
    `Checks   : ${checks.passed ?? 0}/${checks.total ?? 0} passed` +
      (checks.warnings ? `, ${checks.warnings} warning(s)` : "")
  );
  if (delivery.browser) L.push(`Browser  : ${delivery.browser}`);
  if (delivery.app) L.push(`Build    : ${delivery.app}`);
  if (delivery.workDir) L.push(`Evidence : ${path.join(delivery.workDir, "report.md")}`);
  L.push("");
  L.push(
    delivery.status === "validated"
      ? "The workflow was verified against the live application and every validation check passed."
      : "The workflow was delivered with caveats; read the evidence before publishing."
  );
  return L.join("\n");
}
