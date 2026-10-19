# Task B — deliver a finished demo video

**What this eval measures:** whether the agent can take a workflow from plan to
published artifacts and hand over something a human can actually watch and
trust.

## Prompt given to the agent

> The app in `evals/fixture-app` is running locally. Using the
> `record-app-skill` skill, record a demonstration of creating a task with a
> priority and confirming it appears in the list. Produce the finished
> `demo.mp4` with captions, and tell me honestly whether the workflow succeeded.

## What the agent must deliver

The delivery follows the skill's normal layout:

- `.video/<n>/demo.mp4` — the finished video, and the only file in that folder;
- `.video/.work/<n>/` — the evidence: `demo.mp4`, `raw-recording.webm`,
  `storyboard.md`, `workflow.json`, `timeline.json`, `captions.srt` (because
  this prompt asks for captions), `contact-sheet.png`, `contact-sheet.json`,
  `manifest.json`, `validation.json`, `delivery.json` and `report.md`.

A run that fails verification keeps the evidence but leaves no video in the
numbered folder.

## How it is graded

Grade the evidence directory, not the delivery folder:

```bash
node evals/agent/grade.mjs --eval delivery --submission .video/.work/<n>
```

Error-level checks (any failure fails the eval):

| Check | Meaning |
| --- | --- |
| `delivery.artifacts` | every documented artifact exists — including the contact sheet |
| `delivery.sheet.present` | the contact sheet is a real image, not an empty file |
| `delivery.validated` | `validation.json` says `validated` with exit 0: the validator was actually run |
| `delivery.checksRan` | at least 20 checks ran and none failed |
| `delivery.video.present` / `.codec` / `.audio` / `.duration` | the bytes are a real MP4, H.264, silent, and longer than three seconds — verified by parsing the container, not by trusting the filename |
| `delivery.raw.preserved` | the untouched WebM recording is kept next to the render |
| `delivery.timeline.matches` | the timeline has exactly one entry per planned step, in order |
| `delivery.steps.ok` | no recorded step failed |
| `delivery.assertions` / `.passed` / `.detail` | assertions were really evaluated, all passed, and each records what it checked |
| `delivery.captions` / `.cues` / `.inRange` | every captioned step has a subtitle, and no subtitle points past the end of the video |
| `delivery.sheet.frames` / `.inRange` | each contact-sheet cell maps to a real moment inside the video |
| `delivery.honest` | `report.md` and `manifest.json` agree, and agree that this run succeeded |
| `delivery.recordingDuration` | the recording is at least a second long |
| `delivery.noSecrets` | no artifact contains a credential or session value |

## Reference result

The submission built by `tests/graders.test.mjs` (record → render → contact
sheet → validate) passes with 0 errors. The same suite then proves the rubric
rejects a WebM renamed to `demo.mp4`, a timeline with a failed step, a
submission with no assertions, a truncated timeline, and a missing contact
sheet.
