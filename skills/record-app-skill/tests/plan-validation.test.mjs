/**
 * CLI-level tests for plan validation: the exit-code contract and the
 * machine-readable output that the agent reads.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { EXIT } from "../scripts/lib.mjs";
import { runScript, tmpDir, writePlan, SKILL_DIR } from "./helpers.mjs";

const validPlan = (overrides = {}) => ({
  schemaVersion: 1,
  title: "Create a task",
  baseUrl: "http://127.0.0.1:4319",
  startRoute: "/tasks",
  steps: [
    { id: "open", action: "goto", path: "/tasks" },
    { id: "create", action: "click", target: { role: "button", name: "New task" } },
    {
      id: "submit",
      action: "click",
      target: { role: "button", name: "Create task" },
      assertOn: { role: "alert" },
      expect: { visible: true, text: "Task created" },
    },
  ],
  ...overrides,
});

test("a valid plan exits 0 and reports the resolved shape", () => {
  const dir = tmpDir("plan-ok");
  const file = writePlan(dir, validPlan());

  const text = runScript("validate-plan.mjs", ["--plan", file]);
  assert.equal(text.code, EXIT.OK, text.stderr);
  assert.match(text.stdout, /valid/i);

  const json = runScript("validate-plan.mjs", ["--plan", file, "--json"]);
  assert.equal(json.code, EXIT.OK);
  assert.equal(json.json.ok, true);
  assert.equal(json.json.errors.length, 0);
  assert.equal(json.json.stepCount, 3);
  assert.equal(json.json.backend, "auto");
});

test("an invalid plan exits 2 with actionable errors and no stack trace", () => {
  const dir = tmpDir("plan-bad");
  const file = writePlan(
    dir,
    validPlan({
      steps: [
        { id: "a", action: "evaluate", script: "fetch('/admin')" },
        { id: "b", action: "click", target: { css: "#x", role: "button" } },
      ],
    })
  );

  const json = runScript("validate-plan.mjs", ["--plan", file, "--json"]);
  assert.equal(json.code, EXIT.INVALID_PLAN);
  assert.equal(json.json.ok, false);
  assert.ok(json.json.errors.some((e) => /not supported/.test(e)));
  assert.ok(json.json.errors.some((e) => /multiple selectors/.test(e)));
  assert.doesNotMatch(json.stderr, /at Object\.|node:internal/, "errors must read like messages, not stack traces");
});

test("a missing or malformed plan file is a usage error, not a crash", () => {
  const missing = runScript("validate-plan.mjs", ["--plan", path.join(tmpDir("plan-absent"), "definitely-not-here.json")]);
  assert.equal(missing.code, EXIT.INVALID_PLAN);
  assert.match(`${missing.stdout}${missing.stderr}`, /not found|ENOENT|no such file/i);

  const dir = tmpDir("plan-broken");
  const file = path.join(dir, "broken.json");
  fs.writeFileSync(file, "{ this is not json ");
  const broken = runScript("validate-plan.mjs", ["--plan", file, "--json"]);
  assert.equal(broken.code, EXIT.INVALID_PLAN);
  assert.equal(broken.json.ok, false);
  assert.ok(broken.json.errors.some((e) => /JSON/i.test(e)), JSON.stringify(broken.json));

  const noArgs = runScript("validate-plan.mjs", []);
  assert.equal(noArgs.code, EXIT.INVALID_PLAN);
});

test("--show-normalized exposes the defaults a plan is actually executed with", () => {
  const dir = tmpDir("plan-normalized");
  const file = writePlan(dir, validPlan());
  const result = runScript("validate-plan.mjs", ["--plan", file, "--show-normalized", "--json"]);
  assert.equal(result.code, EXIT.OK);
  assert.equal(result.json.normalized.capture.fps, 60);
  assert.deepEqual(result.json.normalized.browser.viewport, { width: 1440, height: 900 });
  assert.equal(result.json.normalized.safety.allowConsequential, false);
  assert.equal(result.json.normalized.auth.mode, "none");
});

test("the machine-readable report names every step so a reviewer can follow it", () => {
  const dir = tmpDir("plan-steps");
  const file = writePlan(dir, validPlan());
  const { code, json } = runScript("validate-plan.mjs", ["--plan", file, "--json"]);
  assert.equal(code, EXIT.OK);
  assert.deepEqual(
    json.steps.map((s) => s.id),
    ["open", "create", "submit"]
  );
  assert.deepEqual(
    json.steps.map((s) => s.action),
    ["goto", "click", "click"]
  );
  assert.equal(json.steps[1].target, 'role="button" name="New task"');
  assert.equal(json.steps[2].assertOn, 'role="alert"');
  assert.doesNotMatch(JSON.stringify(json), /value/, "the report must not echo filled-in text");
});

test("the bundled example plan is valid and stays in schema", () => {
  // The template ships with the skill, so it must never drift out of schema.
  const file = path.join(SKILL_DIR, "assets", "templates", "workflow.example.json");
  const result = runScript("validate-plan.mjs", ["--plan", file, "--json"]);
  assert.equal(result.code, EXIT.OK, `example plan is invalid: ${result.stdout}${result.stderr}`);
  assert.equal(result.json.ok, true);
  assert.deepEqual(result.json.warnings, [], "the shipped example must not warn");
});

test("a consequential step is refused until authorization is explicit", () => {
  const dir = tmpDir("plan-consequential");
  const plan = validPlan({
    steps: [
      { id: "open", action: "goto", path: "/" },
      { id: "purge", action: "click", target: { role: "button", name: "Delete account" } },
    ],
  });
  const file = writePlan(dir, plan);
  assert.equal(runScript("validate-plan.mjs", ["--plan", file]).code, EXIT.INVALID_PLAN);

  const authorized = writePlan(
    dir,
    validPlan({
      safety: { allowConsequential: true },
      steps: [
        { id: "open", action: "goto", path: "/" },
        {
          id: "purge",
          action: "click",
          target: { role: "button", name: "Delete account" },
          consequential: true,
        },
      ],
    }),
    "authorized.json"
  );
  const result = runScript("validate-plan.mjs", ["--plan", authorized, "--json"]);
  assert.equal(result.code, EXIT.OK, `${result.stdout}${result.stderr}`);
});
