# Task A — plan a workflow for a feature

**What this eval measures:** whether the agent, given a real application and a
one-line request, writes a plan that is honest, verifiable and recordable —
without running anything yet.

## Prompt given to the agent

> The app in `evals/fixture-app` is running locally (start it with
> `node evals/fixture-app/server.mjs --port 4319`). Using the
> `record-app-skill` skill, write a workflow plan that demonstrates creating a
> task with a priority and confirming that it appears in the list.
>
> Save the plan as `plan.json`. Do not record anything yet.

## What the agent must deliver

- `plan.json` — a workflow plan in the skill's schema.

## How it is graded

```bash
node evals/agent/grade.mjs --eval plan --plan plan.json
```

Error-level checks (any failure fails the eval):

| Check | Meaning |
| --- | --- |
| `plan.readable` | the file parses |
| `plan.valid` | it passes `validate-plan.mjs`, i.e. the skill's own schema and safety rules |
| `plan.named` | it has a title and a description |
| `plan.selectors.semantic` | no interaction is targeted through a positional CSS path (`div > div:nth-child(3)`) |
| `plan.noLongSleeps` | no step waits on a fixed timer longer than a second instead of on the UI |
| `plan.noInlineCode` | no value smuggles executable code into the plan |
| `plan.verifies` | the plan checks its own outcome |
| `plan.verifies.after` | verification comes after the action it checks |

Warning-level checks (reported, not fatal): captions on longer plans (subtitles
are opt-in and only added when the request asks for them), selector preference,
scene markers, validator warnings.

## Reference result

The plan under `tests/graders.test.mjs` (fixture: *"Add a task to the queue"*)
is the reference submission. It passes with 0 errors and 0 warnings.
