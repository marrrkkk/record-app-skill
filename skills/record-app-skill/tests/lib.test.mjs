/**
 * Unit tests for the plan schema, safety gates, selector rules and output
 * collision handling — the parts that must never regress silently, because
 * everything else trusts them.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  EXIT,
  SELECTOR_STRATEGIES,
  STEP_ACTIONS,
  assertSafeExternalPath,
  assertStateOutsideOutput,
  consequentialReason,
  credentialTargetHint,
  describeSelector,
  failureStatus,
  formatBytes,
  redactSecrets,
  resolveRunDir,
  sanitizeName,
  scanForSecrets,
  selectorStrategy,
  validatePlan,
  validateTarget,
  withDefaults,
  writeFailureReport,
} from "../scripts/lib.mjs";
import { tmpDir } from "./helpers.mjs";

const okPlan = (overrides = {}) => ({
  schemaVersion: 1,
  title: "Create a task",
  baseUrl: "http://127.0.0.1:4319",
  startRoute: "/tasks",
  steps: [{ id: "open", action: "goto", path: "/tasks" }],
  ...overrides,
});

const errorsOf = (plan) => validatePlan(plan).errors;
const warningsOf = (plan) => validatePlan(plan).warnings;

/* ------------------------------------------------------------------ */
/* Defaults and schema                                                 */
/* ------------------------------------------------------------------ */

test("accepts a minimal valid plan and applies documented defaults", () => {
  const { errors, warnings, plan } = validatePlan(okPlan());
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
  assert.equal(plan.browser.backend, "auto");
  assert.equal(plan.browser.channel, "auto", "the user's own browser is the default, not bundled Chromium");
  assert.equal(plan.browser.headless, true);
  assert.deepEqual(plan.browser.viewport, { width: 1440, height: 900 });
  assert.equal(plan.browser.timeoutMs, 15000);
  assert.equal(plan.capture.fps, 60);
  assert.equal(plan.capture.typingDelayMs, 45);
  assert.equal(plan.capture.smoothScroll, true);
  assert.equal(plan.capture.cursor.enabled, true);
  assert.equal(plan.capture.captions.enabled, false);
  assert.equal(plan.capture.chapters.enabled, false);
  assert.equal(plan.output.dir, ".video");
  assert.equal(plan.safety.allowConsequential, false);
  assert.equal(plan.auth.mode, "none");
  assert.deepEqual(plan.media, {
    container: "mp4",
    videoCodec: "h264",
    fps: 60,
    quality: "high",
    crf: 18,
    preset: "slow",
  });
});

test("captions and chapters are off by default and follow explicit plan usage", () => {
  const plain = validatePlan(okPlan()).plan;
  assert.equal(plain.capture.captions.enabled, false);
  assert.equal(plain.capture.chapters.enabled, false);

  const captioned = validatePlan(
    okPlan({ steps: [{ id: "say", action: "caption", text: "Hello" }] })
  ).plan;
  assert.equal(captioned.capture.captions.enabled, true, "a caption step opts captions in");
  assert.equal(captioned.capture.chapters.enabled, false);

  const annotated = validatePlan(
    okPlan({
      steps: [{ id: "click", action: "click", target: { css: "#go" }, caption: "Click it" }],
    })
  ).plan;
  assert.equal(annotated.capture.captions.enabled, true, "a step caption opts captions in");

  const optedOut = validatePlan(
    okPlan({
      capture: { captions: { enabled: false }, chapters: { enabled: false } },
      steps: [
        { id: "say", action: "caption", text: "Hello" },
        { id: "mark", action: "checkpoint", title: "Still off" },
      ],
    })
  ).plan;
  assert.equal(optedOut.capture.captions.enabled, false, "an explicit false always wins");
  assert.equal(optedOut.capture.chapters.enabled, false);

  const chaptered = validatePlan(
    okPlan({ steps: [{ id: "mark", action: "checkpoint", title: "Chapter" }] })
  ).plan;
  assert.equal(chaptered.capture.chapters.enabled, true, "a checkpoint opts chapters in");
});

test("quality presets supply render settings without overriding explicit choices", () => {
  const compact = validatePlan(okPlan({ media: { quality: "compact" } })).plan;
  assert.equal(compact.media.crf, 23);
  assert.equal(compact.media.preset, "medium");

  const explicit = validatePlan(okPlan({ media: { quality: "high", crf: 30 } })).plan;
  assert.equal(explicit.media.crf, 30, "an explicit crf wins over the preset");
  assert.equal(explicit.media.preset, "slow", "the remaining preset fields still apply");

  assert.ok(errorsOf(okPlan({ media: { quality: "ultra" } })).some((e) => /media\.quality/.test(e)));
});

test("capture rate overrides propagate to rendering unless media.fps is explicit", () => {
  assert.equal(validatePlan(okPlan({ capture: { fps: 30 } })).plan.media.fps, 30);
  assert.equal(
    validatePlan(okPlan({ capture: { fps: 30 }, media: { fps: 60 } })).plan.media.fps,
    60,
    "an explicit media.fps is respected"
  );
  assert.ok(
    errorsOf(okPlan({ capture: { fps: 61 } })).some((e) => /capture\.fps must be an integer between 1 and 60/.test(e))
  );
});

test("rejects a non-object plan and the wrong schema version", () => {
  assert.deepEqual(errorsOf(null), ["plan must be a JSON object"]);
  assert.ok(errorsOf(okPlan({ schemaVersion: 2 })).some((e) => /schemaVersion must be 1/.test(e)));
});

test("requires title, baseUrl and at least one step", () => {
  assert.ok(errorsOf(okPlan({ title: "  " })).some((e) => /title is required/.test(e)));
  assert.ok(errorsOf(okPlan({ baseUrl: "" })).some((e) => /baseUrl is required/.test(e)));
  assert.ok(errorsOf(okPlan({ baseUrl: "ftp://x/y" })).some((e) => /must be http or https/.test(e)));
  assert.ok(errorsOf(okPlan({ baseUrl: "not a url" })).some((e) => /not a valid URL/.test(e)));
  assert.ok(errorsOf(okPlan({ steps: [] })).some((e) => /at least one step/.test(e)));
  assert.ok(errorsOf(okPlan({ steps: "nope" })).some((e) => /steps must be an array/.test(e)));
});

test("rejects unknown step keys, arbitrary code, and unsupported assertions", () => {
  const withKey = okPlan({
    steps: [{ id: "a", action: "click", target: { css: "#go" }, javascript: "alert(1)" }],
  });
  assert.ok(errorsOf(withKey).some((e) => /javascript is not a recognized step field/.test(e)));

  const withAction = okPlan({ steps: [{ id: "a", action: "evaluate" }] });
  assert.ok(errorsOf(withAction).some((e) => /action "evaluate" is not supported/.test(e)));
  assert.ok(errorsOf(withAction).some((e) => /not representable in a workflow plan/.test(e)));

  const withExpect = okPlan({
    steps: [
      { id: "a", action: "assert", target: { css: "body" }, expect: { looksGood: true } },
    ],
  });
  assert.ok(errorsOf(withExpect).some((e) => /expect\.looksGood is not a supported assertion/.test(e)));
});

test("no plan field can express code execution", () => {
  // Anything that would let a plan run code is absent from the action list.
  for (const forbidden of ["evaluate", "script", "inject", "exec", "run"]) {
    assert.ok(!STEP_ACTIONS.includes(forbidden), `"${forbidden}" must never be a step action`);
    assert.ok(errorsOf(okPlan({ steps: [{ id: "x", action: forbidden }] })).length > 0);
  }
});

test("every documented action is accepted, so the docs and schema cannot drift", () => {
  const sample = {
    goto: { path: "/" },
    click: { target: { role: "button", name: "Go" } },
    fill: { target: { label: "Title" }, value: "text" },
    select: { target: { label: "Priority" }, value: "high" },
    check: { target: { label: "Agree" } },
    uncheck: { target: { label: "Agree" } },
    press: { key: "Enter" },
    hover: { target: { css: "#menu" } },
    scroll: { to: "bottom" },
    waitFor: { target: { css: "body" }, state: "visible" },
    assert: { target: { css: "body" }, expect: { visible: true } },
    caption: { text: "hello" },
    checkpoint: { title: "step one" },
    pause: { ms: 100 },
  };
  for (const action of STEP_ACTIONS) {
    assert.ok(sample[action], `no sample step for documented action "${action}" — update this test`);
    const { errors } = validatePlan(okPlan({ steps: [{ id: "s", action, ...sample[action] }] }));
    assert.deepEqual(errors, [], `action "${action}" should validate: ${errors.join("; ")}`);
  }
  // The sample table must cover the schema exactly, in both directions.
  assert.deepEqual(Object.keys(sample).sort(), [...STEP_ACTIONS].sort());
});

test("rejects duplicate ids and resolves omitted ids deterministically", () => {
  const dupe = okPlan({
    steps: [
      { id: "same", action: "caption", text: "one" },
      { id: "same", action: "caption", text: "two" },
    ],
  });
  assert.ok(errorsOf(dupe).some((e) => /"same" is duplicated/.test(e)));

  // Ids may be omitted, but then they are derived — never left undefined, or
  // the timeline could not be correlated with the plan.
  const input = okPlan({
    steps: [
      { action: "caption", text: "no id" },
      { action: "goto", path: "/tasks" },
    ],
  });
  const snapshot = JSON.stringify(input);
  const { errors, plan, steps } = validatePlan(input);
  assert.deepEqual(errors, []);
  assert.deepEqual(
    steps.map((s) => s.id),
    ["1-caption", "2-goto"]
  );
  assert.deepEqual(
    plan.steps.map((s) => s.id),
    ["1-caption", "2-goto"]
  );
  assert.equal(JSON.stringify(input), snapshot, "validating must not rewrite the caller's plan");

  const badId = okPlan({ steps: [{ id: 7, action: "caption", text: "x" }] });
  assert.ok(errorsOf(badId).some((e) => /id must be a non-empty string/.test(e)));
});

/* ------------------------------------------------------------------ */
/* Selectors: the documented preference order must be enforceable      */
/* ------------------------------------------------------------------ */

test("selector strategies are ranked from accessible to last-resort CSS", () => {
  assert.deepEqual(SELECTOR_STRATEGIES, ["role", "label", "placeholder", "testId", "text", "css"]);
  // When several are present the ranking decides, which is what makes the
  // preference order in the docs enforceable rather than decorative.
  assert.equal(selectorStrategy({ css: "#a", role: "button", name: "Go" }), "role");
  assert.equal(selectorStrategy({ css: "#a", text: "Go" }), "text");
  assert.equal(selectorStrategy({ css: "#a" }), "css");
  assert.equal(selectorStrategy({}), null);
});

test("a CSS-heavy plan produces a reviewable warning, not a silent acceptance", () => {
  const plan = okPlan({
    steps: [
      { id: "a", action: "click", target: { css: "#a" } },
      { id: "b", action: "click", target: { css: "#b" } },
    ],
  });
  const { errors, warnings } = validatePlan(plan);
  assert.deepEqual(errors, []);
  assert.ok(warnings.some((w) => /select by raw CSS/.test(w)), warnings.join("; "));
  // A plan built on accessible selectors stays quiet.
  const clean = okPlan({
    steps: [
      { id: "a", action: "click", target: { role: "button", name: "Create task" } },
      { id: "b", action: "click", target: { label: "Title" } },
    ],
  });
  assert.deepEqual(warningsOf(clean), []);
});

test("validateTarget insists on exactly one usable selector", () => {
  const check = (target) => {
    const found = [];
    validateTarget(target, (m) => found.push(m));
    return found;
  };
  assert.deepEqual(check({ role: "button", name: "Go" }), []);
  assert.deepEqual(check({ role: "button" }), [], "a role-only locator is legitimate");
  assert.deepEqual(check({ css: "#a" }), []);
  assert.ok(check({}).some((e) => /no selector/.test(e)));
  assert.ok(check({ role: "button", css: "#a" }).some((e) => /multiple selectors/.test(e)));
  assert.ok(check({ label: "" }).some((e) => /must be a non-empty string/.test(e)));
  assert.ok(check({ css: "#a", nth: -1 }).some((e) => /nth must be a non-negative integer/.test(e)));
  assert.ok(check({ css: "#a", exact: "yes" }).some((e) => /exact must be a boolean/.test(e)));
  assert.ok(check("nope").some((e) => /target must be an object/.test(e)));
});

test("describeSelector makes a selector choice reviewable in logs and reports", () => {
  assert.equal(describeSelector({ css: "#a" }), 'css="#a"');
  assert.equal(describeSelector({ role: "button", name: "Go" }), 'role="button" name="Go"');
  assert.equal(describeSelector({ label: "Title" }), 'label="Title"');
  assert.equal(describeSelector({}), "<no selector>");
  assert.equal(describeSelector(null), "<invalid target>");
});

test("assertOn lets an assertion target differ from the action target", () => {
  const plan = okPlan({
    steps: [
      {
        id: "check",
        action: "click",
        target: { role: "button", name: "Create task" },
        assertOn: { role: "alert" },
        expect: { visible: true },
      },
    ],
  });
  assert.deepEqual(errorsOf(plan), []);
});

/* ------------------------------------------------------------------ */
/* No arbitrary sleeps                                                 */
/* ------------------------------------------------------------------ */

test("pause is bounded so a plan cannot smuggle in arbitrary sleeps", () => {
  assert.ok(errorsOf(okPlan({ steps: [{ id: "p", action: "pause", ms: 6000 }] })).some((e) => /at most 5000/.test(e)));
  assert.ok(errorsOf(okPlan({ steps: [{ id: "p", action: "pause", ms: -1 }] })).some((e) => /non-negative integer/.test(e)));
  assert.ok(
    warningsOf(okPlan({ steps: [{ id: "p", action: "pause", ms: 3000 }] })).some((w) => /prefer an assertion/.test(w))
  );
});

/* ------------------------------------------------------------------ */
/* Consequential-action gate                                           */
/* ------------------------------------------------------------------ */

test("externally consequential actions are recognised and blocked by default", () => {
  const cases = [
    { role: "button", name: "Delete account" },
    { role: "button", name: "Publish post" },
    { label: "Send invite" },
    { css: "#pay-now" },
    { testId: "delete-account" },
    { role: "button", name: "Remove member" },
    { role: "button", name: "Place order" },
  ];
  for (const target of cases) {
    assert.ok(
      consequentialReason({ action: "click", target }),
      `expected ${describeSelector(target)} to be flagged`
    );
    const { errors } = validatePlan(okPlan({ steps: [{ id: "go", action: "click", target }] }));
    assert.ok(
      errors.some((e) => /externally consequential/.test(e)),
      `expected the gate to block ${describeSelector(target)}: ${errors.join("; ")}`
    );
  }
});

test("ordinary product UI is not mistaken for a consequential action", () => {
  // These labels appear in everyday apps and must not force an authorization
  // prompt, or the gate would be noise and get switched off entirely.
  const harmless = [
    { role: "button", name: "Cancel" },
    { role: "button", name: "Save" },
    { label: "Post title" },
    { css: "#post-title" },
    { css: "btn-cancel" },
    { role: "button", name: "Remove filter" },
    { role: "button", name: "Create task" },
    { label: "Search" },
  ];
  for (const target of harmless) {
    assert.equal(
      consequentialReason({ action: "click", target }),
      null,
      `${describeSelector(target)} must not be treated as consequential`
    );
  }
});

test("the gate opens only with an explicit authorization flag", () => {
  const target = { role: "button", name: "Delete account" };
  const plan = okPlan({
    safety: { allowConsequential: true },
    steps: [{ id: "go", action: "click", target, consequential: true }],
  });
  assert.deepEqual(errorsOf(plan), []);
});

test("read-only actions against consequential-looking labels are not blocked", () => {
  // Asserting that a destructive control exists is a read, and describing one
  // in a caption is only text: neither may be gated, or the demo could not
  // show the danger zone at all.
  const plan = okPlan({
    steps: [
      {
        id: "look",
        action: "assert",
        target: { role: "button", name: "Delete account" },
        expect: { visible: true },
      },
      { id: "say", action: "caption", text: "This button would delete the account." },
      { id: "mark", action: "checkpoint", title: "Danger zone (not clicked)" },
      { id: "wait", action: "waitFor", target: { css: "#danger" }, state: "visible" },
    ],
  });
  assert.deepEqual(errorsOf(plan), []);
});

test("an unflagged consequential action is surfaced as a warning worth fixing", () => {
  const plan = okPlan({
    safety: { allowConsequential: true },
    steps: [{ id: "go", action: "click", target: { role: "button", name: "Delete account" } }],
  });
  const { errors, warnings } = validatePlan(plan);
  assert.deepEqual(errors, []);
  assert.ok(warnings.some((w) => /consequential/.test(w)));
});

/* ------------------------------------------------------------------ */
/* Secrets                                                            */
/* ------------------------------------------------------------------ */

test("secret scanning finds real token shapes and ignores ordinary prose", () => {
  const googleKey = `AIza${"f".repeat(35)}`;
  const openAiKey = `sk-${"a".repeat(24)}`;
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const cases = {
    "GitHub token": "token: ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    "Google API key": `key = ${googleKey}`,
    "OpenAI-style key": `OPENAI_API_KEY=${openAiKey}`,
    "authorization header": "Authorization: Basic dXNlcjpwYXNzd29yZA==",
    "bearer token": `Authorization: Bearer ${"A".repeat(24)}`,
    "private key": "-----BEGIN RSA PRIVATE KEY-----",
    "basic-auth URL": "https://user:pass@example.test/x",
    JWT: jwt,
    "Slack token": "xoxb-1234567890-abcdefghij",
  };
  for (const [label, sample] of Object.entries(cases)) {
    assert.ok(scanForSecrets(sample).length > 0, `expected to detect ${label}`);
  }
  // Ordinary demo prose must stay quiet, or the scanner becomes noise.
  assert.equal(scanForSecrets("Create a task and verify it appears in the list").length, 0);
  assert.equal(scanForSecrets("Click Save, then check the task appears in the list").length, 0);
  assert.equal(scanForSecrets("The password field is validated but never filled").length, 0);
});

test("a plan that embeds a raw token is rejected or warned about, never silently accepted", () => {
  const plan = okPlan({
    steps: [
      {
        id: "paste",
        action: "fill",
        target: { label: "Search" },
        value: "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      },
    ],
  });
  const { errors, warnings } = validatePlan(plan);
  assert.ok(errors.length + warnings.length > 0, "a token in a plan must be reported");
});

test("credential-shaped fields are recognised by their visible hint", () => {
  assert.ok(credentialTargetHint({ label: "Password" }));
  assert.ok(credentialTargetHint({ label: "Confirm password" }));
  assert.ok(credentialTargetHint({ placeholder: "API key" }));
  assert.ok(credentialTargetHint({ testId: "totp-code" }));
  assert.ok(credentialTargetHint({ role: "textbox", name: "One-time code" }));
  assert.equal(credentialTargetHint({ label: "Username" }), null);
  assert.equal(credentialTargetHint({ label: "Email address" }), null);
  assert.equal(credentialTargetHint({ label: "Task title" }), null);
  assert.equal(credentialTargetHint(undefined), null);
});

test("filling a credential field from the plan is rejected, since plans are artifacts", () => {
  const { errors } = validatePlan(
    okPlan({
      steps: [
        { id: "signin", action: "fill", target: { label: "Password" }, value: "hunter2hunter2" },
      ],
    })
  );
  assert.ok(errors.some((e) => /literal value into a credential field/.test(e)), errors.join("; "));
  assert.ok(errors.some((e) => /auth\.mode/.test(e)), "the error must point at the safe alternative");
});

test("ordinary form filling is untouched by the credential rule", () => {
  const plan = okPlan({
    steps: [
      { id: "title", action: "fill", target: { label: "Task title" }, value: "Write the launch note" },
      { id: "notes", action: "fill", target: { placeholder: "Description" }, value: "Demo run" },
      { id: "user", action: "fill", target: { label: "Username" }, value: "demo-user" },
    ],
  });
  assert.deepEqual(errorsOf(plan), []);
});

test("redaction keeps the surrounding diagnostic text", () => {
  const redacted = redactSecrets("login failed for token: ghp_abcdefghijklmnopqrstuvwxyz0123456789 (502)");
  assert.match(redacted, /login failed for/);
  assert.match(redacted, /502/);
  assert.doesNotMatch(redacted, /ghp_abcdefghijklmnopqrstuvwxyz0123456789/);
});

/* ------------------------------------------------------------------ */
/* Output directories and paths                                        */
/* ------------------------------------------------------------------ */

test("run directories are timestamped and refuse to overwrite silently", () => {
  const base = tmpDir("rundir");
  const at = new Date("2026-01-02T03:04:05Z");
  const first = resolveRunDir(base, { runName: "Create a task", now: at });
  assert.equal(path.basename(first), "create-a-task-20260102-030405Z");
  assert.equal(path.dirname(first), base);

  fs.mkdirSync(first, { recursive: true });
  assert.throws(() => resolveRunDir(base, { runName: "Create a task", now: at }), /already exists/i);
  assert.equal(resolveRunDir(base, { runName: "Create a task", now: at, allowExisting: true }), first);
  // A different second never collides, so two runs can share a base directory.
  assert.notEqual(resolveRunDir(base, { runName: "Create a task", now: new Date("2026-01-02T03:04:06Z") }), first);
});

test("run directory names are filesystem-safe", () => {
  assert.equal(sanitizeName("Create a task / then verify"), "create-a-task-then-verify");
  assert.equal(sanitizeName("../../etc/passwd"), "etc-passwd");
  assert.ok(sanitizeName("").length > 0);
  assert.ok(sanitizeName("../..").length > 0);
  assert.doesNotMatch(sanitizeName("a\\b:c*d?e\"f<g>h|i"), /[\\/:*?"<>|]/);
});

test("paths handed to another process are validated before use", () => {
  assert.throws(() => assertSafeExternalPath("", "output"), /non-empty string/);
  assert.throws(() => assertSafeExternalPath(null, "output"), /non-empty string/);
  assert.throws(() => assertSafeExternalPath("--evil", "output"), /must not begin with "-"/);
  assert.throws(() => assertSafeExternalPath("a\u0000b", "output"), /control characters/);
  assert.doesNotThrow(() => assertSafeExternalPath(path.join(os.tmpdir(), "record-app-skill", "x"), "output"));
  assert.doesNotThrow(() => assertSafeExternalPath("\\\\wsl.localhost\\archlinux\\tmp\\x", "output"));
});

test("browser state must live outside the published output directory", () => {
  const root = tmpDir("state");
  const out = path.join(root, "runs");
  fs.mkdirSync(out, { recursive: true });
  assert.throws(
    () => assertStateOutsideOutput(path.join(out, "auth.json"), out),
    /inside the output directory/
  );
  assert.equal(assertStateOutsideOutput(path.join(root, "auth.json"), out), path.join(root, "auth.json"));
  // "No state configured" is not an error.
  assert.equal(assertStateOutsideOutput(null, out), null);
  assert.equal(assertStateOutsideOutput(undefined, out), null);
  assert.throws(() => assertStateOutsideOutput(42, out), /must be a string path/);
});

test("exit codes and byte formatting are stable, documented values", () => {
  assert.deepEqual(Object.values(EXIT), [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1536), "1.5 KiB");
  assert.equal(formatBytes(5 * 1024 * 1024), "5.0 MiB");
  assert.equal(formatBytes(Number.NaN), "unknown");
});

test("a failed run directory explains itself, on any backend", () => {
  // The Windows worker cannot import the local code path that writes this, so
  // the mapping lives in one place both backends call.
  assert.equal(failureStatus(EXIT.MISSING_DEPENDENCY), "missing-dependency");
  assert.equal(failureStatus(EXIT.ENVIRONMENT_FAILED), "environment-failed");
  assert.equal(failureStatus(EXIT.OUTPUT_CONFLICT), "output-conflict");
  assert.equal(failureStatus(EXIT.INVALID_PLAN), "invalid-plan");
  assert.equal(failureStatus(EXIT.WORKFLOW_FAILED), "failed");
  assert.equal(failureStatus(EXIT.INTERNAL), "failed");

  const runDir = path.join(tmpDir("failure-report"), "a-failed-run");
  const ok = writeFailureReport(runDir, EXIT.ENVIRONMENT_FAILED, "the app at http://127.0.0.1:9 is not reachable", {
    attempts: [{ url: "http://127.0.0.1:9/", error: "ECONNREFUSED" }],
    backend: "windows-native",
  });
  assert.equal(ok, true);

  const manifest = JSON.parse(fs.readFileSync(path.join(runDir, "manifest.json"), "utf8"));
  assert.equal(manifest.status, "environment-failed");
  assert.equal(manifest.exitCode, EXIT.ENVIRONMENT_FAILED);
  assert.match(manifest.error, /not reachable/);
  assert.equal(manifest.attempts.length, 1, "the addresses that were tried are evidence");
  assert.equal(manifest.backend, "windows-native");

  const report = fs.readFileSync(path.join(runDir, "report.md"), "utf8");
  assert.match(report, /^# Recording failed — environment-failed/m);
  assert.match(report, /Nothing in this directory is a validated recording/);
  assert.match(report, /not reachable/);
  assert.match(report, /## What to check/);

  // Writing the explanation must never fail the caller that is already failing.
  const blocked = path.join(tmpDir("failure-blocked"), "file-not-dir");
  fs.writeFileSync(blocked, "not a directory");
  assert.equal(writeFailureReport(path.join(blocked, "run"), EXIT.INTERNAL, "boom"), false);
});

/* ------------------------------------------------------------------ */
/* Purity of the defaults step                                          */
/* ------------------------------------------------------------------ */

test("withDefaults does not mutate the input plan", () => {
  const input = okPlan({ browser: { headless: false } });
  const snapshot = JSON.stringify(input);
  const merged = withDefaults(input);
  assert.equal(JSON.stringify(input), snapshot);
  assert.equal(merged.browser.headless, false);
  assert.equal(merged.browser.backend, "auto", "unspecified nested keys still get defaults");
});

test("viewport validation enforces sane dimensions and warns about odd ones", () => {
  const odd = validatePlan(okPlan({ browser: { viewport: { width: 1281, height: 720 } } }));
  assert.deepEqual(odd.errors, []);
  assert.ok(odd.warnings.some((w) => /odd dimension/.test(w)));
  assert.ok(
    errorsOf(okPlan({ browser: { viewport: { width: 100, height: 720 } } })).some((e) =>
      /between 200 and 3840/.test(e)
    )
  );
  assert.ok(
    errorsOf(okPlan({ browser: { viewport: { width: "1280", height: 720 } } })).some((e) =>
      /must be \{ width, height \} integers/.test(e)
    )
  );
});

/* ------------------------------------------------------------------ */
/* Backend selection per platform                                      */
/* ------------------------------------------------------------------ */

test("native Windows drives the host's own default browser, not a delegation", async () => {
  const { resolveBackend } = await import("../scripts/browser-env.mjs?native-windows");
  const environment = {
    kind: "windows",
    shellPlatform: "win32",
    renderPlatform: "win32",
    wsl: false,
    distro: null,
    networking: null,
    desktopSession: null,
  };
  const detectDefault = () => ({ id: "chrome", source: "system-default" });
  const detectInstalled = () => [{ id: "chrome", path: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", version: "155.0.8059.80" }];

  const resolved = resolveBackend("auto", { environment, detectDefault, detectInstalled });
  assert.equal(resolved.backend, "native", "the host's own browser is used in place");
  assert.equal(resolved.channel, "chrome");
  assert.equal(resolved.browser.source, "system-default");
  assert.equal(resolved.unavailable, false);

  // The legacy name still works and still means "the Windows host's browser".
  const forced = resolveBackend("windows-native", { environment, detectDefault, detectInstalled });
  assert.equal(forced.backend, "native");
  assert.equal(forced.requested, "windows-native");

  // The portable build stays available as the explicit escape hatch.
  const portable = resolveBackend("local-playwright", { environment, detectDefault, detectInstalled });
  assert.equal(portable.backend, "local-playwright");
  assert.equal(portable.channel, "chromium");
});

test("inside WSL the native browser is the default, never a silent fallback", async () => {
  const { resolveBackend, detectWindowsBackend } = await import("../scripts/browser-env.mjs?wsl-native");
  if (!detectWindowsBackend().wsl) return; // this suite also runs outside WSL
  const resolved = resolveBackend("auto");
  assert.equal(resolved.backend, "windows-native");
  // When the Windows side is not ready, the run must fail loudly instead of
  // recording with Playwright's bundled Chromium, which renders fonts
  // differently from the browser the user actually sees.
  if (!resolved.unavailable) {
    assert.deepEqual(resolved.warnings, []);
  } else {
    assert.match(resolved.reason, /unavailable/i);
    assert.ok(resolved.warnings.some((w) => /bundled Chromium/.test(w)));
  }
  // The bundled browser stays available, but only when it is asked for.
  assert.equal(resolveBackend("local-playwright").backend, "local-playwright");
});

/* ------------------------------------------------------------------ */
/* The browser channel: the user's own browser, not a different build   */
/* ------------------------------------------------------------------ */

test("an auto channel uses the installed browser and falls back to Chromium", async () => {
  const { resolveLaunchChannel, launchOptionsFor } = await import("../scripts/capture.mjs?channel-auto");
  const plan = { browser: { channel: "auto", headless: true } };
  assert.equal(
    resolveLaunchChannel(plan, { detect: () => "chrome" }),
    "chrome",
    "the branded browser wins so the demo uses the fonts the user sees"
  );
  assert.deepEqual(launchOptionsFor(plan, { detect: () => "chrome" }), { headless: true, channel: "chrome" });
  assert.equal(
    resolveLaunchChannel(plan, { detect: () => null }),
    "chromium",
    "with no branded browser installed, the bundled one is the only option"
  );
  assert.deepEqual(launchOptionsFor(plan, { detect: () => null }), { headless: true });
  // An explicit choice is never overridden by detection.
  assert.equal(resolveLaunchChannel({ browser: { channel: "msedge" } }, { detect: () => "chrome" }), "msedge");
});

