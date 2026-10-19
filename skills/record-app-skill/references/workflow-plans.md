# Workflow plans

A plan is a JSON document that describes one workflow: where to go, what to do,
what each step should prove, and how the recording should look. It is data, not
code — there is no expression, no `evaluate`, and no injection action, and a
plan that contains one is rejected rather than executed.

Validate a plan with:

```bash
node scripts/validate-plan.mjs --plan plan.json
node scripts/validate-plan.mjs --plan plan.json --show-normalized   # defaults applied
```

`validate-plan.mjs` exits `0` when the plan is valid and `2` when it is not,
listing every error. `--json` returns a report that includes each step's
resolved ids, target, assertion target, and whether it was flagged as
consequential.

## Top-level fields

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `schemaVersion` | number | `1` | must be `1` |
| `title` | string | — | required; used on the title card and in reports |
| `description` | string | — | strongly recommended; shown on the title card |
| `baseUrl` | string | — | required; the application's origin |
| `startRoute` | string | `/` | where the recording opens |
| `steps` | array | — | required; at least one |
| `maxDurationMs` | number | `240000` | hard bound; also settable per run with `--max-duration-ms` |
| `browser` | object | see below | backend, channel, viewport, rendering settings, headless, timeout |
| `capture` | object | see below | frame rate, cursor, captions, chapters, settle time |
| `app` | object | `{ "mode": "existing" }` | which build to record against; see [`production-builds.md`](production-builds.md) |
| `auth` | object | `{ "mode": "none" }` | see [`authentication-and-safety.md`](authentication-and-safety.md) |
| `safety` | object | `{ "allowedHosts": [], "allowConsequential": false }` | see the same |
| `output` | object | `{ "dir": ".video" }` | base directory for numbered deliveries |
| `media` | object | `{ "container": "mp4", "videoCodec": "h264", "fps": 60, "quality": "high", "crf": 18, "preset": "slow" }` | render settings |

### `browser`

| Field | Default | Notes |
| --- | --- | --- |
| `backend` | `"auto"` | `auto`, `native`, `local-playwright`, `windows-native` — see [`browser-backends.md`](browser-backends.md) |
| `channel` | `"auto"` | `auto` uses the host's registered default browser; `chrome`, `msedge` or `chromium` force one. Firefox and Safari are not supported: Playwright's builds of them are patched upstream builds, not the installed products |
| `viewport` | `{ "width": 1440, "height": 900 }` | the captured size; the video keeps it exactly. A mobile workflow asks for `{ "width": 390, "height": 844 }` |
| `deviceScaleFactor` | `1` | keep at 1 for portable, predictable output |
| `headless` | `true` | `--headed` overrides for a single run |
| `timeoutMs` | `15000` | per-action timeout |
| `locale` | `null` | `null` is the host's own locale; a BCP 47 tag such as `"en-GB"` overrides it |
| `colorScheme` | `null` | `null` is the host's own preference; `light`, `dark` or `no-preference` override it |
| `reducedMotion` | `null` | `null` is the host's own preference; `reduce` or `no-preference` override it |

`null` is the default for the last three on purpose. Playwright's own
defaults force a light colour scheme and no motion preference over whatever
the system is set to, so a recording would not look like the machine it came
from. The values actually in force are written to the manifest.

### `app`

The application the recording is made against. `"existing"` records against
whatever already serves `baseUrl`; `"production"` builds the application and
serves the built output, which is what keeps a demo free of the lag a
development server adds.

| Field | Default | Notes |
| --- | --- | --- |
| `mode` | `"existing"` | `existing` or `production` |
| `root` | the plan's directory | where the application lives |
| `build` | `null` | the npm script that produces the production build |
| `serve` | `null` | the npm script that serves the built output |
| `url` | `baseUrl` | where the served application is reachable |
| `buildTimeoutMs` | `600000` | how long the build may take |
| `readyTimeoutMs` | `60000` | how long the server may take to answer |

A plan names npm scripts; it never carries a shell command. See
[`production-builds.md`](production-builds.md).

### `capture`

| Field | Default | Notes |
| --- | --- | --- |
| `fps` | `60` | constant; the source of truth for the rendered file |
| `settleMs` | `500` | quiet time held after each step, so a frame shows the result |
| `typingDelayMs` | `45` | delay between keystrokes when a `fill` step types; `0` pastes instantly |
| `scrollDurationMs` | `550` | eased scroll duration; `0` jumps (not recommended for delivery) |
| `smoothScroll` | `true` | animate scrolling rather than teleporting |
| `cursor.enabled` | `true` | renders the pointer only — no click point or target highlight |
| `cursor.duration` | `800` | how long the pointer annotation remains after an action |
| `captions.enabled` | `false` | overlay captions and `captions.srt`; opt in only when asked |
| `captions.duration` | `2800` | how long a caption stays on screen |
| `chapters.enabled` | `false` | title cards and scene markers; opt in only when asked |
| `chapters.duration` | `1800` | how long a chapter card stays visible |

`captions.enabled` and `chapters.enabled` default to the absence of the thing
they describe: if the plan contains no `caption` step/field and no
`checkpoint`, they stay off. If the plan does contain one, they turn on
automatically. An explicit `false` always wins.

### `media` quality

| Quality | CRF | x264 preset | Use |
| --- | --- | --- | --- |
| `high` | 18 | `slow` | default |
| `balanced` | 20 | `medium` | smaller files |
| `compact` | 23 | `medium` | quick reviews |

An explicit `crf` or `preset` overrides the corresponding preset field.

## Steps

Every step has an `id` (stable, referenced by the timeline, the report, the
contact sheet and the evals), an `action`, and usually a `target`.

| Field | Notes |
| --- | --- |
| `id` | required in practice; if omitted, a stable `${index}-${action}` id is derived and written back by validation |
| `action` | required; one of the actions below |
| `title` | human name used in the storyboard and reports |
| `caption` | text shown while this step runs |
| `scene` | scene label; steps sharing one are grouped in the storyboard |
| `target` | how to find the element (see below) |
| `assertOn` | check a different element after the action (for example, the dialog that opened) |
| `expect` | what should be true; required for `assert` and used by `waitFor` |
| `timeoutMs` | per-step override |
| `consequential` | mark a step that leaves the browser, when the wording alone would not make that obvious |
| `optional` | a failure is recorded as `failed-optional` and does not fail the run |

### Actions

| Action | Extra fields | Does |
| --- | --- | --- |
| `goto` | `path` or `url` | navigate (same-origin `path` preferred) |
| `click` | `target` | click, auto-waiting for the element to be actionable |
| `fill` | `target`, `value` | focus, clear, then type at a human pace |
| `select` | `target`, `value` | choose an `<option>` by value or label |
| `check` / `uncheck` | `target` | set a checkbox or radio |
| `press` | `target` (optional), `key` | key press, on the element or the page |
| `hover` | `target` | move the pointer and hold |
| `scroll` | `target` or `y` (or neither, for the bottom of the page) | ease the element or position into view |
| `waitFor` | `target`, `state`, `expect` | wait for a state, then check the expectation |
| `assert` | `target`, `expect` | check a state without waiting for a change |
| `caption` | `text`, `durationMs` | optional narration; opts captions in and produces a subtitle entry |
| `checkpoint` | `title`, `description`, `durationMs` | optional chapter card and scene boundary; opts chapters in |
| `pause` | `ms` | pacing only; keep it short |

### Targets

A target is an object with exactly one strategy (plus an optional `index` when a
strategy legitimately matches several elements):

```json
{ "role": "button", "name": "Create task" }
{ "label": "Task name" }
{ "placeholder": "e.g. Write the recording skill" }
{ "testId": "submit-create" }
{ "text": "Draft the launch note", "exact": true }
{ "css": "#project-name" }
```

Preference order — use the first that works:

1. `role` + `name` — what a screen reader sees, the most stable across redesigns
2. `label` / `placeholder` — form fields, tied to what the user reads
3. `testId` — deliberate test hooks (`data-testid` and friends)
4. `text` — visible copy; fine, but it changes when the marketing team does
5. `css` — last resort, and never a positional path such as
   `div > div:nth-child(3)`; that breaks on the next unrelated change

`index` is zero-based and only used when a strategy matches several elements on
purpose (for example, the second row of a list).

### Expectations

| Key | Checks |
| --- | --- |
| `visible` / `hidden` | visibility |
| `text` / `notText` | text content contains / does not contain |
| `value` | an input's value |
| `url` | the current URL matches (substring or pattern) |
| `count` | the number of matches |
| `state` | an explicit element state (`attached`, `detached`, `visible`, `hidden`) |
| `timeoutMs` | how long to keep trying before failing |

Several keys may be combined; each becomes its own recorded check with a
human-readable detail, which is what makes the timeline provable after the
fact.

## Worked example

```json
{
  "schemaVersion": 1,
  "title": "Create a project",
  "description": "Fill in the project form and confirm the dashboard shows it.",
  "baseUrl": "http://127.0.0.1:4319",
  "startRoute": "/projects",
  "steps": [
    { "id": "open", "action": "goto", "path": "/projects" },
    { "id": "name", "action": "fill", "target": { "label": "Project name" }, "value": "Atlas migration" },
    { "id": "owner", "action": "fill", "target": { "label": "Owner" }, "value": "Ada Lovelace" },
    { "id": "priority", "action": "select", "target": { "label": "Priority" }, "value": "High" },
    { "id": "submit", "action": "click", "target": { "testId": "create-project" } },
    { "id": "landed", "action": "waitFor", "target": { "testId": "project-name" },
      "expect": { "visible": true, "text": "Atlas migration" } },
    { "id": "verify-owner", "action": "assert", "target": { "testId": "project-owner" },
      "expect": { "text": "Ada Lovelace" } }
  ]
}
```

Add `caption` steps or a `checkpoint` only when the user asked for narration or
chapters; both are off by default.

## Plans that fail validation

Common rejections, and what they mean:

| Message | Cause |
| --- | --- |
| `unknown field "script"` | the plan tried to carry code; describe interactions instead |
| `unsupported action "eval"` | same, at the action level |
| `steps must have exactly one selector strategy` | a target mixed `testId` and `css` |
| `looks externally consequential … but safety.allowConsequential is false` | declare it in the plan *and* pass `--allow-consequential` to `record-workflow.mjs` |
| `plans must not contain secrets` | a credential was written into the plan; use `auth.storageStateFile` instead |
| `url host "…" is not allowed` | a cross-origin navigation; add the host to `safety.allowedHosts` deliberately |
| `step ids must be unique` | two steps share an id, so a report could not point at one of them |

## Writing plans that record well

- One workflow per plan. Long plans drift, get slower, and lose the viewer.
- Open on the state the workflow needs, not on a loading screen.
- Wait for something meaningful after each state change; that wait is also the
  moment the viewer reads the result.
- Add captions only when they were requested, and keep them to phases rather
  than clicks.
- Let fields be typed and scrolling ease by default; shorten the workflow
  instead of turning the human pacing off.
- Leave destructive steps out unless the user asked for them — and read
  [`authentication-and-safety.md`](authentication-and-safety.md) before adding
  one.
