/**
 * Every command has two outputs: the machine-readable one (`--json`) and the
 * one a person reads.
 *
 * Only the first was covered by the other suites, and that gap was not
 * theoretical: `build-contact-sheet.mjs` called an undefined variable inside
 * its human-readable branch, so `--json` worked and the documented command
 * crashed with a `ReferenceError`. These tests run each command the way the
 * README and the skill tell a person to run it, and require the output to be
 * plain, useful prose with no stack trace in it.
 */

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { EXIT } from "../scripts/lib.mjs";
import { closedPort, runScript, screencastAvailable, startFixture, tmpDir, writePlan } from "./helpers.mjs";

let fixture = null;
let planFile = null;
let outBase = null;

/** A stack trace in a human-readable output means the friendly path broke. */
const STACK_RE = /\b(ReferenceError|TypeError|SyntaxError|is not defined|at Object\.|at Module\.)/;

const plan = (baseUrl) => ({
  schemaVersion: 1,
  title: "Add a task to the queue",
  description: "Create a task with a priority and confirm it appears in the list.",
  baseUrl,
  startRoute: "/tasks",
  steps: [
    { id: "open", action: "goto", path: "/tasks" },
    { id: "intro", action: "caption", text: "Adding a task to the queue", durationMs: 1200 },
    { id: "dialog", action: "click", target: { testId: "open-create" }, assertOn: { testId: "create-form" }, expect: { visible: true } },
    { id: "name", action: "fill", target: { label: "Task name" }, value: "Draft the launch note" },
    { id: "save", action: "click", target: { testId: "submit-create" }, caption: "Save the task" },
    { id: "verify", action: "waitFor", target: { testId: "flash" }, expect: { visible: true, text: "Draft the launch note" } },
  ],
});

before(async () => {
  fixture = await startFixture();
  await fixture.reset();
  outBase = tmpDir("human-out");
  planFile = writePlan(tmpDir("human-plan"), plan(fixture.baseUrl));
});

after(async () => {
  await fixture?.stop();
});

test("the plan validator explains itself to a person, and to an agent", async (t) => {
  if (!(await screencastAvailable())) return t.skip("Playwright's bundled ffmpeg is missing");

  const good = runScript("validate-plan.mjs", ["--plan", planFile]);
  assert.equal(good.code, EXIT.OK, `expected a valid plan:\n${good.stdout}${good.stderr}`);
  assert.match(good.stdout, /Plan is valid/);
  assert.match(good.stdout, /6 step\(s\)/, "the summary must say how much work there is");
  assert.doesNotMatch(`${good.stdout}${good.stderr}`, STACK_RE);

  const bad = writePlan(
    tmpDir("human-bad-plan"),
    { schemaVersion: 1, title: "Nothing to do", baseUrl: fixture.baseUrl, steps: [] }
  );
  const invalid = runScript("validate-plan.mjs", ["--plan", bad]);
  assert.equal(invalid.code, EXIT.INVALID_PLAN);
  const combined = `${invalid.stdout}${invalid.stderr}`;
  assert.match(combined, /at least one step|steps/i, "the refusal must say what is wrong");
  assert.doesNotMatch(combined, STACK_RE);
});

test("the recorder reports a finished run in plain language", async (t) => {
  if (!(await screencastAvailable())) return t.skip("Playwright's bundled ffmpeg is missing");

  const result = runScript(
    "record-workflow.mjs",
    ["--plan", planFile, "--out-dir", outBase, "--run-name", "human"],
    { timeout: 300000 }
  );
  assert.equal(result.code, EXIT.OK, `recording failed:\n${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /Recorded — Add a task to the queue/);
  assert.match(result.stdout, /backend\s+:/, "the summary must name the backend it used");
  assert.match(result.stdout, /Next: node render-video\.mjs/, "it must say what to do next");

  const runDir = path.join(
    outBase,
    fs.readdirSync(outBase).find((name) => name.startsWith("human-"))
  );
  assert.ok(fs.existsSync(path.join(runDir, "raw-recording.webm")), "the run must exist where it said");

  // The renderer, the contact sheet and the validator, all read by a person.
  const render = runScript("render-video.mjs", ["--run-dir", runDir], { timeout: 300000 });
  assert.equal(render.code, EXIT.OK, `render failed:\n${render.stdout}${render.stderr}`);
  assert.match(render.stdout, /Rendered demo\.mp4/);
  assert.match(render.stdout, /h264 1440x900 @ 60 fps/);
  assert.match(render.stdout, /audio=none/, "a person must be told there is no audio");

  const sheet = runScript("build-contact-sheet.mjs", ["--run-dir", runDir], { timeout: 300000 });
  assert.equal(sheet.code, EXIT.OK, `contact sheet failed:\n${sheet.stdout}${sheet.stderr}`);
  assert.match(sheet.stdout, /Contact sheet: /);
  assert.match(sheet.stdout, /source : demo\.mp4 \(\d+\.\d+s\)/);

  const validate = runScript("validate-video.mjs", ["--run-dir", runDir, "--require-contact-sheet"], {
    timeout: 300000,
  });
  assert.equal(validate.code, EXIT.OK, `validation failed:\n${validate.stdout}${validate.stderr}`);
  assert.match(validate.stdout, /VALIDATED/);
  assert.match(validate.stdout, /checks : \d+\/\d+ passed/);
  assert.match(validate.stdout, /report : /, "it must point at the report");

  for (const [name, result_] of [["record", result], ["render", render], ["sheet", sheet], ["validate", validate]]) {
    assert.doesNotMatch(
      `${result_.stdout}${result_.stderr}`,
      STACK_RE,
      `${name} leaked a stack trace into its human-readable output`
    );
  }
});

test("a failure is still machine-readable without --json", async (t) => {
  if (!(await screencastAvailable())) return t.skip("Playwright's bundled ffmpeg is missing");

  const port = await closedPort();
  const unreachable = writePlan(tmpDir("human-unreachable"), plan(`http://127.0.0.1:${port}`));
  const result = runScript(
    "record-workflow.mjs",
    ["--plan", unreachable, "--out-dir", tmpDir("human-unreachable-out")],
    { timeout: 120000 }
  );
  assert.equal(result.code, EXIT.ENVIRONMENT_FAILED);
  assert.ok(result.json, `a failure without --json must still be parseable:\n${result.stdout}${result.stderr}`);
  assert.equal(result.json.ok, false);
  assert.match(String(result.json.error ?? ""), /127\.0\.0\.1/, "the error must name the address it tried");
  assert.ok(result.json.runDir, "the error must say where the explanation was written");
});
