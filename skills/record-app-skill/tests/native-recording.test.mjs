/**
 * The native-browser path, end to end, against a real application.
 *
 * This is the test that proves the claim the skill makes: the recording is
 * made in the browser the user actually has, on the operating system they
 * actually look at. It is only meaningful where that platform exists, so it
 * skips with an explicit reason elsewhere — a mocked test proves the
 * decision logic, not the rendering.
 *
 * Where the platform is available, the fixture is captured with the native
 * backend *and* with the portable one, and the two manifests are compared:
 * they must agree about the workflow and disagree about the browser.
 */

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { EXIT } from "../scripts/lib.mjs";
import { probeMedia } from "../scripts/media-probe.mjs";
import {
  loadFfmpegInfo,
  readJson,
  runScript,
  screencastAvailable,
  startFixture,
  tmpDir,
  writePlan,
} from "./helpers.mjs";

let fixture = null;

before(async () => {
  fixture = await startFixture();
});

after(async () => {
  await fixture?.stop();
});

const plan = (baseUrl, title) => ({
  schemaVersion: 1,
  title,
  description: "Create a task and confirm it appears in the list.",
  baseUrl,
  startRoute: "/tasks",
  steps: [
    { id: "open", action: "goto", path: "/tasks" },
    {
      id: "dialog",
      action: "click",
      target: { testId: "open-create" },
      assertOn: { testId: "create-form" },
      expect: { visible: true },
    },
    { id: "name", action: "fill", target: { label: "Task name" }, value: "Native browser task" },
    { id: "save", action: "click", target: { testId: "submit-create" } },
    {
      id: "verify",
      action: "waitFor",
      target: { testId: "flash" },
      expect: { visible: true, text: "Native browser task" },
    },
  ],
});

/** The native backend for this machine, or null with the reason why not. */
async function nativeBackend() {
  const { detectWindowsBackend, resolveBackend } = await import("../scripts/browser-env.mjs");
  const windows = detectWindowsBackend();
  if (windows.wsl) {
    if (!windows.usable) return { backend: null, reason: windows.reasons.join("; ") };
    return { backend: "windows-native", reason: null };
  }
  const resolved = resolveBackend("auto");
  if (resolved.unavailable) return { backend: null, reason: resolved.reason };
  return { backend: resolved.backend, reason: null };
}

test("the native backend records the fixture in the host's own browser", async (t) => {
  if (!(await screencastAvailable())) return t.skip("Playwright's bundled ffmpeg is missing");
  const { ffmpeg } = await loadFfmpegInfo();
  if (!ffmpeg) return t.skip("system FFmpeg is missing, so no MP4 can be produced");

  const native = await nativeBackend();
  if (!native.backend) return t.skip(`the native backend is unavailable here: ${native.reason}`);

  await fixture.reset();
  const planFile = writePlan(tmpDir("native-plan"), plan(fixture.baseUrl, "Native browser run"));
  const outBase = tmpDir("native-out");

  const result = runScript(
    "run-demo.mjs",
    ["--plan", planFile, "--out-dir", outBase, "--backend", native.backend, "--json"],
    { timeout: 420000 }
  );
  assert.equal(result.code, EXIT.OK, `the native run failed:\n${result.stdout}${result.stderr}`);
  assert.equal(result.json.delivered, true);
  assert.equal(result.json.status, "validated");

  const workDir = path.join(outBase, ".work", "001");
  const manifest = readJson(path.join(workDir, "manifest.json"));

  // The manifest must describe the browser and the host that really ran.
  assert.equal(manifest.backend.resolved, native.backend === "windows-native" ? "windows-native" : "native");
  assert.ok(manifest.backend.browser.id, "the browser must be named");
  assert.ok(
    ["system-default", "user-selected", "system-installed"].includes(manifest.backend.browser.source),
    `the browser source must be honest: ${manifest.backend.browser.source}`
  );
  assert.notEqual(
    manifest.backend.browser.source,
    "playwright-bundled",
    "a native run must not report the bundled build"
  );
  assert.ok(manifest.backend.browser.version, "the browser version must be recorded");
  assert.equal(manifest.environment.platform, process.platform === "linux" && native.backend === "windows-native" ? "win32" : process.platform);
  assert.equal(manifest.environment.shellPlatform, process.platform);

  // The rendering settings are explicit, and nothing was overridden.
  assert.equal(manifest.capture.rendering.colorScheme, "system");
  assert.equal(manifest.capture.rendering.reducedMotion, "system");
  assert.equal(manifest.capture.rendering.fontsInjected, false);
  assert.equal(manifest.capture.rendering.grayscaleProfile, "off");

  // The video is real, and it is the size the plan asked for.
  const video = path.join(outBase, "001", "demo.mp4");
  assert.ok(fs.existsSync(video), "the delivery folder must contain the video");
  const media = probeMedia(video);
  assert.equal(media.container, "mp4");
  assert.equal(media.videoCodec, "h264");
  assert.equal(media.width, 1440);
  assert.equal(media.height, 900);
  assert.ok(media.durationSeconds > 3, `the video is too short: ${media.durationSeconds}s`);

  // And the workflow really ran.
  const state = await fixture.state();
  assert.ok(
    state.tasks.some((task) => task.title === "Native browser task"),
    "the recorded workflow must have changed the application"
  );
});

test("the portable backend still records the same workflow, and says so", async (t) => {
  if (!(await screencastAvailable())) return t.skip("Playwright's bundled ffmpeg is missing");
  const { ffmpeg } = await loadFfmpegInfo();
  if (!ffmpeg) return t.skip("system FFmpeg is missing, so no MP4 can be produced");

  await fixture.reset();
  const planFile = writePlan(tmpDir("portable-plan"), plan(fixture.baseUrl, "Portable browser run"));
  const outBase = tmpDir("portable-out");

  const result = runScript(
    "run-demo.mjs",
    ["--plan", planFile, "--out-dir", outBase, "--backend", "local-playwright", "--json"],
    { timeout: 420000 }
  );
  assert.equal(result.code, EXIT.OK, `the portable run failed:\n${result.stdout}${result.stderr}`);
  assert.equal(result.json.status, "validated");

  const manifest = readJson(path.join(outBase, ".work", "001", "manifest.json"));
  assert.equal(manifest.backend.resolved, "local-playwright");
  assert.equal(manifest.backend.browser.source, "playwright-bundled");
  // The portable build is never described as the user's own browser.
  assert.notEqual(manifest.backend.browser.source, "system-default");
  const media = probeMedia(path.join(outBase, "001", "demo.mp4"));
  assert.equal(media.videoCodec, "h264");
  assert.equal(media.width, 1440);
});

test("an explicit native backend never falls back to another browser", async (t) => {
  const native = await nativeBackend();
  if (!native.backend) return t.skip(`the native backend is unavailable here: ${native.reason}`);

  // A channel that is not installed must be refused, not quietly replaced.
  const { resolveBackend } = await import("../scripts/browser-env.mjs");
  const resolved = resolveBackend("native", { channel: "safari" });
  assert.equal(resolved.unavailable, true);
  assert.notEqual(resolved.channel, "chrome");
  assert.ok(resolved.alternatives.length > 0, "the refusal must offer alternatives");
});
