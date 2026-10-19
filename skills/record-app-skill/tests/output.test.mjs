/**
 * Delivery layout tests.
 *
 * The promise is simple and strict: a numbered folder under `.video` contains
 * only the finished video, and the evidence lives in `.video/.work/<same n>`.
 * These tests exercise the filesystem helpers directly, so a regression shows
 * up without waiting for a full recording.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  allocateNumberedDir,
  allocateNumberedPair,
  finalizeDelivery,
  formatDeliveryBlock,
  resolveOutputBase,
  resolveQuality,
  resolveRenderSettings,
} from "../scripts/output.mjs";
import { tmpDir } from "./helpers.mjs";

test("output defaults to .video under the working directory", () => {
  const cwd = tmpDir("output-base");
  assert.equal(resolveOutputBase(null, { cwd }), path.join(cwd, ".video"));
  assert.equal(resolveOutputBase("clips", { cwd }), path.join(cwd, "clips"));
});

test("numbered output and work folders share a number and never overwrite", () => {
  const base = path.join(tmpDir("numbered"), ".video");
  const first = allocateNumberedPair(base);
  assert.equal(first.name, "001");
  assert.equal(path.basename(first.outputDir), "001");
  assert.equal(first.workDir, path.join(base, ".work", "001"));
  assert.ok(fs.existsSync(first.outputDir));
  assert.ok(fs.existsSync(first.workDir));

  fs.writeFileSync(path.join(first.workDir, "raw-recording.webm"), "evidence");
  const second = allocateNumberedPair(base);
  assert.equal(second.name, "002");
  assert.equal(fs.readFileSync(path.join(first.workDir, "raw-recording.webm"), "utf8"), "evidence");
});

test("a numbered folder is claimed atomically when one side already exists", () => {
  const base = path.join(tmpDir("orphan"), ".video");
  fs.mkdirSync(path.join(base, ".work", "001"), { recursive: true });
  const pair = allocateNumberedPair(base);
  assert.equal(pair.name, "002", "an orphaned work folder must not be reused");
  assert.ok(fs.existsSync(pair.outputDir));
});

test("allocateNumberedDir skips taken names", () => {
  const root = tmpDir("single-numbered");
  assert.equal(allocateNumberedDir(root).name, "001");
  assert.equal(allocateNumberedDir(root).name, "002");
});

test("delivery copies only the video and produces a file URL", () => {
  const base = tmpDir("deliver");
  const workDir = path.join(base, ".work", "001");
  const outputDir = path.join(base, "001");
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(workDir, "demo.mp4"), "fake mp4 bytes");
  fs.writeFileSync(path.join(workDir, "report.md"), "evidence");

  const video = finalizeDelivery({ workDir, outputDir });
  assert.deepEqual(fs.readdirSync(outputDir), ["demo.mp4"]);
  assert.equal(fs.readFileSync(path.join(outputDir, "demo.mp4"), "utf8"), "fake mp4 bytes");
  assert.match(video.url, /^file:\/\//);
  assert.equal(video.bytes, "fake mp4 bytes".length);
});

test("delivery refuses an output folder with unrelated files", () => {
  const base = tmpDir("deliver-conflict");
  const workDir = path.join(base, ".work", "001");
  const outputDir = path.join(base, "001");
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(workDir, "demo.mp4"), "video");
  fs.writeFileSync(path.join(outputDir, "notes.txt"), "not part of the deliverable");
  assert.throws(() => finalizeDelivery({ workDir, outputDir }), /only the final video/);
});

test("quality presets are named, bounded and reflected in the handoff block", () => {
  assert.deepEqual(resolveQuality("high"), { name: "high", crf: 18, preset: "slow" });
  assert.deepEqual(resolveQuality("balanced"), { name: "balanced", crf: 20, preset: "medium" });
  assert.deepEqual(resolveQuality("compact"), { name: "compact", crf: 23, preset: "medium" });
  assert.throws(() => resolveQuality("ultra"), /unknown quality/);

  const block = formatDeliveryBlock({
    delivered: true,
    title: "Create a task",
    status: "validated",
    videoUrl: "file:///tmp/.video/001/demo.mp4",
    outputDir: "/tmp/.video/001",
    workDir: "/tmp/.video/.work/001",
    quality: resolveQuality("high"),
    fps: 60,
    media: { width: 1280, height: 720, fps: 60, durationSeconds: 12.3, sizeHuman: "1.2 MiB" },
    steps: { total: 8, ok: 8, failed: 0, optionalFailed: 0 },
    assertions: { total: 5, passed: 5 },
    checks: { total: 30, passed: 30, warnings: 0 },
  });
  assert.match(block, /Demo ready — Create a task/);
  assert.match(block, /file:\/\/\/tmp\/\.video\/001\/demo\.mp4/);
  assert.match(block, /60 fps/);
  assert.match(block, /8\/8 ok/);
  assert.match(block, /every validation check passed/);

  const failed = formatDeliveryBlock({
    delivered: false,
    title: "Create a task",
    status: "verification-failed",
    reason: "step verify: text did not match",
    workDir: "/tmp/.video/.work/001",
  });
  assert.match(failed, /Demo not delivered/);
  assert.match(failed, /No video was placed in the output folder/);
});

test("an explicit quality selection owns its encoder settings", () => {
  const plan = { media: { crf: 18, preset: "slow" } };
  assert.deepEqual(resolveRenderSettings(plan, resolveQuality("compact"), { explicitQuality: true }), {
    name: "compact",
    crf: 23,
    preset: "medium",
  });
  assert.deepEqual(resolveRenderSettings(plan, resolveQuality("high")), {
    name: "high",
    crf: 18,
    preset: "slow",
  }, "without an explicit choice the plan's own settings win");

  const custom = { media: { crf: 16, preset: "veryslow" } };
  assert.deepEqual(resolveRenderSettings(custom, resolveQuality("high")), {
    name: "high",
    crf: 16,
    preset: "veryslow",
  });
});
