/**
 * Execution-environment detection and browser-backend resolution.
 *
 * The backend answers one question: **which browser, on which operating
 * system, draws the pixels of the recording?**
 *
 *   windows-native   the Windows host's own default browser, driven by a
 *                    Windows-side worker (the WSL case: the agent runs on
 *                    Linux, the user looks at Windows)
 *   native           this host's own default browser, driven in place
 *                    (native Windows, macOS, Linux)
 *   local-playwright Playwright's bundled Chromium — the portable fallback,
 *                    used only when it is asked for
 *
 * `auto` prefers the host's real browser. It never *silently* substitutes a
 * different rendering environment: when the native browser cannot be driven,
 * the run stops with the reason and the alternatives, and the caller decides.
 *
 * Detection lives in `host-env.mjs`; this module owns the parts that need to
 * know about WSL, Windows paths and the Playwright runtime.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  BROWSER_NAMES,
  PLAYWRIGHT_NATIVE_CHANNELS,
  browserName,
  detectDefaultBrowser,
  detectHostEnvironment,
  detectInstalledBrowsers,
  detectWindowsDefaultBrowser,
  runCommand,
} from "./host-env.mjs";

// Re-exported so callers have one import for "where am I and which browser".
export { detectHostEnvironment, detectDefaultBrowser, detectInstalledBrowsers, browserName, BROWSER_NAMES };

export const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Windows-side install location for the Playwright runtime used by the worker. */
export const WINDOWS_RUNTIME_SUBPATH = path.join("AppData", "Local", "record-app-skill", "playwright-runtime");

/* ------------------------------------------------------------------ */
/* Playwright resolution                                               */
/* ------------------------------------------------------------------ */

/**
 * Resolve the Playwright module from the skill's own dependency tree.
 * The target application's node_modules is never touched or required.
 */
export function resolvePlaywright({ required = true } = {}) {
  const anchors = [];
  // The Windows worker sets this so the re-entered recorder resolves Playwright
  // from the Windows-side runtime rather than the (inaccessible) WSL one.
  if (process.env.RECORD_APP_SKILL_PLAYWRIGHT_PATH) {
    anchors.push(path.join(process.env.RECORD_APP_SKILL_PLAYWRIGHT_PATH, "package.json"));
  }
  anchors.push(
    path.join(SKILL_DIR, "package.json"),
    path.join(SKILL_DIR, "node_modules", "playwright", "package.json")
  );
  for (const anchor of anchors) {
    try {
      const req = createRequire(anchor);
      const mod = req("playwright");
      const pkgPath = req.resolve("playwright/package.json");
      const version = JSON.parse(fs.readFileSync(pkgPath, "utf8")).version;
      return { playwright: mod, version, path: pkgPath };
    } catch {
      /* try the next anchor */
    }
  }
  if (!required) return null;
  const err = new Error(
    `Playwright is not installed for this skill.\n` +
      `Install it inside the skill directory (this never modifies the target app):\n` +
      `  npm --prefix "${SKILL_DIR}" install\n` +
      `  npx --prefix "${SKILL_DIR}" playwright install chromium\n` +
      `Run "node ${path.join(SKILL_DIR, "scripts", "setup-check.mjs")}" for a full report.`
  );
  err.code = "NO_PLAYWRIGHT";
  throw err;
}

/* ------------------------------------------------------------------ */
/* WSL / Windows interop                                               */
/* ------------------------------------------------------------------ */

export function isWsl() {
  if (process.platform !== "linux") return false;
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true;
  try {
    return /microsoft|wsl/i.test(fs.readFileSync("/proc/version", "utf8"));
  } catch {
    return false;
  }
}

/** Interop binaries, with an absolute fallback for restricted PATHs. */
function interopBinary(name) {
  const found = spawnSync("which", [name], { encoding: "utf8" });
  if (found.status === 0 && found.stdout.trim()) return found.stdout.trim();
  const fallback = `/mnt/c/Windows/System32/${name}`;
  return fs.existsSync(fallback) ? fallback : null;
}

/**
 * WSL interop can fail transiently under load, so retry with a short ladder
 * before concluding that interop is unavailable.
 */
export function execInteropSync(bin, args, { timeout = 20000, encoding = "utf8" } = {}) {
  const ladder = [0, 200, 600, 1500, 2500, 4000];
  let lastErr;
  for (const delay of ladder) {
    if (delay) sleepSync(delay);
    try {
      return execFileSync(bin, args, { timeout, encoding, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function wslDistro() {
  if (process.env.WSL_DISTRO_NAME) return process.env.WSL_DISTRO_NAME;
  try {
    const out = execFileSync("wslpath", ["-w", "/"], { encoding: "utf8", timeout: 5000 }).trim();
    const m = out.match(/^\\\\wsl(?:\.localhost)?\\([^\\]+)\\/i) || out.match(/^\\\\wsl\.localhost\\([^\\]+)/i);
    if (m) return m[1];
  } catch {
    /* fall through */
  }
  return os.hostname();
}

export function findWindowsNode() {
  if (process.env.RECORD_APP_SKILL_WINDOWS_NODE) {
    const p = process.env.RECORD_APP_SKILL_WINDOWS_NODE;
    return fs.existsSync(p) ? p : null;
  }
  const onPath = interopBinary("node.exe");
  if (onPath) return onPath;
  const cmd = interopBinary("cmd.exe");
  if (!cmd) return null;
  try {
    const out = execInteropSync(cmd, ["/c", "where", "node"], { timeout: 15000 });
    const first = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (!first) return null;
    const linux = windowsPathToLinux(first);
    return linux && fs.existsSync(linux) ? linux : null;
  } catch {
    return null;
  }
}

/**
 * The Chromium-based browsers installed on the Windows side.
 *
 * From WSL the files are reached through the `/mnt/c` mount, so the same
 * search works whether the agent is inside WSL or natively on Windows.
 */
export function findWindowsBrowsers({ platform = process.platform, env = process.env } = {}) {
  const found = [];
  const roots =
    platform === "win32"
      ? [
          env["PROGRAMFILES"] && path.join(env["PROGRAMFILES"], "Google", "Chrome", "Application"),
          env["PROGRAMFILES(X86)"] && path.join(env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application"),
          env["LOCALAPPDATA"] && path.join(env["LOCALAPPDATA"], "Google", "Chrome", "Application"),
          env["PROGRAMFILES"] && path.join(env["PROGRAMFILES"], "Microsoft", "Edge", "Application"),
          env["PROGRAMFILES(X86)"] && path.join(env["PROGRAMFILES(X86)"], "Microsoft", "Edge", "Application"),
        ].filter(Boolean)
      : [
          "/mnt/c/Program Files/Google/Chrome/Application",
          "/mnt/c/Program Files (x86)/Google/Chrome/Application",
          "/mnt/c/Program Files/Microsoft/Edge/Application",
          "/mnt/c/Program Files (x86)/Microsoft/Edge/Application",
        ];
  const executables = [
    ["chrome.exe", "chrome"],
    ["msedge.exe", "msedge"],
  ];
  for (const root of roots) {
    for (const [exe, id] of executables) {
      if (found.some((b) => b.id === id)) continue;
      const p = path.join(root, exe);
      if (fs.existsSync(p)) found.push({ id, linuxPath: p, version: chromeVersionFrom(p) });
    }
  }
  return found;
}

/** The first Chromium-based browser found on the Windows side. */
export function findWindowsChrome() {
  const browsers = findWindowsBrowsers();
  if (browsers.length) return browsers[0];
  if (process.env.RECORD_APP_SKILL_WINDOWS_CHROME) {
    const p = process.env.RECORD_APP_SKILL_WINDOWS_CHROME;
    if (fs.existsSync(p)) return { id: "chrome", linuxPath: p, version: chromeVersionFrom(p) };
  }
  return null;
}

/**
 * The Windows host's registered default browser, read through WSL interop.
 *
 * `reg.exe` is invoked directly rather than through `cmd.exe /c`: a registry
 * key is not a path, so it needs no translation, and the nested quoting that
 * `cmd.exe` requires is exactly what breaks here.
 */
export function detectWindowsHostDefaultBrowser() {
  const reg = interopBinary("reg.exe") ?? "/mnt/c/Windows/System32/reg.exe";
  if (!reg || !fs.existsSync(reg)) {
    return { id: null, progId: null, source: "registry", error: "reg.exe is not reachable from this WSL distribution" };
  }
  const run = (cmd, args) => {
    if (cmd !== reg) return runCommand(cmd, args);
    try {
      const stdout = execInteropSync(reg, args, { timeout: 15000 });
      return { status: 0, stdout, stderr: "", error: null };
    } catch (err) {
      return { status: 1, stdout: err?.stdout ?? "", stderr: err?.stderr ?? "", error: String(err?.message ?? err) };
    }
  };
  return detectWindowsDefaultBrowser({ run, reg });
}

function chromeVersionFrom(exePath) {
  try {
    const dir = path.dirname(exePath);
    const versions = fs
      .readdirSync(dir)
      .filter((n) => /^\d+\.\d+\.\d+\.\d+$/.test(n))
      .sort((a, b) => {
        const pa = a.split(".").map(Number);
        const pb = b.split(".").map(Number);
        for (let i = 0; i < 4; i++) if (pa[i] !== pb[i]) return pb[i] - pa[i];
        return 0;
      });
    return versions[0] ?? null;
  } catch {
    return null;
  }
}

export function windowsLocalAppData() {
  if (process.env.RECORD_APP_SKILL_WINDOWS_LOCALAPPDATA) {
    return process.env.RECORD_APP_SKILL_WINDOWS_LOCALAPPDATA;
  }
  // Running natively under Windows: no interop needed.
  if (process.platform === "win32") {
    return process.env.LOCALAPPDATA ?? null;
  }
  const cmd = interopBinary("cmd.exe");
  if (!cmd) return null;
  try {
    const out = execInteropSync(cmd, ["/d", "/c", "echo %LOCALAPPDATA%"].filter(Boolean), { timeout: 15000 }).trim();
    const line = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).pop();
    return line && /^[a-zA-Z]:\\/.test(line) ? line : null;
  } catch {
    return null;
  }
}

/** Convert a WSL/Linux path to a Windows path the Windows side can open. */
export function linuxPathToWindows(linuxPath) {
  const abs = path.resolve(linuxPath);
  const m = abs.match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
  if (m) return `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, "\\")}`;
  try {
    const out = execFileSync("wslpath", ["-w", abs], { encoding: "utf8", timeout: 5000 }).trim();
    if (out) return out;
  } catch {
    /* fall through to UNC */
  }
  const distro = wslDistro();
  return `\\\\wsl.localhost\\${distro}${abs.replace(/\//g, "\\")}`;
}

/** Convert a Windows path to the equivalent WSL mount path when possible. */
export function windowsPathToLinux(winPath) {
  const converted = windowsPathToLinuxPure(winPath);
  return converted && fs.existsSync(converted) ? converted : null;
}

/**
 * Convert a Windows path to the WSL mount path without requiring it to exist.
 * Needed for paths that are about to be created, such as the Windows runtime
 * directory before it has been installed.
 */
export function windowsPathToLinuxPure(winPath) {
  const drive = winPath.match(/^([a-zA-Z]):[\\/](.*)$/);
  if (drive) return `/mnt/${drive[1].toLowerCase()}/${drive[2].replace(/\\/g, "/")}`;
  const unc = winPath.match(/^\\\\wsl(?:\.localhost)?\\[^\\]+\\(.*)$/i);
  if (unc) return `/${unc[1].replace(/\\/g, "/")}`;
  return null;
}

export function windowsRuntimeDirLinux() {
  const local = windowsLocalAppData();
  if (!local) return null;
  return windowsPathToLinuxPure(`${local}\\record-app-skill\\playwright-runtime`);
}

export function windowsRuntimeDirWindows() {
  const local = windowsLocalAppData();
  if (!local) return null;
  return `${local}\\record-app-skill\\playwright-runtime`;
}

/**
 * The Windows-side runtime directory in *this process's* path flavour, so the
 * same code works both from WSL (Linux path) and inside the Windows worker
 * (Windows path).
 */
export function windowsRuntimeDir() {
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA;
    return local ? path.join(local, "record-app-skill", "playwright-runtime") : null;
  }
  return windowsRuntimeDirLinux();
}

/** Playwright's binary cache for the platform this process is running on. */
export function localPlaywrightCacheDir() {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (process.platform === "win32") {
    return process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "ms-playwright") : null;
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Caches", "ms-playwright");
  }
  const xdg = process.env.XDG_CACHE_HOME;
  const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), ".cache");
  return path.join(base, "ms-playwright");
}

/**
 * Playwright's binary cache on the Windows side, in this process's path
 * flavour. Under Windows this is the local cache; from WSL it is derived from
 * the Windows %LOCALAPPDATA%.
 */
export function windowsPlaywrightCacheDir() {
  if (process.platform === "win32") return localPlaywrightCacheDir();
  const local = windowsLocalAppData();
  return local ? windowsPathToLinuxPure(`${local}\\ms-playwright`) : null;
}

/**
 * The ffmpeg revision a given Playwright install expects.
 *
 * Playwright pins ffmpeg downloads by revision (for example `ffmpeg-1013`), and
 * a stale revision from an older Playwright is *not* usable. Reading the
 * revision from Playwright's own `browsers.json` avoids guessing or hardcoding.
 */
export function expectedFfmpegRevision(playwrightCoreDir) {
  if (!playwrightCoreDir) return null;
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(playwrightCoreDir, "browsers.json"), "utf8"));
    const entry = (manifest.browsers ?? []).find((b) => b.name === "ffmpeg");
    return entry?.revision ? String(entry.revision) : null;
  } catch {
    return null;
  }
}

/**
 * Locate Playwright's ffmpeg binary, optionally requiring an exact revision.
 *
 * `page.screencast` needs this build to mux the raw recording. It is a separate
 * per-user download from the browser, so it can be missing even when everything
 * else is installed.
 */
export function findPlaywrightFfmpeg({ cacheDir = null, revision = null } = {}) {
  const dir = cacheDir ?? localPlaywrightCacheDir();
  if (!dir || !fs.existsSync(dir)) return null;
  let names;
  if (revision) {
    names = [`ffmpeg-${revision}`];
  } else {
    try {
      names = fs.readdirSync(dir).filter((n) => n.startsWith("ffmpeg"));
    } catch {
      return null;
    }
  }
  for (const name of names) {
    for (const exe of ["ffmpeg-win64.exe", "ffmpeg.exe", "ffmpeg-linux", "ffmpeg-mac"]) {
      const candidate = path.join(dir, name, exe);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** Playwright's ffmpeg as required by the skill's own (local) Playwright. */
export function findLocalPlaywrightFfmpeg() {
  return findPlaywrightFfmpeg({ revision: localFfmpegRevision() });
}

/** Playwright's ffmpeg as required by the Windows-side runtime. */
export function findWindowsPlaywrightFfmpeg() {
  return findPlaywrightFfmpeg({
    cacheDir: windowsPlaywrightCacheDir(),
    revision: windowsFfmpegRevision(),
  });
}

/** The ffmpeg revision the Windows-side Playwright expects, or null if unknown. */
export function windowsFfmpegRevision() {
  const runtimeDir = windowsRuntimeDir();
  if (!runtimeDir) return null;
  return expectedFfmpegRevision(path.join(runtimeDir, "node_modules", "playwright-core"));
}

/** The ffmpeg revision that the skill's own (local) Playwright expects. */
export function localFfmpegRevision() {
  return expectedFfmpegRevision(path.join(SKILL_DIR, "node_modules", "playwright-core"));
}

/* ------------------------------------------------------------------ */
/* Backend resolution                                                  */
/* ------------------------------------------------------------------ */

/**
 * Inspect every prerequisite for the Windows-native backend.
 *
 * Returns a structured report so callers can explain *why* a backend is
 * unavailable instead of failing vaguely. The browser facts are reported
 * separately from the plumbing, because they fail for different reasons and
 * are fixed in different places.
 */
export function detectWindowsBackend() {
  const report = {
    wsl: isWsl(),
    interop: false,
    node: null,
    browsers: [],
    // The browser that would be launched when nothing better is known.
    chrome: null,
    // The browser Windows itself records as the user's default.
    defaultBrowser: null,
    runtimeLinuxPath: null,
    runtimeInstalled: false,
    playwrightVersion: null,
    ffmpeg: null,
    reasons: [],
  };
  if (!report.wsl) {
    report.reasons.push("not running inside WSL");
    return report;
  }
  report.interop = Boolean(interopBinary("cmd.exe"));
  if (!report.interop) report.reasons.push("Windows interop (cmd.exe) is not available from this WSL distribution");

  report.node = findWindowsNode();
  if (!report.node) {
    report.reasons.push(
      "Windows Node.js was not found; install Node.js for Windows (https://nodejs.org) to record with the host's own browser"
    );
  }
  report.browsers = findWindowsBrowsers();
  report.chrome = report.browsers[0] ?? null;
  report.defaultBrowser = detectWindowsHostDefaultBrowser();
  if (!report.browsers.length) {
    report.reasons.push(
      "Google Chrome or Microsoft Edge was not found on the Windows side (looked in C:\\Program Files and C:\\Program Files (x86))"
    );
  }
  report.runtimeLinuxPath = windowsRuntimeDirLinux();
  if (report.runtimeLinuxPath && fs.existsSync(report.runtimeLinuxPath)) {
    const pkg = path.join(report.runtimeLinuxPath, "node_modules", "playwright", "package.json");
    if (fs.existsSync(pkg)) {
      report.runtimeInstalled = true;
      try {
        report.playwrightVersion = JSON.parse(fs.readFileSync(pkg, "utf8")).version;
      } catch {
        /* version is advisory only */
      }
    } else {
      report.reasons.push(
        `the Windows Playwright runtime exists at ${report.runtimeLinuxPath} but is incomplete; run scripts/win/setup-runtime.mjs`
      );
    }
  } else {
    report.reasons.push(
      "the Windows Playwright runtime is not installed; run: node scripts/win/setup-runtime.mjs"
    );
  }
  report.ffmpeg = findWindowsPlaywrightFfmpeg();
  if (report.runtimeInstalled && !report.ffmpeg) {
    report.reasons.push(
      "Playwright's ffmpeg build is missing on the Windows side (page.screencast needs it to mux the recording); run: node scripts/win/setup-runtime.mjs"
    );
  }
  report.usable = Boolean(
    report.wsl && report.interop && report.node && report.browsers.length && report.runtimeInstalled && report.ffmpeg
  );
  return report;
}

/**
 * Choose which browser to drive on the rendering host.
 *
 * The order is deliberate:
 *
 *   1. what the user explicitly asked for;
 *   2. the host's registered default browser;
 *   3. any branded browser that is installed.
 *
 * A default that exists but cannot be driven natively is **not** silently
 * replaced by an installed one: that is the substitution this skill exists to
 * prevent, so it is reported as unavailable with the alternatives.
 */
export function selectBrowser({ requestedChannel = null, defaultBrowser = null, installed = [] } = {}) {
  const installedById = new Map(installed.map((b) => [b.id, b]));
  if (requestedChannel && requestedChannel !== "auto") {
    const found = installedById.get(requestedChannel);
    return {
      ok: Boolean(found),
      id: requestedChannel,
      source: "user-selected",
      browser: found ?? null,
      reason: found
        ? `the requested browser (${browserName(requestedChannel)}) is installed`
        : `the requested browser (${browserName(requestedChannel)}) is not installed on the rendering host`,
    };
  }
  if (defaultBrowser?.id) {
    if (PLAYWRIGHT_NATIVE_CHANNELS.includes(defaultBrowser.id)) {
      return {
        ok: true,
        id: defaultBrowser.id,
        source: "system-default",
        browser: installedById.get(defaultBrowser.id) ?? null,
        reason: `${browserName(defaultBrowser.id)} is the registered default browser`,
      };
    }
    return {
      ok: false,
      id: defaultBrowser.id,
      source: "system-default",
      browser: installedById.get(defaultBrowser.id) ?? null,
      reason: `${browserName(defaultBrowser.id)} is the registered default browser, and this skill cannot drive it natively`,
    };
  }
  const fallback = installed.find((b) => PLAYWRIGHT_NATIVE_CHANNELS.includes(b.id)) ?? null;
  if (fallback) {
    return {
      ok: true,
      id: fallback.id,
      source: "system-installed",
      browser: fallback,
      reason: `no registered default browser could be read; ${browserName(fallback.id)} is installed and will be used`,
    };
  }
  return {
    ok: false,
    id: null,
    source: "none",
    browser: null,
    reason: "no branded browser is installed on the rendering host",
  };
}

/**
 * Why a default browser cannot be driven, and what to do instead.
 *
 * The alternatives are concrete: the browsers that *are* installed, and the
 * flag that accepts the portable build.
 */
export function nativeAlternatives({ selection, installed = [], portableAvailable = true } = {}) {
  const alternatives = [];
  const others = installed
    .filter((b) => PLAYWRIGHT_NATIVE_CHANNELS.includes(b.id) && b.id !== selection.id)
    .map((b) => `${browserName(b.id)} is installed — select it explicitly with browser.channel = "${b.id}"`);
  alternatives.push(...others);
  if (portableAvailable) {
    alternatives.push(
      'record with the portable build instead: --backend local-playwright (Playwright\'s bundled Chromium renders fonts differently)'
    );
  }
  return alternatives;
}

/** The requirements a native backend has that this skill does not fulfil yet. */
function nativeRequirements(browserId) {
  if (browserId === "safari") {
    return [
      "SafariDriver (ships with macOS at /usr/bin/safaridriver) with Safari ▸ Develop ▸ Allow Remote Automation enabled",
      "macOS Screen Recording permission for the terminal that runs the recording",
    ];
  }
  if (browserId === "firefox") {
    return [
      "geckodriver, plus a Firefox build that geckodriver can attach to (Playwright's Firefox is a patched build, not your Firefox)",
    ];
  }
  return [];
}

/**
 * Decide which backend to use.
 *
 * Returns a description of the *rendering environment*:
 *
 *   backend   windows-native | native | local-playwright
 *   strategy  windows-worker | playwright-channel | playwright-bundled
 *   channel   the browser that will be launched
 *   browser   { id, name, source, version }
 *   host      the operating system the pixels come from
 *
 * `unavailable` is set when the request cannot be honoured as stated. The
 * caller decides what to do about it; nothing is substituted silently.
 */
export function resolveBackend(requested = "auto", options = {}) {
  const {
    channel = null,
    environment = null,
    detectDefault = null,
    detectInstalled = null,
  } = options;

  const warnings = [];
  const host = environment ?? detectHostEnvironment();
  const requestedChannel = channel && channel !== "auto" ? channel : null;

  const base = { requested, host, windows: null, warnings };

  // ---- the portable backend, explicitly requested --------------------
  if (requested === "local-playwright") {
    const installed = detectInstalled ? detectInstalled() : installedBrowsersFor(host);
    const explicit = requestedChannel ? installed.find((b) => b.id === requestedChannel) : null;
    return {
      ...base,
      backend: "local-playwright",
      strategy: "playwright-bundled",
      reason: "explicitly requested",
      channel: explicit ? explicit.id : "chromium",
      browser: explicit
        ? { id: explicit.id, name: browserName(explicit.id), source: "user-selected", version: explicit.version ?? null }
        : { id: "chromium", name: "Chromium (Playwright build)", source: "playwright-bundled", version: null },
      installed,
      defaultBrowser: null,
      alternatives: [],
      unavailable: false,
    };
  }

  // ---- inside WSL the rendering host is Windows ----------------------
  if (host.wsl) {
    const windows = detectWindowsBackend();
    const selection = selectBrowser({
      requestedChannel,
      defaultBrowser: windows.defaultBrowser?.id ? { id: windows.defaultBrowser.id } : null,
      installed: windows.browsers,
    });
    const plumbingOk = windows.usable;
    const usable = plumbingOk && selection.ok;
    return {
      ...base,
      backend: "windows-native",
      strategy: "windows-worker",
      windows,
      channel: selection.id,
      browser: selection.browser
        ? {
            id: selection.browser.id,
            name: browserName(selection.browser.id),
            source: selection.source,
            version: selection.browser.version ?? null,
          }
        : { id: selection.id, name: selection.id ? browserName(selection.id) : null, source: selection.source, version: null },
      installed: windows.browsers,
      defaultBrowser: windows.defaultBrowser,
      reason: usable
        ? `WSL detected; recording with ${browserName(selection.id)} on the Windows host (${selection.reason})`
        : !plumbingOk
          ? `the Windows prerequisites are missing: ${windows.reasons.join("; ")}`
          : selection.reason,
      requirements: !usable && !plumbingOk ? windows.reasons : [],
      alternatives: usable
        ? []
        : nativeAlternatives({ selection, installed: windows.browsers }),
      unavailable: !usable,
      warnings: usable
        ? []
        : [
            "refusing to fall back to Playwright's bundled Chromium: it renders fonts differently from the " +
              "browser the user actually uses. Install the Windows prerequisites, or pass --backend local-playwright to accept it.",
          ],
    };
  }

  // ---- `windows-native` only means something on Windows --------------
  if (requested === "windows-native" && host.renderPlatform !== "win32") {
    return {
      ...base,
      backend: "windows-native",
      strategy: "windows-worker",
      channel: null,
      browser: null,
      reason: `the windows-native backend needs a Windows host; this run is on ${hostLabel(host)}`,
      requirements: ["run on Windows, or on WSL with a reachable Windows host"],
      alternatives: ['use --backend native for this host, or --backend local-playwright for the portable build'],
      unavailable: true,
    };
  }

  const installed = detectInstalled ? detectInstalled() : installedBrowsersFor(host);
  const defaultBrowser = detectDefault ? detectDefault() : defaultBrowserFor(host);

  // ---- a native browser on this host ---------------------------------
  const selection = selectBrowser({ requestedChannel, defaultBrowser, installed });

  if (requested === "native" || requested === "windows-native" || requested === "auto") {
    if (selection.ok) {
      return {
        ...base,
        backend: "native",
        strategy: "playwright-channel",
        channel: selection.id,
        browser: {
          id: selection.id,
          name: browserName(selection.id),
          source: selection.source,
          version: selection.browser?.version ?? null,
        },
        installed,
        defaultBrowser,
        reason: `${selection.reason} (${hostLabel(host)})`,
        alternatives: [],
        unavailable: false,
      };
    }

    // The default browser is known and cannot be driven natively. Falling back
    // to a different browser would change the rendering environment without
    // saying so, so the request is reported as unavailable instead.
    const hasKnownDefault = Boolean(defaultBrowser?.id);
    if (!hasKnownDefault && requested === "auto") {
      // Nothing claims to be the user's default and no branded browser is
      // installed: the portable build is the only thing there is, so `auto`
      // uses it and says so.
      return {
        ...base,
        backend: "local-playwright",
        strategy: "playwright-bundled",
        channel: "chromium",
        browser: {
          id: "chromium",
          name: "Chromium (Playwright build)",
          source: "playwright-bundled",
          version: null,
        },
        installed,
        defaultBrowser,
        reason: `no native browser is available on ${hostLabel(host)}; using Playwright's bundled Chromium`,
        alternatives: [],
        unavailable: false,
        warnings: [
          "no branded browser is installed on the rendering host, so the recording uses Playwright's bundled Chromium, " +
            "which renders fonts differently from Chrome or Edge. Install Chrome or Edge for native fidelity.",
        ],
      };
    }

    return {
      ...base,
      backend: "native",
      strategy: selection.id === "safari" ? "safaridriver" : selection.id === "firefox" ? "geckodriver" : "unsupported",
      channel: selection.id,
      browser: {
        id: selection.id,
        name: selection.id ? browserName(selection.id) : null,
        source: selection.source,
        version: null,
      },
      installed,
      defaultBrowser,
      reason: selection.reason,
      requirements: nativeRequirements(selection.id),
      alternatives: nativeAlternatives({ selection, installed }),
      unavailable: true,
    };
  }

  return {
    ...base,
    backend: "local-playwright",
    strategy: "playwright-bundled",
    channel: "chromium",
    browser: { id: "chromium", name: "Chromium (Playwright build)", source: "playwright-bundled", version: null },
    installed,
    defaultBrowser,
    reason: `unknown backend "${requested}"; using the portable build`,
    alternatives: [],
    unavailable: false,
  };
}

/** A human label for the rendering host. */
export function hostLabel(host) {
  switch (host?.kind) {
    case "wsl-windows":
      return `the Windows host (from WSL ${host.distro ?? ""})`.replace("  ", " ").trim();
    case "windows":
      return "Windows";
    case "macos":
      return "macOS";
    case "linux":
      return host.distroName ?? host.distro ?? "Linux";
    default:
      return host?.shellPlatform ?? "this host";
  }
}

/** The branded browsers installed on the rendering host. */
function installedBrowsersFor(host) {
  const platform = host?.renderPlatform ?? process.platform;
  if (platform === "win32") {
    return findWindowsBrowsers().map((b) => ({ id: b.id, path: b.linuxPath, version: b.version }));
  }
  return detectInstalledBrowsers({ platform }).map((b) => ({ id: b.id, path: b.path, version: null }));
}

/** The registered default browser on the rendering host. */
function defaultBrowserFor(host) {
  const platform = host?.renderPlatform ?? process.platform;
  if (platform === "win32") {
    if (host?.wsl) {
      const detected = detectWindowsHostDefaultBrowser();
      return detected.id ? { id: detected.id, source: "system-default", detail: detected.progId } : null;
    }
    const detected = detectWindowsDefaultBrowser();
    return detected.id ? { id: detected.id, source: "system-default", detail: detected.progId } : null;
  }
  const detected = detectDefaultBrowser({ host, platform });
  return detected.id ? { id: detected.id, source: detected.source, detail: detected.detail } : null;
}

/**
 * The user's own browser, if this machine has one.
 *
 * "Native" means the branded browser the developer already uses, because that
 * is the one whose fonts, zoom level and rendering the demo should match.
 * Returns "chrome", "msedge", "chromium" or null.
 */
export function detectSystemBrowserChannel({ platform = process.platform, env = process.env } = {}) {
  if (platform === "win32") {
    for (const browser of findWindowsBrowsers({ platform, env })) return browser.id;
    return null;
  }
  if (platform === "darwin") {
    const apps = [
      ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "chrome"],
      ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "msedge"],
      ["/Applications/Chromium.app/Contents/MacOS/Chromium", "chromium"],
    ];
    for (const [candidate, channel] of apps) {
      if (fs.existsSync(candidate)) return channel;
    }
    return null;
  }
  // Linux: only the branded browsers count. A distribution's `chromium` package
  // is a different build from Playwright's bundled one, but neither is the
  // Chrome the developer installed.
  const found = spawnSync("which", ["google-chrome", "google-chrome-stable", "microsoft-edge", "chromium"], {
    encoding: "utf8",
  });
  const names = (found.stdout ?? "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  for (const name of names) {
    const base = path.basename(name);
    if (base === "google-chrome" || base === "google-chrome-stable") return "chrome";
    if (base === "microsoft-edge") return "msedge";
    if (base === "chromium") return "chromium";
  }
  return null;
}


/** Quick HTTP reachability probe used before recording and by setup checks. */
export async function probeUrl(rawUrl, { timeoutMs = 8000 } = {}) {
  const attempts = [];
  let target;
  try {
    target = new URL(rawUrl);
  } catch {
    return { ok: false, resolvedUrl: null, attempts: [{ url: rawUrl, error: "invalid URL" }] };
  }
  const candidates = [target.toString()];
  // Chromium may prefer IPv4 while a server listens only on IPv6, or vice versa.
  // Under WSL in NAT mode, Windows can only reach the WSL server through the
  // forwarded "localhost" name, while inside WSL "127.0.0.1" is the safe form.
  // Trying both removes a whole class of false "server is down" reports.
  if (target.hostname === "localhost" || target.hostname === "127.0.0.1") {
    const alt = new URL(target.toString());
    alt.hostname = target.hostname === "localhost" ? "127.0.0.1" : "localhost";
    candidates.push(alt.toString());
  }
  for (const candidate of candidates) {
    const started = Date.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(candidate, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: { "user-agent": "record-app-skill/setup-check" },
      });
      clearTimeout(timer);
      attempts.push({ url: candidate, status: res.status, ms: Date.now() - started });
      return { ok: true, resolvedUrl: candidate, status: res.status, attempts };
    } catch (err) {
      attempts.push({ url: candidate, error: err?.name === "AbortError" ? "timed out" : String(err?.message ?? err), ms: Date.now() - started });
    }
  }
  return { ok: false, resolvedUrl: null, attempts };
}
