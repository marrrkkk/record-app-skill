# Context and token discipline

The skill spends tokens where judgement is needed — reading the app, choosing
the steps, deciding what success means — and nothing more. Everything else is
a deterministic script, and a deterministic script should never be paid for
with model reasoning.

This is not about being brief for its own sake. A demo that was not verified
is worse than no demo, so nothing here removes a check, a safety rule or a
failure report.

## What the agent decides, and what the scripts do

| The agent decides | The scripts do |
| --- | --- |
| which workflow to show, and what proves it worked | launching the browser, navigating, clicking, typing |
| which selectors describe the UI honestly | waiting, asserting, recording, encoding |
| what a caption says, and where a scene starts | the frame timeline, the contact sheet, the media checks |
| whether a consequential action is acceptable | the manifest, the report, the exit code |

The plan is the hand-over point: once it validates, the rest of the run
needs no further reasoning.

## Keep the exploration narrow

1. Read the repository root and the package scripts. That tells you the
   framework and how the app starts.
2. Find the routes the workflow touches — the router file, not the router
   *directory*.
3. Read the components behind those routes, and only those.
4. Open another file only to resolve a dependency or an ambiguity.

Do not read the whole tree. Exclude `node_modules`, `dist`, `build`, `out`,
`.next`, `.nuxt`, `coverage`, `.git`, caches, lockfiles, generated clients and
unrelated features.

## Do not rediscover what this run already knows

Each fact is established once:

| Fact | Established by |
| --- | --- |
| the rendering host, the default browser, the backend | `node scripts/env-detect.mjs` |
| which routes and controls exist | the one inspection pass |
| which browser the plan will use | the plan's `browser` block, or `auto` |
| whether the app is reachable | the recorder's own preflight |

If `env-detect.mjs` has already said which browser will be used, do not probe
`which chrome` again. If a plan validated, do not re-validate it by hand.

## Read the output, not the machinery

Every script writes a short summary and keeps the detail on disk:

| Script | Prints | Keeps |
| --- | --- | --- |
| `env-detect.mjs` | the host, the browser, the backend, what is missing | — |
| `setup-check.mjs` | one line per component, with the fix | — |
| `record-workflow.mjs` | the run directory, the backend, the browser, the step counts | `timeline.json`, `manifest.json`, `raw-recording.webm` |
| `render-video.mjs` | the encoder settings and the size | `demo.mp4` |
| `build-contact-sheet.mjs` | where the sheet is | `contact-sheet.png` |
| `validate-video.mjs` | the status and the check counts | `validation.json`, `report.md` |

Read `report.md` when a run fails. Do not read `timeline.json`,
`validation.json` or `manifest.json` unless a specific field is needed — the
handoff block already carries the counts.

## Look at pictures, not frames

The contact sheet exists so that a visual review does not need a hundred
screenshots in the conversation. Open the sheet; if something is wrong, look
at the one frame that shows it. Never paste extracted frames into the chat.

Captions come from the storyboard, which is derived from the plan and the
timeline — the model does not analyse frames to write them.

## One plan, one run

- Inspect once, plan once, validate once, record once, verify once.
- Retry only the failed step when the recording architecture allows it;
  otherwise re-run the smallest part and keep the original evidence.
- Do not rewrite the plan after a successful action, and do not re-inspect the
  application after every step.

## When to ask

Ask only when:

- the workflow or the success signal is genuinely ambiguous;
- the browser backend needs a setup step on the user's machine;
- the authentication route is undecided;
- an action has significant consequences.

Everything else is decided by the plan and the scripts.
