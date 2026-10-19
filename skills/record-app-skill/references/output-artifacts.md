# Output artifacts

One successful run produces two sibling folders under `.video` in the project
(or current) directory:

```
.video/
├── 001/
│   └── demo.mp4                 ← the only file in the delivery folder
└── .work/
    └── 001/
        ├── raw-recording.webm   ← the browser's untouched output
        ├── storyboard.md
        ├── workflow.json
        ├── app.json             ← what the recording was made against
        ├── timeline.json
        ├── captions.srt         ← only when captions were requested
        ├── contact-sheet.png
        ├── contact-sheet.json
        ├── manifest.json
        ├── validation.json
        ├── delivery.json
        ├── build.log            ← only when a production build failed
        ├── server.log           ← only when the production server failed
        ├── plan.for-recorder.json ← only for windows-native recordings
        ├── windows-worker.json  ← only for windows-native recordings
        └── report.md
```

The numbered folder is the deliverable. It contains **only** the finished
video, so it can be attached or embedded without exposing the raw recording or
the application's internal state. Everything needed to audit the claim stays in
the hidden `.work` folder with the same number.

`run-demo.mjs` allocates the next number atomically. Nothing is overwritten: if
`.video/001` or `.video/.work/001` exists, the next run gets `002`. A failed run
keeps `.video/.work/<n>` for diagnosis but does not publish a numbered video
folder.

## The one-command path

```bash
node scripts/run-demo.mjs --plan plan.json --quality high --fps 60
```

It runs the four deterministic stages — record, render, contact sheet,
validate — and prints a handoff block containing a `file://` URL for the video.
Defaults are `--quality high` (CRF 18, preset `slow`) and `--fps 60`.

The low-level scripts keep their historical layout when `--out-dir` is passed:
they create timestamped run directories (for example
`/tmp/demo/create-a-task-20261019-041500Z/`) with all artifacts side by side.
That path is useful for debugging and is what the unit and acceptance tests use;
it is not the delivery layout.

## `demo.mp4`

The finished video. The version and dimensions are exactly what was captured —
no resize, crop or upscale — and there is no audio track. Validated by
decoding, not by assumption; see [`video-quality.md`](video-quality.md).

Only `validated` and `partial` runs are delivered. A
`verification-failed` or `recording-failed` run never puts a file in the
numbered folder, even if an earlier stage managed to encode something.

## `raw-recording.webm`

VP9/WebM, written by the browser, preserved deliberately. Never delete it: it
is what makes the MP4 checkable (the render can be reproduced from it), and it
is the fallback when the encoder settings turn out wrong.

## `workflow.json`

The plan as executed, with defaults filled in — so the run is self-describing
even if the original plan file is later edited. The same object that the
recorder validated.

## `app.json`

What the recording was made against.

| Field | Notes |
| --- | --- |
| `mode` | `production` (the application was built and served) or `existing` (whatever already served `baseUrl`) |
| `root` | the application directory |
| `build.command`, `build.script`, `build.durationMs`, `build.ok` | the production build that was run |
| `serve.command`, `serve.script`, `serve.url`, `serve.ok` | the server that served it, and the URL that answered |

The same information is in `manifest.json` under `app`.

## `build.log` and `server.log`

Written only when the production build or the production server failed. They
hold the tail of that process's output, so a failure is diagnosable without
re-running anything.

## `plan.for-recorder.json`

Written only for `windows-native` recordings: the plan as handed to the
Windows worker, with the URL that answered. The `app` section is left out on
purpose — the application is already built and serving, and the worker must
not build it a second time.

## `timeline.json`

The record of the run, in capture wall-clock milliseconds.

| Field | Meaning |
| --- | --- |
| `captureDurationMs` | the time the recording covered — the video's own length, not the encoder's flush |
| `captureSetupMs` | time spent starting the encoder before the first frame |
| `captureTeardownMs` | time spent flushing and closing the file after the last frame |
| `recordedAt` | ISO timestamp |
| `fps` | capture frame rate |
| `viewport` | the captured size |
| `status` | `recorded` or `failed` |
| `steps[]` | one entry per executed step |
| `scenes[]` | scene boundaries with their step ids |
| `warnings[]` | everything the recorder noticed but did not fail on |

Each step entry:

| Field | Meaning |
| --- | --- |
| `id`, `index`, `action`, `title` | identity and description |
| `scene` | scene label, if any |
| `caption`, `captionWindow` | caption text and the window it was displayed in (`startMs`, `endMs`); absent when captions are off |
| `status` | `ok`, `failed`, or `failed-optional` |
| `selector`, `selectorStrategy`, `assertSelector` | what was actually targeted, in readable form |
| `startedAtMs`, `endedAtMs`, `durationMs` | timing relative to the start of the capture |
| `assertion` | `{ passed, checks: [{ kind, passed, detail }] }` — one entry per expectation key |
| `error` | `{ name, message, locator }` when the step failed |
| `optional` | whether a failure was allowed |

## `captions.srt`

Standard SRT, present only when captions were requested. Captions are **off by
default**; a plan opts in with a `caption` step or a `caption` field, unless it
sets `"captions": { "enabled": false }`. One cue per captioned step, in video
time, each at least 800 ms long so it is readable even when its step was fast.

## `contact-sheet.png` and `contact-sheet.json`

The image is a grid of frames, each labelled with its timestamp, what it shows
(`Verified: …`, `Failed: …`, `Opening state`, `Final state`) and its step.
Duplicate, merged and clamped cells are labelled as such — the sheet is not
allowed to imply a frame is something it is not.

`contact-sheet.json` describes the grid and each cell: `timeSeconds` (in the
video), `sourceTimeSeconds` (in the timeline), `kind`, `label`, `stepId`,
`file`, plus `mergedSteps` and `clamped` when they apply.

## `manifest.json`

Provenance. If a question is "how was this produced?", the answer is here.

| Field | Notes |
| --- | --- |
| `skill`, `schemaVersion`, `generatedAt`, `startedAt` | identity and time |
| `workflow` | title, description, baseUrl, startRoute, step count |
| `backend` | `requested`, `resolved`, `strategy`, `reason`, `channel`, `channelRequested`, `headless` |
| `backend.browser` | `id`, `name`, `source` (`system-default`, `system-installed`, `user-selected` or `playwright-bundled`) and `version` — the browser that really drew the frames, and where it came from |
| `app` | `mode`, `root`, and what was built and served (see `app.json`) |
| `environment` | `platform` (the operating system that rendered), `shellPlatform` (where the agent ran), `hostKind`, `hostLabel`, arch, Node version, OS release, Playwright version, browser version |
| `capture` | fps, viewport, device scale factor, cursor/caption/chapter settings, typing and scroll pacing, recorded duration |
| `capture.rendering` | the rendering settings in force: `locale`, `colorScheme`, `reducedMotion` (`system` when the host's own preference is used), plus `fontsInjected`, `applicationCssOverridden` and `grayscaleProfile`, which are always `false`/`off` |
| `media` | the intended render settings, including the quality preset |
| `safety` | `allowConsequential`, `authorizedOnCommandLine`, `allowedHosts`, `authMode`, `storageStateFile` |
| `files` | the artifacts that exist, by role |
| `render` | added by `render-video.mjs`: encoder, quality preset, crf, preset, output bytes |
| `status` | `recorded` or `failed` |

`backend.browser.source` is the field that answers "is this really the user's
browser?". `playwright-bundled` means the portable build was used, and the
manifest never describes it as the user's own.

On a `windows-native` run, `windows-worker.json` is also written. It is the
delegation report from the host-side worker: paths, the browser it selected
and why, Playwright version, exit code, stderr tail and URL probe. It is
evidence, not a deliverable, and it stays in the hidden `.work` folder.

## `validation.json`

Written by `validate-video.mjs` (and by the recorder for runs that failed
before recording). Read `status` and `counts` first.

| `status` | Exit | Meaning |
| --- | --- | --- |
| `validated` | 0 | the workflow succeeded and every check passed |
| `verification-failed` | 5 | the recording exists, but steps or assertions failed |
| `partial` | 5 | only steps marked `optional` failed |
| `recording-failed` | 6 | no usable video was produced |

Other fields: `summary` (one sentence), `media` (the probed properties of
`demo.mp4`), `checks[]` (`id`, `description`, `passed`, `severity`, `expected`,
`actual`, `detail`), `counts`, `failedChecks`, `warningChecks`, `notes`, and
`steps[]` (per-step outcome, whether it was verified, selector and timing).

`media.probeSource` says whether the properties came from `ffprobe` or from the
built-in parser; both are used and cross-checked.

## `delivery.json`

Written by `run-demo.mjs` after validation. On a delivered run it records the
video URL, absolute paths, quality preset, frame rate, media properties, step
and assertion counts, validation counts, and the evidence path. On a failed run
it records `delivered: false`, the status and the reason.

This is the file an automated client should read. The same information is
printed as the final handoff block.

## `report.md`

The one file to read if you only read one. It starts with the status, then the
run (application, backend, browser, versions, duration, video properties), then
a per-step result table, then the failed or warned checks with their detail,
then how to proceed. `run-demo.mjs` appends a `## Delivery` section with the
video URL and the numbered folder.

On a failed run it is rewritten to say so — including when nothing was recorded
at all, in which case it explains what was tried, what to check, and (for a
missing dependency) the exact install command.

## Failure directories

A run that fails before recording — an invalid plan, a missing dependency, an
unreachable application, an output conflict, a manual-auth run without a
terminal — still writes evidence into `.video/.work/<n>/` containing
`manifest.json` (with `status` set to the failure class, `exitCode`, and the
error message) and `report.md`. The empty numbered folder is removed, so a
failure never looks like a delivered video. A refusal during plan validation,
before any directory is allocated, leaves nothing behind at all.

## Exit codes

| Code | Name | Meaning |
| --- | --- | --- |
| 0 | `OK` | success |
| 1 | `INTERNAL` | a bug in the skill |
| 2 | `INVALID_PLAN` | the plan or the arguments are wrong, or an action was not authorized |
| 3 | `OUTPUT_CONFLICT` | a file already exists; ask before using `--force` |
| 4 | `MISSING_DEPENDENCY` | the browser engine, Playwright runtime or FFmpeg is missing |
| 5 | `WORKFLOW_FAILED` | a step or an assertion did not hold |
| 6 | `ENVIRONMENT_FAILED` | the application was unreachable, or nothing could be recorded |

Every script uses the same table, so a wrapper can branch on the code without
parsing output. `--json` gives the same information as a document, including
`runDir`/`workDir` on failures — read `report.md` from that directory for the
detail. `run-demo.mjs` exits 0 for `validated` and `partial` (the video was
delivered), and with the failing stage's code otherwise.
