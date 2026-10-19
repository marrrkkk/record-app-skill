# Design plan — `record-app-skill`

Internal design record. Written after inspecting three prior-art projects, the
Agent Skills specification, current OpenCode skill discovery, the current
Playwright recording APIs, and the Chrome DevTools Protocol `Page` domain, and
after running local spikes against this machine.

## 1. What the prior art already covers

| Capability | Status in the field |
| --- | --- |
| Agent writes a JSON step list, Playwright replays it, `recordVideo` yields `.webm` | Commodity (`renuo/record-demo-agent-skill`, `jh941213/web-demo-skills`) |
| FFmpeg speed-up / trim / zoom / burned captions → H.264 MP4 | Commodity (`jh941213`) |
| Storage-state auth to skip a login screen | Commodity (both recorder projects) |
| Human demonstration → event stream → generated skill | Solved (`ugarchance/record-and-replay-skill`, 45★) |
| Media validation: `ffprobe` assertions, full decode, contact sheet | Demonstrated (`jh941213`) |
| **Verifying the product claim**, not just the container | Open gap |
| **Target-platform (native Windows) rendering fidelity** | Open gap |
| **Honest partial-failure reporting** | Open gap — most tools exit 0 with a plausible MP4 |

Notably `ugarchance` deliberately records **no video**, and `renuo` explicitly
admits "functional recording only". Two of the three ship **no LICENSE file**
(`renuo` claims MIT in prose only; `jh941213` grants nothing).

## 2. Decisions

### 2.1 Capture primitive — `page.screencast`, not `recordVideo`, not raw CDP

Three candidates were compared.

**(a) Playwright `recordVideo` context option.** Commodity, but:
- It cannot record a context that Playwright did not create, which breaks the
  CDP-attach path.
- It forces the video to exist for the context's whole lifetime; there is no
  way to record only the workflow. Verification-only pre-roll and
  post-run teardown end up in the file.
- `video.size` is a footgun: if omitted, the output is the viewport *scaled down
  to fit inside 800×800*, never upscaled (1280×720 → 800×450).

**(b) Raw CDP `Page.startScreencast` + own encoder.** Maximum control, but
requires hand-writing frame acknowledgement, bounded queues, timestamp
reconciliation from sparse change-driven frames, and our own VP9/MP4 encoding.
That is a large amount of code whose only benefit over (c) is raw frame timing,
which a 60 fps product demo does not need — even less so now that the default
capture rate is 60 fps and the browser supplies the timing. Chromium-only.

**(c) `page.screencast` (Playwright ≥ 1.59). Chosen.**
Verified by local spike against Playwright 1.64.1:

- `page.screencast.start({ path, size, fps })` → precise start/stop around the
  workflow, writing WebM directly. `stop()` finalizes it.
- `page.screencast.showActions({ cursor: 'pointer', style: {…} })` renders the
  agent's **real pointer movement** as an animated cursor. The click point and
  target highlight are deliberately suppressed: a product demo should look
  like a person using the app, not an annotated test run. This satisfies the
  "visible cursor" requirement without an OS cursor, without a post-processing
  cursor, and without us injecting any DOM.
- `page.screencast.showOverlay(html, { duration })` renders captions using the
  browser's own font stack — no font file, no `drawtext` dependency.
- `page.screencast.showChapter(title, { description, duration })` provides
  chapter cards for free.
- `hideActions()` / `hideOverlays()` / `disposable.dispose()` give real teardown.

Measured spike output: VP9, 1280×720, `avg_frame_rate=30/1`, CFR, matroska/webm,
decodes clean with `ffmpeg -f null -`.

Leak found and fixed in the spike: `showActions` defaults to a *title overlay
containing the raw Playwright selector* (e.g. `Click getByRole('button', { name: 'Create task' })`).
That is developer noise in a product demo, so the recorder sets
`style: { title: 'display: none' }` and supplies its own captions instead.

### 2.2 Render step — system FFmpeg is mandatory for MP4

Measured, decisive constraint: Playwright's bundled FFmpeg is built with
`--disable-everything` and only:

```
--enable-encoder=libvpx_vp9 --enable-decoder=libvpx_vp9
--enable-muxer=webm   --enable-muxer=image2
--enable-filter=pad   --enable-filter=crop   --enable-filter=scale
```

It has **no H.264 encoder, no MP4 muxer, no `drawtext`, no `subtitles`, no
`setpts`, no `fps` filter**. Therefore it cannot produce the required H.264/MP4
deliverable and cannot convert the raw variable-timing WebM to CFR.

Consequence, designed in rather than papered over: the render step **requires
system `ffmpeg`**, and when it is absent the run ends with a valid
`raw-recording.webm`, a clear installation message, and exit code 4 — never a
claim that `demo.mp4` exists. This is eval scenario 6.

### 2.3 Captions — in-page overlay, with SRT as a portable side artifact

Burning captions with `drawtext`/`subtitles` needs `libfreetype`, a font file
path, and correct escaping. Rendering them in-page via `showOverlay` needs
none of that, uses the same font the app under test uses, and is testable.
Captions are opt-in and off by default; when a plan asks for them,
`captions.srt` is emitted as well for portability and for players that prefer
sidecar subtitles.

### 2.4 Browser backends

The backend answers one question: **which browser, on which operating system,
draws the pixels?** Automation (Playwright) and rendering (the browser) are
kept apart on purpose, because a recording is only faithful if the rendering
half is right.

- `native` — the rendering host's **registered default browser**, driven in
  place. The default is read from the place the OS records it: the registry
  (`UserChoice\ProgId`) on Windows, the Launch Services handler list on
  macOS, `xdg-settings` on Linux.
- `windows-native` — the Windows host's browser, driven by a Windows-side
  worker. This is the WSL case: the agent runs on Linux, the user looks at
  Windows, so a demo rendered with a Linux Chromium would show the wrong
  fonts and the wrong text antialiasing.
- `local-playwright` — the portable build: Playwright's bundled Chromium.
  Explicitly requested, never chosen silently.
- `auto` — detect the rendering host and use its real browser.

The rendering host is detected **separately from the shell the agent runs
in**. Inside WSL the two differ, and the manifest records both
(`environment.platform` = `win32`, `environment.shellPlatform` = `linux`).

Deliberate simplification versus a sibling screenshot-only skill: that
skill needed a `windows-cdp` attach mode because screenshots over CDP were
acceptable. Here, Playwright must *launch* the browser for `page.screencast`
to exist, so `windows-native` launches Chrome through Playwright's `chrome`
channel rather than attaching over CDP. One less mode, and it is the mode that
actually records video.

A default browser that cannot be driven natively — Firefox, Safari, Brave —
is **not** silently replaced by an installed one. Playwright's Firefox and
WebKit are patched upstream builds, not the installed products, so recording
in one and calling it "your browser" would be exactly the misrepresentation
this skill exists to prevent. The run stops with the requirement and the
alternatives.

Cross-boundary facts that must be respected (learned from the same sibling
skill): WSL interop does **not** forward environment variables to Windows
processes, so everything travels as argv; path translation goes
`/mnt/<drive>` → `C:\…`, else `wslpath -w`, else `\\wsl.localhost\<distro>\…`.

### 2.4.1 Browser isolation

Native fidelity must not mean access to a personal session. Playwright's
`launch()` uses a throwaway profile, so the everyday profile, its cookies,
its extensions and its history are never opened; no `--user-data-dir` is
passed and no remote debugging *port* is opened (Chrome 136+ refuses one on
the default profile anyway). The test suite checks the launched browser's
actual command line, not just the options this code passes.

### 2.5 Verification before, during, and after

Three tiers, because "the click worked" is not evidence the feature worked:

1. **Plan validation** — schema, step-type allow-list, selector shape,
   prohibited actions, URL allow-list. No arbitrary JavaScript is representable.
2. **Runtime assertions** — each step may declare an `expect`; the recorder
   evaluates it and records a structured outcome. A failed required assertion
   stops the run and is never reported as success.
3. **Artifact validation** — ffprobe metadata against the requested config,
   full-file decode, no audio stream, timeline/scene cross-references, secret
   scan of every text artifact, contact sheet over real captured frames.

### 2.6 Output safety

Run directories are timestamped; an existing directory is never overwritten
(exit 3). Raw recording, timeline, and manifest are preserved on failure — they
are the diagnostic evidence.

## 3. Consequences / accepted limitations

- H.264 MP4 requires system FFmpeg. Accepted; documented; degrades honestly.
- `page.screencast` output is VP9/WebM; the MP4 is a transcode, so the raw WebM
  is retained deliberately as the fidelity reference.
- Native Safari and native Firefox are **not** driven. Playwright cannot drive
  the installed Safari or Firefox at all, and the drivers that can
  (SafariDriver, geckodriver) need a setup step this skill does not perform on
  the user's behalf — `safaridriver --enable` needs an administrator password,
  and Safari ▸ Develop ▸ Allow Remote Automation is a per-machine setting.
  macOS recordings therefore need Chrome or Edge, and the run says so rather
  than substituting Playwright's WebKit and calling it Safari.
- Windows-native cannot be tested on a machine without Windows. On a machine
  *with* Windows it can, and was — see §4. (Unit tests cover the argument and
  path translation regardless of platform.)
- Captions are burned at record time, so changing caption text requires a
  re-record. `captions.srt` mitigates this for downstream editing.
- No native desktop application support in v1 (out of scope by design).

## 4. As built — what was verified, and what was not

Written after implementation, from the actual test runs (not from intent).

**Verified on this machine (Linux/Arch under WSL2, Windows 11 host):**

- Full pipeline, portable backend: fixture app → plan → record → render →
  contact sheet → validate = `validated`, exit 0, 1440×900 H.264 at 60 fps.
- Full pipeline, `windows-native` backend: recorded in **native Windows
  Chrome 155.0.8059.80** through the WSL→Windows delegation, then rendered and
  validated on the Linux side. The manifest says `platform: win32`,
  `shellPlatform: linux`, `backend.browser.source: system-default`,
  `backend.browser.version: 155.0.8059.80` — the browser that really ran.
- The Windows host's default browser is read from the registry
  (`HKCU\…\UrlAssociations\https\UserChoice\ProgId` → `ChromeHTML`) and
  honoured; a default that cannot be driven is refused with alternatives
  instead of being replaced.
- The Windows browser reaches the WSL application through forwarded localhost
  in NAT mode; the worker probes the URL from the Windows side before
  recording and reports the addresses it tried when it cannot.
- Browser isolation, checked against the launched browser's real command line:
  the profile is a temporary directory, never the everyday one, and no
  remote-debugging port is opened.
- Every documented failure mode, against a real app in a real browser:
  missing selector and false assertion → exit 5 with the failing step named and
  no MP4; unreachable app → exit 6 with remediation; missing system FFmpeg →
  exit 4 with the raw WebM preserved; existing `demo.mp4` → exit 3 with the file
  byte-for-byte intact; manual auth without a terminal → exit 2 pointing at
  `storage-state`; consequential action → exit 2 until both keys are present.
- Overlay non-interference (cursor/caption elements cannot intercept a click or
  shift layout) in its own test file.
- Each command's *human-readable* path too, not only `--json`: running the
  documented commands end to end found a `ReferenceError` hidden in
  `build-contact-sheet.mjs`'s friendly output (every test had used `--json`).
  `tests/cli-output.test.mjs` now runs record → render → contact sheet →
  validate the way the README tells a person to, and fails on a stack trace
  anywhere in that output.
- Two contract deviations on the delegated Windows path, found the same way and
  fixed: an unreachable app exited 5 (workflow failure) instead of 6
  (environment failure), and a worker failure left a run directory with only
  `windows-worker.json` — no `manifest.json`, no `report.md`. Both backends now
  share one implementation of "a run directory that explains itself"
  (`writeFailureReport`), and the worker speaks the same exit-code contract
  (2/4/6) instead of worker-local codes.
- One measurement bug, found by the larger 1440×900 capture under a parallel
  test load: the reported `captureDurationMs` included the time the encoder
  spent *flushing the file* after the last frame. On a loaded machine that is
  several seconds, so a correct take was reported as far shorter than the
  video and the validator failed it. The duration now measures the recording
  window, and the setup and teardown are recorded separately
  (`captureSetupMs`, `captureTeardownMs`).
- `skills-ref validate` (official, PyPI 0.1.1): "Valid skill".
- OpenCode discovery: placing the skill at `.opencode/skills/record-app-skill`
  made it appear in the running session's skill list mid-session, with the name
  and description taken from `SKILL.md` frontmatter.
- 157 tests green, including 24 backend/isolation tests and 3 end-to-end
  native-recording tests.

**Not verified, and why:**

- **macOS and Safari.** This machine is Linux/WSL, so the macOS paths are
  covered by unit tests over injected detection (Launch Services parsing, the
  SafariDriver requirement, the refusal to substitute WebKit) and by the
  capability matrix in `references/browser-backends.md`. No macOS run has
  happened. A macOS owner should expect the first real run to need the
  `--backend native` path checked by hand.
- **Native Firefox.** Not implemented, on purpose: Playwright's Firefox is a
  patched build, and geckodriver is a second automation stack. The run says
  so and offers the alternatives.
- The interactive branch of `auth.mode: "manual"` (a human pressing Enter in a
  headed browser) was exercised only in its refusal path, because this
  environment has no TTY to press Enter in. The refusal path is the one a
  non-interactive agent hits, so it is the one that matters for automation; the
  happy path still deserves a manual smoke test before heavy use.
- Visual inspection of the video beyond extracted frames (caption overlay, mouse
  cursor, chapter card, frame at a recorded step) was done by eye from PNG
  frames, not by watching playback in a player.
- The hosted CI run covers the portable backend only: the `ubuntu-latest`
  runner has no Windows host, no branded browser and no native macOS, so the
  native-browser path is exercised locally on the Windows/WSL machine and
  unit-tested elsewhere. The runner also has no system FFmpeg by default, so
  the workflow installs one — the same requirement the skill states.
- The contact sheet needs a system font for its labels; on a machine with none
  the sheet is still produced, but the labels are skipped (and it says so).
