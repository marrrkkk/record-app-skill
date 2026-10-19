/**
 * Sample selection for the contact sheet.
 *
 * This is where a recording's wall-clock timeline is mapped onto the encoded
 * video. Getting it wrong is subtle and expensive: the sheet is the artifact
 * people use to check a demo without watching it, and a sample past the last
 * frame silently produces nothing (FFmpeg exits 0 and writes no file).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { chooseSamples, describeStep } from "../scripts/build-contact-sheet.mjs";

/** A timeline shaped like the real one, in capture wall-clock time. */
const timeline = (overrides = {}) => ({
  captureDurationMs: 10092,
  scenes: [],
  steps: [
    {
      id: "open",
      action: "goto",
      title: "goto",
      status: "ok",
      selector: null,
      assertion: null,
      endedAtMs: 900,
    },
    {
      id: "verify",
      action: "waitFor",
      title: "waitFor",
      status: "ok",
      selector: 'testId="flash"',
      assertion: { passed: true, checks: [{ kind: "visible", passed: true, detail: "visible" }] },
      endedAtMs: 9595,
    },
  ],
  ...overrides,
});

test("sample times are mapped onto the video's own clock", () => {
  // The capture took 10.092s; the encoded video is 9.900s. A sample at 9.595s
  // of capture time belongs at 9.595 * (9900/10092) = 9.412s of video time.
  const samples = chooseSamples(timeline(), 9900, 12, { sourceDurationMs: 10092, guardMs: 120 });
  const verified = samples.find((s) => s.stepId === "verify");
  assert.equal(verified.ms, 9412);
  assert.equal(verified.sourceMs, 9595, "the original timeline time is kept for the report");
});

test("no sample can land past the last frame", () => {
  // Regression: the closing sample used the timeline's duration, which is
  // longer than the video, so FFmpeg was asked for a frame past the end and
  // produced an empty file.
  const samples = chooseSamples(timeline(), 9900, 12, { sourceDurationMs: 10092, guardMs: 120 });
  const limit = 9900 - 120;
  for (const sample of samples) {
    assert.ok(sample.ms <= limit, `${sample.kind} sample at ${sample.ms}ms exceeds ${limit}ms`);
    assert.ok(sample.ms >= 0, `${sample.kind} sample is negative`);
  }
  const end = samples.find((s) => s.kind === "end");
  assert.ok(end, "the closing frame must survive deduplication");
  assert.equal(end.ms, limit, "the closing sample sits at the guard limit");
  assert.equal(end.clamped, undefined, "the closing frame is chosen, not clamped");
  assert.equal(end.priority, 3, "the closing frame outranks a nearby verified step");
});

test("a nearby step is absorbed, not dropped, and clamping is reported", () => {
  const steps = [
    {
      id: "late",
      action: "assert",
      title: "assert",
      status: "ok",
      selector: 'text="x"',
      assertion: { passed: true, checks: [] },
      // 1.98s of a 2s video: the same visual moment as the closing frame.
      endedAtMs: 9900,
    },
  ];
  const samples = chooseSamples(timeline({ captureDurationMs: 10000, steps }), 2000, 12, {
    sourceDurationMs: 10000,
    guardMs: 120,
  });
  const cell = samples.find((s) => s.stepId === "late" || s.mergedSteps?.includes("late"));
  assert.ok(cell, "the step must still be represented on the sheet");
  assert.equal(cell.ms, 1880);
  assert.equal(cell.clamped, true, "the clamped time is reported, not silently applied");
  assert.deepEqual(cell.mergedSteps, ["late"], "the report names the step that shares this frame");
});

test("a failure near the end wins its cell, so the sheet cannot hide it", () => {
  const steps = [
    {
      id: "boom",
      action: "click",
      title: "click",
      status: "failed",
      selector: 'role="button" name="Delete"',
      assertion: { passed: false, checks: [] },
      endedAtMs: 9800,
    },
  ];
  const samples = chooseSamples(timeline({ captureDurationMs: 10000, steps }), 2000, 12, {
    sourceDurationMs: 10000,
    guardMs: 120,
  });
  const cell = samples.find((s) => s.stepId === "boom");
  assert.ok(cell, "a failed step must keep its own cell");
  assert.equal(cell.kind, "failed");
  assert.match(cell.label, /^Failed: /);
});

test("without a known source duration nothing is scaled, only clamped", () => {
  const samples = chooseSamples(timeline(), 9900, 12, { guardMs: 120 });
  const verified = samples.find((s) => s.stepId === "verify");
  assert.equal(verified.ms, 9595, "no scaling is invented when the source clock is unknown");
  assert.ok(samples.every((s) => s.ms <= 9780));
});

test("failed steps are sampled too, so a sheet cannot hide a failure", () => {
  const steps = [
    {
      id: "boom",
      action: "click",
      title: "click",
      status: "failed",
      selector: 'role="button" name="Nope"',
      assertion: { passed: false, checks: [{ kind: "visible", passed: false, detail: "not visible" }] },
      endedAtMs: 4000,
    },
  ];
  const samples = chooseSamples(
    timeline({ captureDurationMs: 5000, steps }),
    5000,
    12,
    { sourceDurationMs: 5000, guardMs: 120 }
  );
  const failed = samples.find((s) => s.kind === "failed");
  assert.ok(failed, "a failed step must appear on the contact sheet");
  assert.match(failed.label, /^Failed: /);
});

test("thinning keeps the first and last frame and honours the cap", () => {
  const steps = Array.from({ length: 40 }, (_, i) => ({
    id: `s${i}`,
    action: "assert",
    title: "assert",
    status: "ok",
    selector: 'text="x"',
    assertion: { passed: true, checks: [] },
    endedAtMs: i * 250 + 100,
  }));
  const samples = chooseSamples(
    timeline({ captureDurationMs: 12000, steps }),
    12000,
    12,
    { sourceDurationMs: 12000, guardMs: 120 }
  );
  assert.ok(samples.length <= 12, `cap exceeded: ${samples.length}`);
  assert.equal(samples[0].kind, "start");
  assert.equal(samples[samples.length - 1].kind, "end");
  // Still strictly ascending, so the grid reads left to right in time order.
  for (let i = 1; i < samples.length; i++) {
    assert.ok(samples[i].ms >= samples[i - 1].ms, "samples must be in time order");
  }
});

test("an unknown video duration degrades instead of failing", () => {
  const samples = chooseSamples(timeline(), 0, 12, { sourceDurationMs: 10092 });
  assert.ok(samples.length > 0, "samples are still chosen when the duration is unknown");
  assert.ok(samples.every((s) => Number.isFinite(s.ms) && s.ms >= 0));
});

test("step labels name the selector, not just the action", () => {
  assert.equal(describeStep({ action: "waitFor", title: "waitFor", selector: 'testId="flash"' }), 'waitFor testId="flash"');
  assert.equal(describeStep({ action: "click", title: "Submit the form", selector: 'role="button"' }), 'Submit the form role="button"');
  assert.equal(describeStep({ action: "goto", title: "goto", selector: null }), "goto");
  const long = describeStep({ action: "assert", title: "x".repeat(80), selector: null });
  assert.ok(long.length <= 46, `label too long: ${long.length}`);
  assert.match(long, /…$/);
});
