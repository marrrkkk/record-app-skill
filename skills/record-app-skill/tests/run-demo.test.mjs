/**
 * The one-command delivery contract.
 *
 * `run-demo.mjs` is the path an agent is told to use, so the promise is tested
 * end to end against a real app: the numbered folder contains *only* the
 * finished video, the evidence stays in `.video/.work/<n>`, captions are not
 * invented, and the handoff block points at a file that really decodes.
 */

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
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

const listDir = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);

test("run-demo publishes only demo.mp4 and keeps the evidence in .work", async (t) => {
  if (!(await screencastAvailable())) return t.skip("Playwright's bundled ffmpeg is missing");
  const { ffmpeg } = await loadFfmpegInfo();
  if (!ffmpeg) return t.skip("system FFmpeg is missing, so no MP4 can be produced");

  await fixture.reset();
  const planFile = writePlan(
    tmpDir("deliver-plan"),
    {
      schemaVersion: 1,
      title: "Deliver a task",
      description: "Create a task and verify it appears in the list.",
      baseUrl: fixture.baseUrl,
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
        { id: "name", action: "fill", target: { label: "Task name" }, value: "Publish the demo" },
        { id: "priority", action: "select", target: { label: "Priority" }, value: "high" },
        { id: "save", action: "click", target: { testId: "submit-create" } },
        {
          id: "verify",
          action: "waitFor",
          target: { testId: "flash" },
          expect: { visible: true, text: "Publish the demo" },
        },
        {
          id: "listed",
          action: "assert",
          target: { text: "Publish the demo", exact: true },
          expect: { count: 1 },
        },
      ],
    }
  );

  // No --out-dir: the default layout is `.video` under the working directory.
  const project = tmpDir("delivery-project");
  const result = runScript(
    "run-demo.mjs",
    ["--plan", planFile, "--backend", "local-playwright", "--json"],
    { cwd: project, timeout: 360000 }
  );
  assert.equal(result.code, EXIT.OK, `run-demo failed:\n${result.stdout}${result.stderr}`);
  assert.equal(result.json.ok, true);
  assert.equal(result.json.delivered, true);
  assert.equal(result.json.status, "validated");

  const base = path.join(project, ".video");
  assert.ok(fs.existsSync(base), "the default .video directory must be created");
  const outputDir = path.join(base, "001");
  const workDir = path.join(base, ".work", "001");
  assert.equal(result.json.outputDir, outputDir);
  assert.equal(result.json.workDir, workDir);
  assert.deepEqual(listDir(outputDir), ["demo.mp4"], "the delivery folder contains only the video");
  assert.ok(!fs.existsSync(path.join(outputDir, "delivery.json")), "the record belongs in the work folder");

  // Evidence is complete and captions are absent unless the plan asked for them.
  for (const name of [
    "demo.mp4",
    "raw-recording.webm",
    "storyboard.md",
    "workflow.json",
    "timeline.json",
    "contact-sheet.png",
    "contact-sheet.json",
    "manifest.json",
    "validation.json",
    "delivery.json",
    "report.md",
  ]) {
    assert.ok(fs.existsSync(path.join(workDir, name)), `missing evidence: ${name}`);
  }
  assert.ok(!fs.existsSync(path.join(workDir, "captions.srt")), "captions must be off by default");

  const videoPath = path.join(outputDir, "demo.mp4");
  const delivery = readJson(path.join(workDir, "delivery.json"));
  assert.equal(delivery.videoPath, videoPath);
  assert.equal(delivery.videoUrl, pathToFileURL(videoPath).href);
  assert.equal(delivery.quality.name, "high");
  assert.equal(delivery.fps, 60);
  assert.equal(delivery.media.hasAudio, false);
  assert.equal(delivery.checks.failed, 0);
  assert.equal(delivery.steps.failed, 0);
  assert.equal(delivery.assertions.passed, delivery.assertions.total);

  const media = probeMedia(videoPath);
  assert.equal(media.container, "mp4");
  assert.equal(media.videoCodec, "h264");
  assert.equal(media.fps, 60);
  assert.equal(media.hasAudio, false);
  assert.ok(media.durationSeconds > 3, `video too short: ${media.durationSeconds}s`);

  const report = fs.readFileSync(path.join(workDir, "report.md"), "utf8");
  assert.match(report, /## Delivery/);
  assert.ok(report.includes(pathToFileURL(videoPath).href), "the report must name the delivered file");

  assert.match(result.json.block, /Demo ready — Deliver a task/);
  assert.ok(result.json.block.includes(pathToFileURL(videoPath).href));

  const state = await fixture.state();
  assert.ok(
    state.tasks.some((task) => task.title === "Publish the demo" && task.priority === "high"),
    "the delivered video must describe a workflow that really ran"
  );

  // The recorded duration is the time the video covers, not the time the
  // encoder spent flushing the file afterwards. On a loaded machine the flush
  // takes seconds, and counting it would make a correct take look truncated.
  const timeline = readJson(path.join(workDir, "timeline.json"));
  assert.ok(
    Math.abs(timeline.captureDurationMs / 1000 - media.durationSeconds) < 1.5,
    `the timeline (${(timeline.captureDurationMs / 1000).toFixed(1)}s) must match the video (${media.durationSeconds}s)`
  );
  assert.equal(typeof timeline.captureTeardownMs, "number");
  assert.equal(typeof timeline.captureSetupMs, "number");
});

test("run-demo records against a production build, not a development server", async (t) => {
  if (!(await screencastAvailable())) return t.skip("Playwright's bundled ffmpeg is missing");
  const { ffmpeg } = await loadFfmpegInfo();
  if (!ffmpeg) return t.skip("system FFmpeg is missing, so no MP4 can be produced");

  // A tiny application with a real build step and a real server, so the
  // production path is exercised end to end rather than mocked.
  const app = tmpDir("production-app");
  const port = 45319;
  fs.writeFileSync(
    path.join(app, "package.json"),
    `${JSON.stringify(
      {
        name: "production-app",
        version: "1.0.0",
        private: true,
        scripts: { build: "node build.mjs", preview: "node serve.mjs" },
      },
      null,
      2
    )}\n`
  );
  fs.writeFileSync(
    path.join(app, "build.mjs"),
    [
      'import fs from "node:fs";',
      'fs.mkdirSync("dist", { recursive: true });',
      'fs.writeFileSync("dist/index.html", "<h1 data-testid=\\"title\\">Production build</h1>");',
      'console.log("built");',
      "",
    ].join("\n")
  );
  fs.writeFileSync(
    path.join(app, "serve.mjs"),
    [
      'import http from "node:http";',
      'import fs from "node:fs";',
      `const port = ${port};`,
      'http.createServer((req, res) => {',
      '  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });',
      '  res.end(fs.readFileSync("dist/index.html"));',
      '}).listen(port, "127.0.0.1");',
      "",
    ].join("\n")
  );

  const planFile = writePlan(app, {
    schemaVersion: 1,
    title: "Production build",
    baseUrl: `http://127.0.0.1:${port}`,
    startRoute: "/",
    steps: [{ id: "title", action: "assert", target: { testId: "title" }, expect: { visible: true, text: "Production build" } }],
  });

  const base = tmpDir("production-delivery");
  const result = runScript(
    "run-demo.mjs",
    [
      "--plan",
      planFile,
      "--out-dir",
      base,
      "--backend",
      "local-playwright",
      "--production",
      "--app-root",
      app,
      "--serve-url",
      `http://127.0.0.1:${port}`,
      "--json",
    ],
    { timeout: 240000 }
  );
  assert.equal(result.code, EXIT.OK, `run-demo failed:\n${result.stdout}${result.stderr}`);
  assert.equal(result.json.status, "validated");
  assert.ok(fs.existsSync(path.join(app, "dist", "index.html")), "the production build must have run");

  const workDir = path.join(base, ".work", "001");
  const manifest = readJson(path.join(workDir, "manifest.json"));
  assert.equal(manifest.app.mode, "production");
  assert.equal(manifest.app.build.ok, true);
  assert.equal(manifest.app.serve.ok, true);
  assert.match(manifest.app.build.command, /build/);
  assert.match(result.json.block, /Build\s+: production/);
});

test("run-demo reports a failed workflow honestly and publishes no video", async (t) => {
  if (!(await screencastAvailable())) return t.skip("Playwright's bundled ffmpeg is missing");

  await fixture.reset();
  const planFile = writePlan(
    tmpDir("failed-plan"),
    {
      schemaVersion: 1,
      title: "Fail honestly",
      baseUrl: fixture.baseUrl,
      startRoute: "/tasks",
      steps: [
        { id: "open", action: "goto", path: "/tasks" },
        {
          id: "missing",
          action: "assert",
          target: { text: "This text is not on the page" },
          expect: { count: 1 },
        },
      ],
    }
  );

  const base = tmpDir("failed-delivery");
  const result = runScript(
    "run-demo.mjs",
    ["--plan", planFile, "--out-dir", base, "--backend", "local-playwright", "--json"],
    { timeout: 180000 }
  );
  assert.equal(result.code, EXIT.WORKFLOW_FAILED, `expected an honest failure:\n${result.stdout}${result.stderr}`);
  assert.equal(result.json.delivered, false);
  assert.equal(result.json.status, "verification-failed");
  assert.match(result.json.reason, /missing/);
  assert.ok(!fs.existsSync(path.join(base, "001")), "a failed run must not publish a numbered folder");
  assert.match(result.json.block, /Demo not delivered/);
  assert.match(result.json.block, /verification-failed/);

  const workDir = path.join(base, ".work", "001");
  assert.ok(fs.existsSync(path.join(workDir, "report.md")), "the failure must leave evidence");
  assert.ok(fs.existsSync(path.join(workDir, "timeline.json")));
  assert.ok(!fs.existsSync(path.join(workDir, "demo.mp4")), "no video may be delivered for a failed workflow");
});
