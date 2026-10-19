# record-app-skill

An [Agent Skill](https://agentskills.io) that turns *"show me that this works"*
into a real screen recording of a real browser driving a real web application —
and into the evidence that the workflow actually succeeded.

The agent inspects the application, writes a small JSON plan, drives a real
browser through it, records the screen, checks that the important actions
really happened, and hands back an MP4 with a storyboard, a timeline and a
validation report.

```text
.video/001/
└── demo.mp4             ← the deliverable (the only file in this folder)
.video/.work/001/
├── raw-recording.webm   ← the browser's untouched output
├── storyboard.md        ← the workflow as a storyboard
├── workflow.json        ← exactly what was executed
├── timeline.json        ← what actually happened, per step, in milliseconds
├── contact-sheet.png    ← representative frames, labelled
├── manifest.json        ← backend, browser, versions, settings, safety audit
├── validation.json      ← the machine-readable verification result
├── delivery.json        ← the video URL and final delivery details
└── report.md            ← read this one first
```

Captions are off by default; `captions.srt` exists only when the request or the
plan asks for them. Each run gets the next number (`002`, `003`, …) and nothing
is ever overwritten.

## Agent-performed recording vs. recording a human

| | A person with a screen recorder | This skill |
| --- | --- | --- |
| What drives the UI | a human, once, by hand | a plan the agent writes and validates first |
| What proves it worked | the person's word | assertions evaluated in the browser, recorded per step with what they checked |
| What happens on failure | the take is redone | the failure is named, at a step, with the raw recording kept |
| Reproducible | no | the plan, the timeline and the environment are all on disk |
| Selectors | whatever was under the cursor | a documented preference order, chosen deliberately |
| Anything destructive | easy to do by accident | blocked until a plan *and* a caller authorize it |
| Credentials | usually visible somewhere | never in a plan, never in an artifact |

The agent does the thinking — inspecting the app, choosing a sequence worth
watching, deciding what success means. The scripts do the rest
deterministically, which is what makes the result reviewable rather than merely
plausible.

## Example request

> Record a demo showing how a user creates a quote, adds line items, saves it,
> and verifies the resulting quote.

The skill performs the actual application workflow, captures the real rendered
UI, verifies the expected outcomes, and produces a video with supporting
artifacts. Other requests that trigger it:

> Make a walkthrough of the checkout flow — the app is on http://localhost:3000.

> I need proof that the invite flow works end to end. Record it and tell me
> straight if anything failed.

> Record the delete-project flow. *(The skill refuses: that is an externally
> consequential action, and it needs your explicit go-ahead — twice.)*

## What it does

1. **Inspect** — the agent looks at the running application through its
   accessibility tree: routes, labels, test ids, what changes, what proves
   success. It reads the routes the workflow uses, not the whole repository.
2. **Plan** — a JSON workflow (`goto`, `click`, `fill`, `select`, `check`,
   `press`, `hover`, `scroll`, `waitFor`, `assert`, `caption`, `checkpoint`).
   No arbitrary JavaScript, no blind sleeps, every state change checked.
3. **Validate** — the schema, the selector preference order and the safety
   rules are checked *before* a browser is opened.
4. **Record** — the real rendered frames are captured at 60 fps by default,
   with a pointer and nothing else: no click point, no target outline.
5. **Verify** — each step's expectations are evaluated in the browser and
   recorded; the video is then decoded and cross-checked against the plan and
   the timeline.
6. **Deliver** — only `demo.mp4` is copied into the numbered folder; the
   evidence stays in `.video/.work/<n>/`, and the agent repeats the handoff
   block verbatim.

## The native-browser approach

The recording is made in **the browser the user actually has**, on **the
operating system they actually look at**. The rendering host is detected
separately from the shell the agent runs in, so an agent inside WSL records in
the Windows host's registered default browser, an agent on macOS records in
the registered default browser there, and an agent on Linux records in the
registered default browser.

A fallback is never chosen silently. When the native browser cannot be driven,
the run **stops** with the reason and the alternatives rather than recording in
a different environment and calling it the same thing. The browser always runs
in a throwaway profile: the everyday profile, its cookies, extensions and
history are never opened, and no debugging port is exposed.

One command reports the whole picture:

```bash
node scripts/env-detect.mjs
```

## Installation

The skill is distributed in the portable [Agent Skills](https://agentskills.io/specification)
format, so one copy installs into every compatible agent. The
[Skills CLI](https://github.com/vercel-labs/skills) does the installing.

```bash
# see what the repository offers
npx skills add marrrkkk/record-app-skill --list
```

Install it globally (available in every project on this machine):

```bash
# OpenCode
npx skills add marrrkkk/record-app-skill --skill record-app-skill --agent opencode --global

# Codex
npx skills add marrrkkk/record-app-skill --skill record-app-skill --agent codex --global

# Claude Code
npx skills add marrrkkk/record-app-skill --skill record-app-skill --agent claude-code --global
```

Or project-level, by dropping `--global` — the skill is then installed into the
current repository and can be committed for the whole team.

Where the Skills CLI puts it (verified with skills 1.7.4):

| Agent | Project scope | Global scope |
| --- | --- | --- |
| `opencode` | `.agents/skills/record-app-skill` | `~/.agents/skills/record-app-skill` |
| `codex` | `.agents/skills/record-app-skill` | `~/.agents/skills/record-app-skill` |
| `claude-code` | `.claude/skills/record-app-skill` | `~/.claude/skills/record-app-skill` |

The CLI keeps one canonical copy under `.agents/skills/` and links the
agent-specific directory to it, so a project install is a single directory
plus a `skills-lock.json`. OpenCode and Codex both read `.agents/skills/`;
Claude Code reads `.claude/skills/`.

Managing an installation:

```bash
npx skills list                        # what is installed
npx skills check                       # are there updates?
npx skills update record-app-skill -g  # update the global copy
npx skills remove record-app-skill -g  # remove it again
```

### Runtime setup

The Skills CLI installs the skill's files, not its dependencies. Install them
**inside the installed skill directory** — the application you are recording
keeps its own `package.json`, lockfile and source tree untouched:

```bash
cd ~/.agents/skills/record-app-skill   # or ~/.claude/skills/record-app-skill
npm install                            # Playwright
npx playwright install chromium        # the bundled browser
node scripts/setup-check.mjs           # what is missing, and how to get it
```

`setup-check.mjs` exits `0` when the machine is ready, or `4` with a list of
exactly what is missing. It never installs anything on your behalf.

`node scripts/check-install.mjs` verifies that the installed copy is complete:
`SKILL.md`, every helper script, every reference file, the runtime manifest,
and no absolute path from the machine it was built on.

## Usage

Ask the agent in the language you would use with a person:

> Record a demo showing how a user creates a quote, adds line items, saves it,
> and verifies the resulting quote.

The agent then:

- **inspects** the app and decides the story, the success signal, the start
  state and the traps (a destructive action, a foreign host, a login wall);
- **plans** a reproducible workflow as data — every step has an id, every state
  change is asserted, nothing sleeps blindly;
- **executes** it in a real browser, in the browser the user actually has;
- **verifies** each expected result in the page, and records what it checked;
- **reports** the status — `validated`, `verification-failed`, `partial` or
  `recording-failed` — quoting the failing step verbatim when something went
  wrong, and saying so plainly when there is no video.

### What the run produces

`.video/<n>/demo.mp4` is the deliverable; `.video/.work/<n>/` holds the raw
recording, the storyboard, the workflow, the timeline, the labelled contact
sheet, the manifest, the validation result and `report.md`. Nothing is
uploaded anywhere: the skill sends the recording to no server.

### Browser selection

`node scripts/env-detect.mjs` reports the host, the default browser and the
backend that would be used.

| Situation | Backend |
| --- | --- |
| Agent inside WSL | `windows-native` — the Windows host's registered default browser, driven from the Windows side |
| Agent on Windows | `native` — the host's registered default browser |
| Agent on macOS | `native` — the registered default browser; Safari needs SafariDriver, which this version does not drive |
| Agent on Linux | `native` when a Chromium browser is the default, otherwise `local-playwright` |
| CI, a container, no branded browser | `local-playwright` — the bundled Chromium |

`--backend local-playwright` is the explicit way to accept the bundled build.
It renders fonts differently from Chrome or Edge, so it is never selected
silently.

### Native Windows rendering from WSL

Inside WSL the frames must come from Windows, or the demo shows Linux fonts and
Linux text antialiasing. The skill delegates the recording to a Windows-side
worker that runs the same recorder under Windows Node:

```bash
node scripts/win/setup-runtime.mjs          # installs the Windows Playwright runtime
node scripts/setup-check.mjs --backend windows-native
```

The runtime lives in `%LOCALAPPDATA%\record-app-skill\playwright-runtime`,
outside any project. Nothing in the application being recorded is modified.

### Authentication and sensitive data

Three modes, none of which involve putting a password in a plan:

- `auth.mode: "none"` — the default.
- `auth.mode: "storage-state"` — a Playwright state file prepared beforehand.
  It must live **outside** the output directory, and the skill refuses a path
  inside it, because run directories are what people publish.
- `auth.mode: "manual"` — a headed browser opens, a human signs in, and
  recording starts only after they press Enter. Non-interactive runs refuse
  rather than record a login page.

Credentials, tokens and cookies are rejected in plans and scanned for in
artifacts. Nothing from the browser context — cookies, `localStorage`, session
headers — is written into the output.

### Recording and post-processing

Frames are captured from the real page, encoded by the system FFmpeg to
constant-frame-rate H.264 at exactly the captured dimensions, and then decoded
and cross-checked against the plan and the timeline. The default quality is
`high` (CRF 18); `balanced` and `compact` trade size for speed. Frame rate is
60 fps by default, or 30 for a smaller file.

### Failure reporting

A failure is reported as a failure. The status is `verification-failed` when
the recording happened but an assertion did not, `recording-failed` when there
is no usable video, and `partial` when only optional steps failed. The failing
step id and message are quoted verbatim, the raw recording is kept as
evidence, and the agent is told to say so rather than to claim a video exists.

## Requirements

Required:

| Dependency | Why |
| --- | --- |
| Node.js 20+ | the recorder, the validator and the CLI are Node scripts |
| Playwright | browser automation and frame capture; installed with `npm install` inside the skill directory |
| A Chromium browser | either the host's registered default (Chrome/Edge) or Playwright's bundled build |
| FFmpeg **and** FFprobe on `PATH` | H.264/MP4 encoding and media verification — Playwright's bundled FFmpeg has no H.264 encoder |

Optional, platform-specific:

| Dependency | Needed for |
| --- | --- |
| Windows Node + the Windows Playwright runtime | the `windows-native` backend (`node scripts/win/setup-runtime.mjs`) |
| A system font | labels on the contact sheet; without one the sheet is still produced and the labels are skipped |
| SafariDriver | **not** implemented — Safari is not driven |
| geckodriver | **not** implemented — Firefox is not driven |

## Compatibility

| Item | Status |
| --- | --- |
| Skill format | The portable [Agent Skills](https://agentskills.io/specification) format; validated with the reference validator (`skills-ref`) |
| Supported agents | OpenCode, Codex and Claude Code — installation verified against each; the same single package is used for all three |
| Platforms tested | Windows 11 host driven from WSL2 (native Chrome 155, `windows-native` backend) and Linux (Playwright's bundled Chromium); GitHub Actions on `ubuntu-latest` |
| Platforms not tested | macOS (unit-tested only — no macOS run has happened), native Safari, native Firefox |
| Runtime requirements | Node.js 20+, system FFmpeg/FFprobe with H.264, Playwright |
| Known limitations | Web applications only; one browser window and one page; no audio; real-time recording; the pointer is rendered by Playwright, not the OS |

The native-browser backends are exercised on the machines named above; they
are not claimed to work everywhere. A macOS owner should expect the first
`native` run to be checked by hand.

## Security and privacy

A recording is a capture of a real application, and a real application can
contain real data. **Review the video before publishing it.**

- The browser runs in a throwaway profile: no personal session, no cookies, no
  extensions, no history, and no remote-debugging port.
- Credentials are never placed in a plan, and every text artifact is scanned
  for secret-shaped content after each run.
- Authentication state files must live outside the output directory, and the
  skill refuses a path inside it.
- Destructive actions (delete, purchase, send, publish, deploy, revoke) need
  **two keys**: `"safety": { "allowConsequential": true }` in the plan *and*
  `--allow-consequential` from the caller. A plan cannot authorize itself.
- Hosts other than the application's own origin must be allow-listed
  deliberately.
- Nothing is uploaded: the browser, Node and FFmpeg are the whole stack, and
  there is no telemetry.
- Generated artifacts (`.video/`, `demo-output/`) are excluded from version
  control by `.gitignore`.

## Distribution

- Repository: <https://github.com/marrrkkk/record-app-skill>
- Agent Skills specification: <https://agentskills.io/specification>
- Skills directory: <https://skills.sh> ·
  [this skill on skills.sh](https://skills.sh/marrrkkk/record-app-skill)
- Skills CLI: <https://github.com/vercel-labs/skills> ·
  [CLI reference](https://skills.sh/docs/cli)
- OpenCode skills: <https://opencode.ai/docs/skills>
- Codex skills: <https://developers.openai.com/codex/skills>
- Claude Code skills: <https://code.claude.com/docs/en/skills>

## Development

```bash
npm run setup:skill    # install the skill's dependencies
npm test               # the whole suite
npm run check:package  # the installed-copy integrity check
```

The suite needs no API key and no network beyond loopback. It covers the plan
schema and its rejections, selector resolution, the safety rules, secret
scanning, the dependency-free WebM/MP4 parser, the contact-sheet sampling, the
browser-backend logic, the packaging integrity, and eight acceptance scenarios
that drive the whole pipeline against a bundled fixture application in a real
browser.

The design decisions and the honest list of what was and was not verified live
in [DESIGN.md](DESIGN.md).

## Repository layout

```text
record-app-skill/
├── README.md
├── LICENSE
├── DESIGN.md            the design record: what was compared, chosen and verified
├── .gitignore
├── .github/workflows/   one workflow: format, metadata and tests
├── package.json         test entry points only
└── skills/
    └── record-app-skill/    ← the installable skill
        ├── SKILL.md
        ├── scripts/
        ├── references/
        ├── assets/
        ├── evals/
        ├── tests/
        ├── package.json
        └── package-lock.json
```

## License

MIT — see [LICENSE](LICENSE).
