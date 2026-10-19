# Video quality

The recording is produced by the browser itself (`page.screencast`), encoded
with system FFmpeg, and then checked by decoding the result. This file explains
the pipeline and the settings worth changing.

## The pipeline

```
real browser  ──▶  raw-recording.webm  ──▶  demo.mp4  ──▶  checks
  (screencast,      VP9, variable-rate,     H.264, CFR,      decode + probe
   real frames)      kept untouched         no audio        + assertions
```

1. **Capture.** Playwright's screencast encodes the real rendered frames as
   VP9/WebM. It is the browser's own output — no screen-scraping, no synthetic
   frames, no HTML replica of the UI. The frames are the ones the *installed*
   browser drew, so the text, the fonts and the antialiasing are the ones the
   user sees (see
   [`browser-backends.md`](browser-backends.md)).
2. **Preserve.** `raw-recording.webm` stays in the run directory forever. It is
   the evidence that `demo.mp4` is a re-encode of something real, and it is what
   you re-render from if a setting was wrong.
3. **Render.** FFmpeg converts to H.264 with a constant frame rate so editors
   and players behave predictably, and with no audio track at all (see below).
4. **Check.** FFprobe reads the finished file back, and the whole file is
   decoded to prove it is not truncated.

### Which recording mechanism, and why

| Mechanism | Used | Notes |
| --- | --- | --- |
| `page.screencast` with a file path | **yes** | the browser writes the raw WebM; the pointer, the captions and the chapter cards are rendered by the browser itself, in the browser's own fonts, with no post-processing and no injected DOM |
| `page.screencast` with `onFrame` | no | would hand every frame to this process; more overhead, no gain here |
| `recordVideo` (the context option) | no | it records the whole context lifetime, so verification pre-roll and teardown end up in the file, and it cannot be started and stopped around the workflow |
| attaching to a running browser over CDP | no | it would need a debug port and the user's own profile; the isolation rules forbid both, and a screencast needs a browser this skill launched |

The recorded duration is the time the *video* covers. The encoder's flush
after the last frame is not part of it, and is reported separately as
`captureTeardownMs` in `timeline.json` — otherwise a slow machine would make a
complete take look truncated.

## Render settings

```bash
node scripts/render-video.mjs --run-dir .video/.work/001 \
  [--quality high] [--fps 60] [--crf 18] [--preset slow] [--ffmpeg /usr/bin/ffmpeg]
```

| Flag | Default | Effect |
| --- | --- | --- |
| `--quality` | plan's `media.quality` or `high` | `high` (CRF 18, `slow`), `balanced` (CRF 20, `medium`) or `compact` (CRF 23, `medium`) |
| `--fps` | plan's `media.fps` / `capture.fps` (60) | constant output rate |
| `--crf` | from the quality preset (18) | quality/size trade-off; lower is better and bigger |
| `--preset` | from the quality preset (`slow`) | encoder effort |
| `--ffmpeg` | auto-detected | explicit encoder path |
| `--force` | off | overwrite an existing `demo.mp4` — ask the user first |

Quality presets:

| Preset | CRF | x264 preset | Intended use |
| --- | --- | --- | --- |
| `high` | 18 | `slow` | default; sharp text and smooth motion |
| `balanced` | 20 | `medium` | smaller files, still clean UI text |
| `compact` | 23 | `medium` | quick reviews and very long flows |

The filter chain is `fps=<n>,scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p`
with `-fps_mode cfr`. The scale only rounds an odd dimension down to an even
one (H.264 requires even dimensions); it never resizes the picture. **The
output keeps the captured dimensions.** No letterboxing, no 16:9 crop, no
upscale for a marketing aspect ratio — a demo that lies about the layout is
worse than no demo.

## Natural motion

The recording is meant to look like a person using the app, not a test run:

- **60 fps by default.** Pointer movement and easing remain smooth instead of
  stepping at 30 fps.
- **The cursor is the only decoration.** There is no click point, target
  outline or field highlight. Playwright's action title is hidden so raw
  selector text never appears.
- **Fields are typed, not pasted.** A `fill` step focuses the field, clears it,
  then types at `capture.typingDelayMs` (default 45 ms) so the viewer can
  follow. Values longer than 160 characters fall back to a normal fill so a
  wall of text does not stall the demo.
- **Scrolling is eased.** Scrolling to an element, to a position, or to the
  top/bottom animates over `capture.scrollDurationMs` (default 550 ms) using
  `requestAnimationFrame`; it never teleports.
- **No synthetic pauses.** `capture.settleMs` (default 500 ms) exists only to
  let the result of an action appear in the recording.

If a run feels slow, shorten the workflow. Do not disable smooth scrolling or
typing to shave seconds off: that is the difference between a demo and a robot.


### Why CFR

The source is variable-rate: the browser emits a frame when the pixels change.
That is exactly right for a UI (nothing moves, so nothing is encoded), and
awkward for editors, whose timelines assume a constant rate. The render pins
the rate so trimming and subtitles land where the timeline says they should.

### Why no audio

There is no audio source, and `-an` guarantees none is manufactured. An empty
audio track makes some players show a muted indicator and makes file-size
comparisons meaningless. The validator fails a run that accidentally has one.

## What the validator checks

`validate-video.mjs` produces `validation.json` and a rewritten `report.md`. It
checks, among roughly thirty other things:

- every artifact exists, and `raw-recording.webm` is non-empty;
- the container is MP4, the video codec is H.264, and there is no audio stream;
- width, height and frame rate match what the plan asked for;
- the duration is plausible for the work performed — not zero, not shorter than
  the last step, not wildly longer than the capture;
- the whole file decodes without error;
- every step in `timeline.json` matches a step in `workflow.json`, in order;
- every recorded assertion passed, and each one records what it checked;
- when captions are present, each `captions.srt` cue refers to a moment that
  exists in the video (no warning is raised for a plan that simply opts out of
  captions);
- the contact sheet exists, and each of its cells samples a time inside the
  video.

Read the result in the run directory:

```bash
node scripts/validate-video.mjs --run-dir .video/.work/001 --json | jq '.status, .counts'
```

`--require-contact-sheet` makes a missing sheet fatal, which is what you want
when handing the run to a person. `--skip-decode` is faster and weaker; do not
use it for a delivery.

## Sizes and timing

Rough numbers for a 1440×900, mostly-static UI recording at the defaults:

| Length | `demo.mp4` (high, 60 fps) | Raw WebM |
| --- | --- | --- |
| 10 s | ~150–250 KB | ~0.5–1 MB |
| 30 s | ~450–750 KB | ~1.5–3 MB |

60 fps roughly doubles the frame count of 30 fps, but a static UI compresses
well; use `balanced` or `compact` when size matters more than absolute
sharpness.

Timing comes from three places, and it is worth knowing which to reach for:

- `capture.settleMs` (default 500 ms) after every step, so the frame after an
  action shows its result. Raise it if a result animates in; lower it for
  longer workflows.
- `capture.typingDelayMs` and `capture.scrollDurationMs`, which make typing and
  scrolling readable rather than instant.
- `capture.captions.duration` / `capture.chapters.duration`, which only apply
  when those features are explicitly enabled.
- the workflow's own waits (`waitFor`), which should be the only thing that
  makes a recording long, because they are waiting for the application.


`--max-duration-ms` is a hard stop (default four minutes). A recording that
hits it fails rather than silently truncating.

## Contact sheet

```bash
node scripts/build-contact-sheet.mjs --run-dir .video/.work/001 [--cols 4] [--max-frames 12] [--cell-width 480]
```

Frames are chosen at the moments that matter: the opening state, every scene
boundary, every step whose action was verified, every failure, and the closing
state. Two details keep it honest:

- **The timeline is in capture wall-clock time; the video is CFR.** Sample times
  are mapped onto the video's own clock and clamped short of the last frame,
  because a timestamp past the end decodes to nothing at all (FFmpeg exits 0
  and writes no file).
- **Deduplication never hides anything.** Opening, closing and failed frames
  win their cell over a verified step; a step whose frame could not be separated
  from a neighbour is listed in `contact-sheet.json` as `mergedSteps`, and the
  cell is labelled `(+1 more step)`. A clamped sample is labelled
  `(closest available frame)` instead of pretending it was on time.

Each cell is labelled with its timestamp, what it shows, and the step it came
from, so the sheet can be read without the plan.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| render exits 4 | no system FFmpeg; install it (Playwright's bundled build cannot make H.264) |
| render exits 3 | `demo.mp4` already exists; use `--force` only after asking the user |
| validator fails `duration` | the capture was cut short — check `--max-duration-ms` and the timeline's last step |
| validator fails `captions.inRange` | a caption window outlived the video; re-record (this is a real bug source, not a check to skip) |
| validator fails `sheet.*` | rebuild the sheet from the finished `demo.mp4` |
| the cursor is invisible | `capture.cursor.enabled` is false, or the plan overrode it |
| the cursor has a red dot or outline | an old `cursor-style.json` is still present; the current preset draws only the pointer |
| text in the video is raw selector junk | you are seeing Playwright's own annotation titles; the recorder disables them, so check for a modified `capture.mjs` |
| typing looks instant | `capture.typingDelayMs` is 0, or the value is longer than 160 characters |
| the video jumps when scrolling | `capture.smoothScroll` is false; leave it on for delivery |
| the video is much longer than the workflow | a `pause` step, or a `waitFor` timing out slowly; prefer waiting on state |
