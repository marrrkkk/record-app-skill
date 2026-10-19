/**
 * The install-integrity check.
 *
 * The skill travels as a directory, so a copy that lost a script still loads
 * in an agent and only fails halfway through a recording. These tests prove
 * the checker notices that, and that it stays quiet on a complete copy.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { checkInstall } from "../scripts/check-install.mjs";
import { SKILL_DIR, runScript, tmpDir } from "./helpers.mjs";

/** Copy the skill (without its installed dependencies) to a scratch directory. */
function copySkill(target) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(SKILL_DIR, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    fs.cpSync(path.join(SKILL_DIR, entry.name), path.join(target, entry.name), {
      recursive: true,
    });
  }
  return target;
}

test("a complete installation passes the check", () => {
  const result = checkInstall();
  assert.deepEqual(result.problems, [], "the packaged skill must be complete");
  assert.equal(result.ok, true);
});

test("the check runs from the command line and reports success", () => {
  const result = runScript("check-install.mjs", []);
  assert.equal(result.code, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /record-app-skill installation looks complete/);
});

test("the JSON report is machine-readable", () => {
  const result = runScript("check-install.mjs", ["--json"]);
  assert.equal(result.code, 0);
  const json = JSON.parse(result.stdout);
  assert.equal(json.ok, true);
  assert.deepEqual(json.problems, []);
});

test("a missing script is reported, not ignored", () => {
  const dir = copySkill(tmpDir("install-missing"));
  fs.rmSync(path.join(dir, "scripts", "run-demo.mjs"));
  const result = checkInstall({ dir });
  assert.equal(result.ok, false);
  assert.ok(
    result.problems.some((p) => /missing scripts\/run-demo\.mjs/.test(p)),
    `expected the missing script to be named: ${JSON.stringify(result.problems)}`
  );
});

test("a missing reference is reported, not ignored", () => {
  const dir = copySkill(tmpDir("install-missing-ref"));
  fs.rmSync(path.join(dir, "references", "browser-backends.md"));
  const result = checkInstall({ dir });
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => /browser-backends\.md/.test(p)));
});

test("a renamed directory is reported, not ignored", () => {
  const dir = copySkill(path.join(tmpDir("install-renamed"), "something-else"));
  const result = checkInstall({ dir });
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => /directory is called "something-else"/.test(p)));
});

test("a path from the build machine is reported, not ignored", () => {
  const dir = copySkill(tmpDir("install-abs-path"));
  // Assembled at runtime so this file does not itself contain the literal.
  const machinePath = ["", "home", "somebody", "else", "node_modules"].join("/");
  fs.appendFileSync(
    path.join(dir, "references", "workflow-plans.md"),
    `\n\nAn absolute path that only existed on the build machine: ${machinePath}\n`
  );
  const result = checkInstall({ dir });
  assert.equal(result.ok, false);
  assert.ok(
    result.problems.some((p) => /absolute path from another machine/.test(p)),
    `expected the machine path to be reported: ${JSON.stringify(result.problems)}`
  );
});
