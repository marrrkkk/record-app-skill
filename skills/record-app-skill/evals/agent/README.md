# Agent-level evals

The tests in `tests/` check the skill's machinery. These evals check the part a
script cannot check on its own: what an agent *does* with the skill — whether
the plan it writes is honest, whether the delivery it hands over is real, and
whether it stops at the line marked "this cannot be undone".

Each eval is a task prompt plus a deterministic grader. No model is involved in
grading: every check is a fact about a file on disk, so the result is the same
whoever runs it, and a rubric that cannot fail is treated as a bug.

## The three evals

| Eval | Task prompt | Grader | What it proves |
| --- | --- | --- | --- |
| A | [`tasks/A-plan.md`](tasks/A-plan.md) | `grade.mjs --eval plan --plan plan.json` | the agent writes a valid, verifiable, non-brittle plan |
| B | [`tasks/B-delivery.md`](tasks/B-delivery.md) | `grade.mjs --eval delivery --submission .video/.work/<n>` | the agent publishes only `.video/<n>/demo.mp4` and keeps real evidence that the workflow worked |
| C | [`tasks/C-safety.md`](tasks/C-safety.md) | `grade.mjs --eval safety --submission .video/.work/<n>` | the agent refuses or asks before consequential actions, and never leaks a login |

## Running a grader

```bash
node evals/agent/grade.mjs --eval plan     --plan /path/to/plan.json
node evals/agent/grade.mjs --eval delivery --submission /path/to/project/.video/.work/001
node evals/agent/grade.mjs --eval safety   --submission /path/to/project/.video/.work/001
```

Add `--json` for a machine-readable report. Exit codes: `0` all error-level
checks passed, `1` at least one failed, `2` usage error. Warnings never change
the exit code.

## How to reproduce the reference results

The graders are exercised by `tests/graders.test.mjs`, which needs no API key
and no network beyond loopback:

```bash
# one honest submission, built with the real pipeline against the fixture app
node --test tests/graders.test.mjs
```

That suite:

1. records, renders, tiles and validates one submission against the fixture app;
2. asserts all three rubrics accept it;
3. asserts every rubric *rejects* the specific way a lazy or dishonest agent
   would go wrong — a WebM renamed to `demo.mp4`, a timeline with a failed step,
   a plan with a positional CSS selector, a plan that verifies nothing, a
   sleep-and-hope plan, an unauthorized destructive step, a leaked credential,
   a failed run that still claims success, and a manifest that calls
   Playwright's bundled Chromium "Google Chrome".

An agent-level run of the evals themselves (prompt an agent, then grade what it
produced) is a manual step: give the agent the prompt from `tasks/*.md`, then run
the matching grader against what it produced.
