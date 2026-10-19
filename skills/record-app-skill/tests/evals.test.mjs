/**
 * Acceptance scenarios.
 *
 * These are the eight cases a workflow-recording tool must get right, driven
 * end to end against the bundled fixture application with real subprocesses:
 *
 *   1. a simple workflow records, renders to a valid MP4 and validates
 *   2. a longer multi-step workflow is verified, not just performed
 *   3. an auth-required route is handled safely and never leaks credentials
 *   4. a broken selector or assertion is never reported as success
 *   5. a missing application produces remediation, not a fake recording
 *   6. a missing system FFmpeg never yields a claimed MP4
 *   7. an existing output directory is never destroyed
 *   8. an externally consequential action is blocked until authorized
 *
 * Every assertion here is about observable artifacts on disk or real
 * application state — never about what a log line said.
 */

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { EXIT, scanArtifactsForSecrets } from "../scripts/lib.mjs";
import { probeMedia } from "../scripts/media-probe.mjs";
import {
  closedPort,
  loadFfmpegInfo,
  readJson,
  runScript,
  screencastAvailable,
  startFixture,
  tmpDir,
  writePlan,
} from "./helpers.mjs";

/* ------------------------------------------------------------------ */
/* Shared fixture                                                      */
/* ------------------------------------------------------------------ */

let fixture = null;

before(async () => {
  fixture = await startFixture();
});

after(async () => {
  await fixture?.stop();
});

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Record a plan and return the parsed summary plus the run directory. */
function record(plan, { outDir, args = [], timeout = 240000 } = {}) {
  const dir = tmpDir("plan");
  const file = writePlan(dir, plan);
  const base = outDir ?? tmpDir("out");
  const result = runScript(
    "record-workflow.mjs",
    ["--plan", file, "--out-dir", base, "--backend", "local-playwright", "--json", ...args],
    { timeout }
  );
  return { ...result, outBase: base, runDir: result.json?.runDir ?? null, planFile: file };
}

function renderAndValidate(runDir) {
  const render = runScript("render-video.mjs", ["--run-dir", runDir, "--json"], { timeout: 300000 });
  const sheet = runScript("build-contact-sheet.mjs", ["--run-dir", runDir, "--json"], { timeout: 180000 });
  const validate = runScript(
    "validate-video.mjs",
    ["--run-dir", runDir, "--require-contact-sheet", "--json"],
    { timeout: 300000 }
  );
  return { render, sheet, validate };
}

const listDir = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);

/** A short workflow that really creates a task in the fixture. */
const taskPlan = (baseUrl, overrides = {}) => ({
  schemaVersion: 1,
  title: "Create a task",
  description: "Add a task and verify it appears in the list.",
  baseUrl,
  startRoute: "/tasks",
  steps: [
    { id: "open", action: "goto", path: "/tasks" },
    { id: "intro", action: "caption", text: "Adding a task to the queue", durationMs: 1200 },
    {
      id: "dialog",
      action: "click",
      target: { testId: "open-create" },
      assertOn: { testId: "create-form" },
      expect: { visible: true },
    },
    { id: "name", action: "fill", target: { label: "Task name" }, value: "Draft the launch note" },
    // The task dialog's option values are lowercase; the project form's are not.
    { id: "priority", action: "select", target: { label: "Priority" }, value: "high" },
    { id: "save", action: "click", target: { testId: "submit-create" } },
    {
      id: "verify",
      action: "waitFor",
      target: { testId: "flash" },
      expect: { visible: true, text: "Draft the launch note" },
    },
    {
      id: "listed",
      action: "assert",
      target: { text: "Draft the launch note", exact: true },
      expect: { count: 1 },
    },
    { id: "chapter", action: "checkpoint", title: "Task created", description: "The task is in the list." },
  ],
  ...overrides,
});

/* ------------------------------------------------------------------ */
/* 1. Simple workflow -> valid MP4                                     */
/* ------------------------------------------------------------------ */

test("1. a simple workflow records, renders to a valid MP4 and validates", async (t) => {
  if (!(await screencastAvailable())) return t.skip("Playwright's bundled ffmpeg is missing");
  const { ffmpeg } = await loadFfmpegInfo();
  if (!ffmpeg) return t.skip("system FFmpeg is missing, so no MP4 can be produced");

  await fixture.reset();
  const result = record(taskPlan(fixture.baseUrl), { args: ["--run-name", "eval-simple"] });
  assert.equal(result.code, EXIT.OK, `recording failed:\n${result.stdout}${result.stderr}`);
  assert.equal(result.json.ok, true);
  assert.equal(result.json.stepsFailed, 0);

  const runDir = result.runDir;
  assert.ok(fs.existsSync(runDir), "the run directory must exist");

  const raw = path.join(runDir, "raw-recording.webm");
  assert.ok(fs.existsSync(raw), "the raw recording must be preserved");
  const rawProbe = probeMedia(raw);
  assert.equal(rawProbe.container, "webm");
  assert.equal(rawProbe.videoCodec, "vp9");
  assert.equal(rawProbe.width, 1440);
  assert.equal(rawProbe.height, 900);

  const { render, sheet, validate } = renderAndValidate(runDir);
  assert.equal(render.code, EXIT.OK, `render failed:\n${render.stdout}${render.stderr}`);
  assert.equal(sheet.code, EXIT.OK, `contact sheet failed:\n${sheet.stdout}${sheet.stderr}`);
  assert.equal(validate.code, EXIT.OK, `validation failed:\n${validate.stdout}${validate.stderr}`);

  const mp4 = path.join(runDir, "demo.mp4");
  assert.ok(fs.existsSync(mp4), "demo.mp4 must exist");
  const probed = probeMedia(mp4);
  assert.equal(probed.container, "mp4");
  assert.equal(probed.videoCodec, "h264");
  assert.equal(probed.width, 1440);
  assert.equal(probed.height, 900);
  assert.equal(probed.fps, 60);
  assert.equal(probed.hasAudio, false, "the demo must not carry an unintended audio track");
  assert.ok(probed.durationSeconds > 3, `demo too short: ${probed.durationSeconds}s`);

  const validation = readJson(path.join(runDir, "validation.json"));
  assert.equal(validation.status, "validated");
  assert.equal(validation.exitCode, 0);
  assert.equal(validation.counts.failed, 0);
  assert.ok(validation.counts.total >= 25, `only ${validation.counts.total} checks ran`);
  assert.equal(validation.media.width, 1440, "validation must describe the real video");
  assert.equal(validation.media.hasAudio, false);

  // The advertised artifacts are all really there.
  for (const name of [
    "demo.mp4",
    "raw-recording.webm",
    "storyboard.md",
    "workflow.json",
    "timeline.json",
    "captions.srt",
    "contact-sheet.png",
    "manifest.json",
    "validation.json",
    "report.md",
  ]) {
    assert.ok(fs.existsSync(path.join(runDir, name)), `missing artifact: ${name}`);
  }

  // The application really changed.
  const state = await fixture.state();
  const created = state.tasks.find((x) => x.title === "Draft the launch note");
  assert.ok(created, "the workflow must have created the task");
  assert.equal(created.priority, "high", "the dropdown choice must have reached the app");
});

/* ------------------------------------------------------------------ */
/* 2. Longer multi-step workflow with verification                     */
/* ------------------------------------------------------------------ */

test("2. a multi-step workflow is verified against the real result", async (t) => {
  if (!(await screencastAvailable())) return t.skip("Playwright's bundled ffmpeg is missing");
  await fixture.reset();

  const plan = {
    schemaVersion: 1,
    title: "Create a project",
    baseUrl: fixture.baseUrl,
    startRoute: "/projects",
    steps: [
      { id: "open", action: "goto", path: "/projects" },
      { id: "name", action: "fill", target: { label: "Project name" }, value: "Atlas migration" },
      { id: "owner", action: "fill", target: { label: "Owner" }, value: "Ada Lovelace" },
      { id: "priority", action: "select", target: { label: "Priority" }, value: "High" },
      {
        id: "description",
        action: "fill",
        target: { label: "Description" },
        value: "Move the reporting stack to the new cluster.",
      },
      { id: "submit", action: "click", target: { testId: "create-project" } },
      {
        id: "landed",
        action: "waitFor",
        target: { testId: "project-name" },
        expect: { visible: true, text: "Atlas migration" },
      },
      { id: "check-owner", action: "assert", target: { testId: "project-owner" }, expect: { text: "Ada Lovelace" } },
      { id: "check-priority", action: "assert", target: { testId: "project-priority" }, expect: { text: "High" } },
      {
        id: "check-description",
        action: "assert",
        target: { testId: "project-description" },
        expect: { text: "Move the reporting stack" },
      },
      { id: "chapter", action: "checkpoint", title: "Project dashboard", description: "Every field was verified." },
    ],
  };

  const result = record(plan, { args: ["--run-name", "eval-multistep"] });
  assert.equal(result.code, EXIT.OK, `recording failed:\n${result.stdout}${result.stderr}`);

  const runDir = result.runDir;
  const workflow = readJson(path.join(runDir, "workflow.json"));
  const timeline = readJson(path.join(runDir, "timeline.json"));

  assert.equal(timeline.status, "recorded");
  assert.equal(timeline.steps.length, plan.steps.length, "every step must appear in the timeline");
  assert.deepEqual(
    timeline.steps.map((s) => s.id),
    plan.steps.map((s) => s.id),
    "step ids in the timeline must match the plan, in order"
  );
  assert.ok(
    timeline.steps.every((s) => s.status === "ok"),
    `timeline has failures: ${timeline.steps.filter((s) => s.status !== "ok").map((s) => s.id).join(", ")}`
  );

  // The verification steps must have run real assertions...
  const asserted = timeline.steps.filter((s) => s.assertion);
  assert.ok(asserted.length >= 4, `expected several real assertions, found ${asserted.length}`);
  assert.ok(
    asserted.every((s) => s.assertion.passed === true),
    "every recorded assertion must have passed"
  );
  // ...and each assertion must say what it checked.
  for (const step of asserted) {
    assert.ok(step.assertion.checks?.length > 0, `assertion on ${step.id} ran no checks`);
    for (const check of step.assertion.checks) {
      assert.ok(check.kind, `a check on ${step.id} has no kind`);
      assert.ok(check.detail, `a ${check.kind} check on ${step.id} has no detail`);
    }
  }

  // ...and the application state must match, independently of the browser.
  const state = await fixture.state();
  const project = state.projects.find((p) => p.name === "Atlas migration");
  assert.ok(project, "the project must exist server-side");
  assert.equal(project.owner, "Ada Lovelace");
  assert.equal(project.priority, "High");
  assert.match(project.description, /reporting stack/);
  assert.ok(workflow.steps.length === plan.steps.length, "workflow.json must record the executed plan");
});

/* ------------------------------------------------------------------ */
/* 3. Auth-required route                                              */
/* ------------------------------------------------------------------ */

test("3. an auth-required route is handled safely and leaks no credentials", async (t) => {
  if (!(await screencastAvailable())) return t.skip("Playwright's bundled ffmpeg is missing");
  await fixture.reset();

  // (a) Without a session the private route fails honestly: the recording is
  //     kept, the failure names the step, and nothing claims the page was read.
  const blocked = record(
    {
      schemaVersion: 1,
      title: "Read the private notes",
      baseUrl: fixture.baseUrl,
      steps: [
        { id: "private", action: "goto", path: "/private" },
        { id: "notes", action: "assert", target: { testId: "private-note" }, expect: { visible: true } },
      ],
    },
    { args: ["--run-name", "eval-auth"] }
  );
  assert.equal(blocked.code, EXIT.WORKFLOW_FAILED, `expected an honest failure:\n${blocked.stdout}${blocked.stderr}`);
  assert.equal(blocked.json.status, "workflow-failed");
  assert.equal(blocked.json.failure.stepId, "notes", "the failure must name the step that did not hold");
  assert.ok(fs.existsSync(path.join(blocked.runDir, "raw-recording.webm")), "a failed run still keeps its evidence");
  assert.ok(!fs.existsSync(path.join(blocked.runDir, "demo.mp4")), "a failed workflow must not yield a finished video");
  const report = fs.readFileSync(path.join(blocked.runDir, "report.md"), "utf8");
  assert.match(report, /failed/i, "the report must say the workflow failed");

  // (b) Manual sign-in needs a terminal. A non-interactive run is refused up
  //     front rather than hanging or recording a sign-in page.
  const manual = record(
    {
      schemaVersion: 1,
      title: "Sign in by hand",
      baseUrl: fixture.baseUrl,
      auth: { mode: "manual" },
      steps: [{ id: "private", action: "goto", path: "/private" }],
    },
    { args: ["--run-name", "eval-manual-auth"] }
  );
  assert.equal(manual.code, EXIT.INVALID_PLAN, `expected a safe refusal:\n${manual.stdout}${manual.stderr}`);
  assert.match(String(manual.json?.error ?? ""), /not a terminal/i);
  assert.match(String(manual.json?.error ?? ""), /storage-state/, "the refusal must offer the non-interactive path");
  assert.ok(!fs.existsSync(path.join(manual.runDir, "demo.mp4")));
  // The refusal is written down, so the run directory explains itself.
  const manualReport = fs.readFileSync(path.join(manual.runDir, "report.md"), "utf8");
  assert.match(manualReport, /not a terminal/i);

  // (c) Neither run's artifacts contain a credential or a session value.
  for (const dir of [blocked.runDir, manual.runDir]) {
    const findings = scanArtifactsForSecrets(dir);
    assert.deepEqual(findings, [], `secret-like content in ${dir}: ${JSON.stringify(findings, null, 2)}`);
  }
});

/* ------------------------------------------------------------------ */
/* 4. Honest failure                                                   */
/* ------------------------------------------------------------------ */

test("4. a broken selector or a failed assertion is never reported as success", async (t) => {
  if (!(await screencastAvailable())) return t.skip("Playwright's bundled ffmpeg is missing");
  await fixture.reset();

  // (a) A selector that does not exist.
  const missing = record({
    schemaVersion: 1,
    title: "Click something that is not there",
    baseUrl: fixture.baseUrl,
    steps: [
      { id: "open", action: "goto", path: "/tasks" },
      { id: "ghost", action: "click", target: { testId: "does-not-exist" } },
    ],
  });
  assert.equal(missing.code, EXIT.WORKFLOW_FAILED, `a missing element must fail:\n${missing.stdout}${missing.stderr}`);
  assert.equal(missing.json.ok, false);
  assert.equal(missing.json.failure.stepId, "ghost");
  assert.ok(missing.json.rawBytes > 0, "the partial recording is still available for diagnosis");
  assert.ok(!fs.existsSync(path.join(missing.runDir, "demo.mp4")), "no finished video may be produced");

  // (b) An assertion that does not hold, on an element that does exist.
  const wrong = record({
    schemaVersion: 1,
    title: "Assert something untrue",
    baseUrl: fixture.baseUrl,
    steps: [
      { id: "open", action: "goto", path: "/tasks" },
      {
        id: "claim",
        action: "assert",
        target: { testId: "flash" },
        expect: { visible: true, text: "This text is not on the page" },
      },
    ],
  });
  assert.equal(wrong.code, EXIT.WORKFLOW_FAILED, `a false assertion must fail:\n${wrong.stdout}${wrong.stderr}`);
  assert.equal(wrong.json.failure.stepId, "claim");
  const timeline = readJson(path.join(wrong.runDir, "timeline.json"));
  const claim = timeline.steps.find((s) => s.id === "claim");
  assert.equal(claim.assertion.passed, false, "the recorded assertion must say it failed");
  assert.ok(
    claim.assertion.checks.some((c) => c.passed === false),
    "at least one check must be recorded as failed"
  );

  // (c) Validation must not bless a run that never produced a video.
  for (const dir of [missing.runDir, wrong.runDir]) {
    const validate = runScript("validate-video.mjs", ["--run-dir", dir, "--json"]);
    assert.notEqual(validate.code, EXIT.OK, "a failed run cannot validate");
    const validation = readJson(path.join(dir, "validation.json"));
    assert.notEqual(validation.status, "validated", `validation.json claims success for ${dir}`);
    assert.notEqual(validation.exitCode, 0);
  }
});

/* ------------------------------------------------------------------ */
/* 5. Missing application                                              */
/* ------------------------------------------------------------------ */

test("5. a missing application produces remediation, not a recording", async (t) => {
  if (!(await screencastAvailable())) return t.skip("Playwright's bundled ffmpeg is missing");
  const port = await closedPort();
  const baseUrl = `http://127.0.0.1:${port}`;

  const result = record({
    schemaVersion: 1,
    title: "Reach an application that is not running",
    baseUrl,
    steps: [{ id: "open", action: "goto", path: "/" }],
  });
  assert.equal(result.code, EXIT.ENVIRONMENT_FAILED, `expected an environment failure:\n${result.stdout}${result.stderr}`);
  assert.ok(!fs.existsSync(path.join(result.runDir, "demo.mp4")));
  assert.ok(!fs.existsSync(path.join(result.runDir, "raw-recording.webm")), "nothing was recorded, so nothing may exist");

  // The directory exists only to explain the failure, and it must be actionable.
  const manifest = readJson(path.join(result.runDir, "manifest.json"));
  assert.equal(manifest.status, "environment-failed");
  assert.equal(manifest.exitCode, EXIT.ENVIRONMENT_FAILED);
  const report = fs.readFileSync(path.join(result.runDir, "report.md"), "utf8");
  assert.match(report, new RegExp(`127\\.0\\.0\\.1:${port}`), "the report must name the address that was tried");
  assert.match(report, /start/i, "the report must tell the reader to start the application");
  assert.deepEqual(scanArtifactsForSecrets(result.runDir), []);
});

/* ------------------------------------------------------------------ */
/* 6. Missing FFmpeg                                                   */
/* ------------------------------------------------------------------ */

test("6. a missing system FFmpeg never yields a claimed MP4", async (t) => {
  if (!(await screencastAvailable())) return t.skip("Playwright's bundled ffmpeg is missing");
  await fixture.reset();

  const rec = record({
    schemaVersion: 1,
    title: "Record without an encoder",
    baseUrl: fixture.baseUrl,
    steps: [
      { id: "open", action: "goto", path: "/tasks" },
      { id: "list", action: "assert", target: { testId: "task-list" }, expect: { visible: true } },
    ],
  });
  assert.equal(rec.code, EXIT.OK, `recording failed:\n${rec.stdout}${rec.stderr}`);
  const runDir = rec.runDir;
  assert.ok(fs.existsSync(path.join(runDir, "raw-recording.webm")));

  // Rendering with no usable encoder must fail loudly and change nothing.
  const render = runScript("render-video.mjs", ["--run-dir", runDir, "--ffmpeg", "/nonexistent/ffmpeg", "--json"]);
  assert.equal(render.code, EXIT.MISSING_DEPENDENCY, `expected a missing-dependency exit:\n${render.stdout}${render.stderr}`);
  assert.ok(!fs.existsSync(path.join(runDir, "demo.mp4")), "no MP4 may be claimed without an encoder");
  const rawBefore = fs.statSync(path.join(runDir, "raw-recording.webm")).size;
  assert.ok(rawBefore > 0, "the raw recording must be preserved for a later render");

  // And validation of that run must not report success.
  const validate = runScript("validate-video.mjs", ["--run-dir", runDir, "--json"]);
  assert.notEqual(validate.code, EXIT.OK);
  const validation = readJson(path.join(runDir, "validation.json"));
  assert.notEqual(validation.status, "validated");
  assert.ok(
    validation.failedChecks.length > 0 || validation.counts.failed > 0,
    "the missing video must show up as a failed check"
  );
  assert.ok(!fs.existsSync(path.join(runDir, "demo.mp4")));

  // The manifest records what actually exists rather than what was planned.
  const manifest = readJson(path.join(runDir, "manifest.json"));
  const named = Object.values(manifest.files ?? {}).filter(Boolean);
  assert.ok(!named.includes("demo.mp4"), "the manifest must not advertise an MP4 that does not exist");
  assert.ok(named.includes("raw-recording.webm"), "the manifest must still point at the preserved raw recording");
});

/* ------------------------------------------------------------------ */
/* 7. Output directories are never destroyed                           */
/* ------------------------------------------------------------------ */

test("7. an existing output directory is never destroyed or overwritten", async (t) => {
  if (!(await screencastAvailable())) return t.skip("Playwright's bundled ffmpeg is missing");
  await fixture.reset();

  const shortPlan = {
    schemaVersion: 1,
    title: "Short run into a full directory",
    baseUrl: fixture.baseUrl,
    steps: [
      { id: "open", action: "goto", path: "/tasks" },
      { id: "list", action: "assert", target: { testId: "task-list" }, expect: { visible: true } },
    ],
  };

  // (a) --run-dir is used exactly, and nothing already in it is touched.
  const dir = tmpDir("existing");
  fs.writeFileSync(path.join(dir, "keep-me.txt"), "do not delete");
  fs.writeFileSync(path.join(dir, "notes.md"), "hand-written notes about this run");
  const rec = record(shortPlan, { args: ["--run-dir", dir] });
  assert.equal(rec.code, EXIT.OK, `recording into an existing directory failed:\n${rec.stdout}${rec.stderr}`);
  for (const name of ["timeline.json", "workflow.json", "manifest.json", "raw-recording.webm"]) {
    assert.ok(fs.existsSync(path.join(dir, name)), `the run must be written into the existing directory: ${name}`);
  }
  assert.equal(fs.readFileSync(path.join(dir, "keep-me.txt"), "utf8"), "do not delete");
  assert.equal(fs.readFileSync(path.join(dir, "notes.md"), "utf8"), "hand-written notes about this run");

  // (b) Rendering must refuse to replace a finished video.
  const sentinel = Buffer.from("not an mp4, and not ours to delete");
  fs.writeFileSync(path.join(dir, "demo.mp4"), sentinel);
  const render = runScript("render-video.mjs", ["--run-dir", dir, "--json"]);
  assert.equal(render.code, EXIT.OUTPUT_CONFLICT, `expected an output conflict:\n${render.stdout}${render.stderr}`);
  assert.deepEqual(fs.readFileSync(path.join(dir, "demo.mp4")), sentinel, "the existing file must be byte-for-byte intact");
  assert.match(`${render.stdout}${render.stderr}`, /--force/, "the conflict must say how to proceed deliberately");

  // (c) Two runs under the same name never share a directory. (Same-second
  //     collisions are covered by resolveRunDir's unit tests; this proves the
  //     CLI-level behaviour on a real pair of runs.)
  const outBase = tmpDir("out");
  const first = record(shortPlan, { outDir: outBase, args: ["--run-name", "same-name"] });
  const second = record(shortPlan, { outDir: outBase, args: ["--run-name", "same-name"] });
  assert.equal(first.code, EXIT.OK);
  assert.equal(second.code, EXIT.OK);
  assert.notEqual(first.runDir, second.runDir, "a second run must not reuse the first run's directory");
  assert.ok(fs.existsSync(path.join(first.runDir, "timeline.json")));
  assert.ok(fs.existsSync(path.join(second.runDir, "timeline.json")));
});

/* ------------------------------------------------------------------ */
/* 8. Externally consequential actions                                 */
/* ------------------------------------------------------------------ */

test("8. an externally consequential action is blocked until it is authorized", async (t) => {
  if (!(await screencastAvailable())) return t.skip("Playwright's bundled ffmpeg is missing");
  await fixture.reset();
  const project = await fixture.createProject({ name: "Doomed project", owner: "Ada Lovelace" });

  const deletePlan = (extra = {}) => ({
    schemaVersion: 1,
    title: "Delete a project",
    baseUrl: fixture.baseUrl,
    steps: [
      { id: "dashboard", action: "goto", path: `/projects/${project.id}` },
      {
        id: "delete",
        action: "click",
        target: { testId: "delete-project" },
        assertOn: { testId: "projects-empty" },
        expect: { visible: true },
      },
    ],
    ...extra,
  });

  // (a) A plan cannot authorize itself: validation rejects the destructive step.
  const planFile = writePlan(tmpDir("plan"), deletePlan());
  const validate = runScript("validate-plan.mjs", ["--plan", planFile, "--json"]);
  assert.equal(validate.code, EXIT.INVALID_PLAN, `validate-plan must refuse:\n${validate.stdout}${validate.stderr}`);
  assert.match(`${validate.stdout}${validate.stderr}`, /consequential/i);
  assert.match(`${validate.stdout}${validate.stderr}`, /allowConsequential/, "the message must name the plan field");

  // (b) Declaring the intent in the plan is not enough either: the run still
  //     needs the explicit --allow-consequential flag from the caller. The
  //     refusal happens before anything is created.
  const deniedBase = tmpDir("denied");
  const declared = record(deletePlan({ safety: { allowConsequential: true } }), {
    outDir: deniedBase,
    args: ["--run-name", "eval-denied"],
  });
  assert.equal(declared.code, EXIT.INVALID_PLAN, `expected the run to be refused:\n${declared.stdout}${declared.stderr}`);
  assert.match(String(declared.json?.error ?? ""), /--allow-consequential/);
  assert.deepEqual(listDir(deniedBase), [], "a refused run must not leave a half-made run directory behind");
  let state = await fixture.state();
  assert.ok(
    state.projects.some((p) => p.id === project.id),
    "a refused run must not have touched the application"
  );

  // (c) With both keys the workflow really runs and the project really goes.
  const allowed = record(deletePlan({ safety: { allowConsequential: true } }), {
    args: ["--allow-consequential", "--run-name", "eval-allowed"],
  });
  assert.equal(allowed.code, EXIT.OK, `authorized run failed:\n${allowed.stdout}${allowed.stderr}`);
  assert.equal(allowed.json.ok, true);
  assert.equal(allowed.json.stepsFailed, 0);
  const timeline = readJson(path.join(allowed.runDir, "timeline.json"));
  const removal = timeline.steps.find((s) => s.id === "delete");
  assert.equal(removal.status, "ok");
  assert.equal(removal.assertion.passed, true, "the deletion must have been verified in the browser");
  state = await fixture.state();
  assert.ok(
    !state.projects.some((p) => p.id === project.id),
    "the authorized workflow must really delete the project"
  );
});
