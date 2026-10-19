# Browser backends

The recording runs in a real browser. Which browser — and on which side of the
WSL boundary — is what the backend decides.

Two things are kept apart on purpose:

- **automation** — what drives the browser (Playwright here);
- **rendering** — which browser, on which operating system, draws the pixels.

A recording is only faithful if the rendering half is right, and a recording
is only possible if the automation half is.

## The capability matrix

| Host | Default browser | Automation | Recording | Needs from the user |
| --- | --- | --- | --- | --- |
| **WSL** (agent on Linux, user on Windows) | the Windows host's registered default (Chrome, Edge) | Playwright on the Windows side, through a Windows-side worker | Playwright's screencast, muxed by Playwright's own FFmpeg on the Windows side | Windows Node, the Windows Playwright runtime, `node scripts/win/setup-runtime.mjs` |
| **Windows** (native) | the registered default (Chrome, Edge) | Playwright launches the installed browser | same screencast path | nothing beyond the browser itself |
| **macOS** | Chrome or Edge | Playwright launches the installed browser | same screencast path | nothing beyond the browser itself |
| **macOS** | Safari | SafariDriver — **not implemented in this version** | would need macOS Screen Recording permission | `safaridriver --enable` and Safari ▸ Develop ▸ Allow Remote Automation |
| **Linux** | Chrome, Edge, Chromium | Playwright launches the installed browser | same screencast path | the browser itself |
| **Linux** | Firefox | geckodriver — **not implemented in this version** | — | geckodriver and a Firefox it can attach to |
| **any** | no branded browser | Playwright's bundled Chromium | same screencast path | nothing |
| **any** | an explicit `--backend local-playwright` | Playwright's bundled Chromium | same screencast path | nothing |

"Not implemented" means the run **stops with the reason and the
alternatives**. It never silently records in a different browser, and it never
calls Playwright's WebKit "Safari" or Playwright's Firefox "your Firefox":
those are patched upstream builds, not the installed products, and the fonts
they draw are not the fonts the user sees.

## Choosing a backend

| `browser.backend` | Behaviour |
| --- | --- |
| `auto` (default) | detect the rendering host and use its real browser; never substitute |
| `native` | the host's registered default browser, or an error explaining why not |
| `local-playwright` | the portable build: Playwright's bundled Chromium (or the channel the plan names) |
| `windows-native` | the Windows host's browser; the explicit name for the WSL case, kept for existing plans |

`browser.channel` names the browser inside a backend: `auto` (the host's
default), `chrome`, `msedge` or `chromium`. An explicit channel is honoured
when the browser is installed, and refused with a clear message when it is
not.

```bash
node scripts/env-detect.mjs                       # host, browser, backend
node scripts/env-detect.mjs --backend native      # what a specific backend would do
node scripts/setup-check.mjs --backend windows-native
```

## The rendering host is not the shell

The single most important fact about this skill: **the operating system the
agent runs in is not necessarily the operating system the user looks at.**

| Where the agent runs | Where the frames come from |
| --- | --- |
| inside WSL | the Windows host |
| natively on Windows | Windows |
| natively on macOS | macOS |
| natively on Linux | Linux |

`env-detect.mjs` reports both (`shellPlatform` and `renderPlatform`) and the
manifest records both, so a recording made from WSL says `platform: win32`
and `shellPlatform: linux`. A demo rendered on the wrong operating system
would show the wrong fonts, the wrong scrollbars and the wrong text
antialiasing.

## Inside WSL: the Windows host is the target

The agent and the application source may live in a WSL distribution such as
Arch Linux. That distribution is *not* the rendering platform: the user is
looking at Windows, and a demo made with a Linux Chromium shows Linux fonts
and Linux rendering.

So inside WSL the recording is delegated:

1. `scripts/win-exec.mjs` finds Windows Node, the Windows Playwright runtime
   and the Windows browsers.
2. The Windows default browser is read from the registry (see below).
3. `scripts/win/worker.mjs` runs **the same recorder script** under Windows
   Node, so there is one executor rather than two, and the Windows side
   launches the installed browser through Playwright's `chrome`/`msedge`
   channel.
4. The recording is written into the same run directory, and the manifest is
   written by the side that actually recorded.

Three facts about WSL interop shape the implementation, and each one has
cost a real debugging session:

- **Environment variables do not cross the boundary.** The backend, the run
  directory, the plan path and the flags travel as arguments and as a
  generated `.cmd` batch file, never through the environment.
- **There is no shared filesystem path.** The Linux path is converted to a
  UNC path (`\\wsl.localhost\<distro>\home\...`) before Windows Node is
  invoked, and Windows paths are converted back for the report. Paths travel
  as data, not interpolated into a shell string.
- **Escaping is hostile.** A `.cmd` file with `/d /c` avoids the nested
  quoting problems of `cmd.exe /c "..."`.

### Reaching the application from Windows

The Windows browser must be able to open the approved URL, such as
`http://localhost:3000`. This depends on the WSL networking mode, so it is
checked rather than assumed:

| Mode | Windows → WSL server |
| --- | --- |
| `nat` (the default) | through forwarded localhost, while `localhostForwarding` is on |
| `mirrored` | `localhost` is shared in both directions |

`wslinfo --networking-mode` reports the mode, and `env-detect.mjs` includes
it. The Windows worker probes the URL from the Windows side *before*
recording, so an unreachable application is reported as an environment
failure with the addresses it tried — not as a browser error halfway through
the take.

**No WSL gateway address is hardcoded.** The gateway differs between NAT and
mirrored mode, and in mirrored mode there is no separate address at all.

### Setting the Windows side up

```bash
node scripts/win/setup-runtime.mjs          # into %LOCALAPPDATA%\record-app-skill\playwright-runtime
```

That single command installs a private Playwright runtime on the Windows
side, plus the browser engine it needs. It does not touch the project being
recorded, its `package.json`, or its lockfiles — the runtime lives entirely
outside the source tree.

`setup-check.mjs --backend windows-native` then verifies, in order: WSL
interop, a Windows Node, the Windows Playwright runtime, a Windows browser,
and Playwright's FFmpeg revision on the Windows side. FFmpeg on the Windows
side is not required for the MP4: the recording is written by Windows Chrome
and rendered on the Linux side, where the system FFmpeg lives.

## Finding the default browser

| Platform | Source | What it is |
| --- | --- | --- |
| Windows | `HKCU\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice\ProgId` | the key Windows itself writes when the user picks a default browser |
| macOS | the Launch Services handler list (`LSHandlerRoleAll` for `https`) | what `NSWorkspace` reads |
| Linux | `xdg-settings get default-web-browser`, then the entry's `Exec=` | the freedesktop.org mechanism |

The Windows key is read with `reg.exe`. From WSL, `reg.exe` is invoked
directly rather than through `cmd.exe /c`: a registry key is not a path, so
it needs no translation, and the nested quoting `cmd.exe` requires is
exactly what breaks.

The `ProgId` maps to a browser (`ChromeHTML`, `MSEdgeHTM`, `FirefoxURL-…`).
An unknown or unsupported `ProgId` is not a licence to pick a different
browser: the run stops and the message lists what is installed.

## Browser isolation

Native fidelity must not mean access to somebody's personal session.

- The browser is launched by Playwright, which uses a **throwaway profile**.
  The everyday profile, its cookies, extensions, history and saved passwords
  are never opened.
- No `--user-data-dir` is passed, and no remote debugging **port** is opened.
  Chrome 136 and later refuse `--remote-debugging-port` on the default
  profile anyway; the skill has no reason to open one.
- The browser's own engine and the operating system's own rendering are
  preserved: no replacement fonts, no overridden application CSS, and no
  `--disable-lcd-text`. A grayscale rendering profile is an explicit choice
  and is off by default.
- A signed-in workflow uses the existing mechanisms: a `storage-state` file
  kept outside the output directory, or a human signing in inside an
  isolated headed session.

## Recording and rendering settings

| Setting | Default | Note |
| --- | --- | --- |
| viewport | 1440×900 | the captured size; a mobile workflow asks for 390×844 |
| device scale factor | 1 | higher is sharper and larger |
| locale | the host's | `browser.locale` overrides it |
| colour scheme | the host's | `browser.colorScheme` overrides it; Playwright's own default would force light |
| reduced motion | the host's | `browser.reducedMotion` overrides it |
| frame rate | 60 | constant |
| audio | none | captions and chapters carry the narration |

Every one of these is written to the manifest, so the video can be judged
against the environment it was made in.

## Diagnosing a backend problem

| Symptom | Do |
| --- | --- |
| `env-detect.mjs` says the backend is unavailable | read `requirements` and `alternatives` in its `--json` output |
| the default browser is Firefox or Safari | the native path needs geckodriver or SafariDriver; pick an installed Chromium browser explicitly, or accept the portable build |
| WSL: "Windows interop is not available" | the distribution cannot launch Windows binaries; `cmd.exe` must be on the Windows PATH |
| WSL: "the Windows Playwright runtime is not installed" | `node scripts/win/setup-runtime.mjs` |
| WSL: the app is unreachable from Windows | check the WSL networking mode and `localhostForwarding`; bind the dev server to `0.0.0.0` if needed |
| the browser is not the one the user expected | `env-detect.mjs` shows what was detected and from where; an explicit `browser.channel` overrides detection |
| the fonts look different from the user's browser | the portable build was used; the manifest's `backend.browser.source` says `playwright-bundled` |
| a run refuses to start on macOS with Safari | SafariDriver with *Allow Remote Automation* is required, and this version does not drive Safari; select Chrome or Edge explicitly |
