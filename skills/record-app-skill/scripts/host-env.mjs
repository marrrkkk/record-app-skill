/**
 * Host environment and default-browser detection.
 *
 * Two questions are answered here, and nothing else:
 *
 *   1. Which operating system is the *rendering* host? The shell the agent
 *      runs in is not necessarily the machine the user looks at: inside WSL the
 *      agent is on Linux while the user is on Windows.
 *   2. Which browser is the user's default on that host?
 *
 * Every probe is injectable, so the logic can be exercised for Windows, macOS
 * and Linux from any machine, and so a real Windows host can be probed from
 * WSL through exactly the same code path. Nothing here launches a browser or
 * writes anything: it only reads facts.
 *
 * Sources used, and why they are the right ones:
 *   Windows  HKCU `...\\UrlAssociations\\https\\UserChoice\\ProgId` — the
 *            registry key Windows itself writes when the user picks a default
 *            browser. It is per-user, which is what "the user's default" means.
 *   macOS    the Launch Services handler list (`LSHandlerRoleAll` for `https`),
 *            which is what `NSWorkspace` reads.
 *   Linux    `xdg-settings get default-web-browser`, the freedesktop.org
 *            default-browser mechanism.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

/* ------------------------------------------------------------------ */
/* Browser identities                                                  */
/* ------------------------------------------------------------------ */

/** Human names for the browsers this skill can talk about. */
export const BROWSER_NAMES = {
  chrome: "Google Chrome",
  msedge: "Microsoft Edge",
  chromium: "Chromium",
  firefox: "Mozilla Firefox",
  safari: "Safari",
  brave: "Brave",
  opera: "Opera",
  vivaldi: "Vivaldi",
  unknown: "an unidentified browser",
};

/**
 * Browsers that Playwright can drive *as the installed product*.
 *
 * Playwright's `firefox` and `webkit` are patched upstream builds, not the
 * installed Firefox and not Safari, so they are deliberately absent: using one
 * and calling it "your browser" would be exactly the misrepresentation this
 * skill exists to avoid.
 */
export const PLAYWRIGHT_NATIVE_CHANNELS = ["chrome", "msedge", "chromium"];

/** The display name for a browser id. */
export function browserName(id) {
  return BROWSER_NAMES[id] ?? BROWSER_NAMES.unknown;
}

/* ------------------------------------------------------------------ */
/* Command runner (injectable)                                         */
/* ------------------------------------------------------------------ */

/** Run a command and return its status and output. Never throws. */
export function runCommand(cmd, args = [], { timeout = 10000, cwd } = {}) {
  try {
    const result = spawnSync(cmd, args, {
      encoding: "utf8",
      timeout,
      cwd,
      windowsHide: true,
    });
    return {
      status: result.status ?? (result.error ? 1 : 0),
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      error: result.error ? String(result.error.message ?? result.error) : null,
    };
  } catch (err) {
    return { status: 1, stdout: "", stderr: "", error: String(err?.message ?? err) };
  }
}

/* ------------------------------------------------------------------ */
/* Host environment                                                    */
/* ------------------------------------------------------------------ */

/**
 * Detect WSL.
 *
 * Three independent signals, because any one of them can be missing: the
 * environment variable WSL sets, the interop socket, and the kernel string.
 */
export function detectWsl({ platform = process.platform, env = process.env, readFile = fs.readFileSync } = {}) {
  if (platform !== "linux") return { wsl: false, distro: null };
  let distro = env.WSL_DISTRO_NAME || null;
  if (!distro) {
    try {
      const version = readFile("/proc/version", "utf8");
      if (!/microsoft|wsl/i.test(version)) return { wsl: false, distro: null };
    } catch {
      return { wsl: false, distro: null };
    }
  }
  if (!distro) {
    try {
      const release = readFile("/proc/sys/kernel/osrelease", "utf8");
      const m = /microsoft-standard-([a-z0-9]+)/i.exec(release);
      if (m) distro = m[1].toLowerCase();
    } catch {
      /* the hostname is the last resort */
    }
  }
  return { wsl: true, distro: distro ?? os.hostname() };
}

/**
 * The WSL networking mode.
 *
 * `nat` (the default) and `mirrored` behave differently for reaching a
 * server: in NAT mode Windows reaches a WSL server through forwarded
 * localhost, in mirrored mode the two stacks share it. The mode is reported,
 * never assumed, because the recording has to know which addressing works.
 */
export function detectNetworkingMode({ run = runCommand } = {}) {
  const result = run("wslinfo", ["--networking-mode"]);
  const value = String(result.stdout ?? "").trim().toLowerCase();
  if (["nat", "mirrored", "bridged", "consomme"].includes(value)) return value;
  return "unknown";
}

/** The Linux distribution, when the host is Linux. */
export function detectLinuxDistro({ readFile = fs.readFileSync } = {}) {
  try {
    const raw = readFile("/etc/os-release", "utf8");
    const name = /PRETTY_NAME="([^"]+)"/.exec(raw)?.[1];
    const id = /(^|\n)ID=([^\n]+)/.exec(raw)?.[2]?.trim().replace(/"/g, "");
    return { id: id ?? null, name: name ?? null };
  } catch {
    return { id: null, name: null };
  }
}

/**
 * The environment the recording will actually happen in.
 *
 * `shellPlatform` is where the agent process runs. `renderPlatform` is the
 * operating system whose browser will draw the pixels — inside WSL that is
 * Windows, not the Linux distribution the agent happens to live in.
 */
export function detectHostEnvironment({
  platform = process.platform,
  env = process.env,
  readFile = fs.readFileSync,
  run = runCommand,
} = {}) {
  const wsl = detectWsl({ platform, env, readFile });
  if (wsl.wsl) {
    return {
      kind: "wsl-windows",
      shellPlatform: "linux",
      renderPlatform: "win32",
      wsl: true,
      distro: wsl.distro,
      networking: detectNetworkingMode({ run }),
      desktopSession: null,
    };
  }
  if (platform === "win32") {
    return {
      kind: "windows",
      shellPlatform: "win32",
      renderPlatform: "win32",
      wsl: false,
      distro: null,
      networking: null,
      desktopSession: null,
    };
  }
  if (platform === "darwin") {
    return {
      kind: "macos",
      shellPlatform: "darwin",
      renderPlatform: "darwin",
      wsl: false,
      distro: null,
      networking: null,
      desktopSession: detectMacDesktopSession(),
    };
  }
  if (platform === "linux") {
    const distro = detectLinuxDistro({ readFile });
    return {
      kind: "linux",
      shellPlatform: "linux",
      renderPlatform: "linux",
      wsl: false,
      distro: distro.id ?? distro.name ?? null,
      distroName: distro.name ?? null,
      networking: null,
      desktopSession: detectLinuxDesktopSession({ env }),
    };
  }
  return {
    kind: "unknown",
    shellPlatform: platform,
    renderPlatform: platform,
    wsl: false,
    distro: null,
    networking: null,
    desktopSession: null,
  };
}

/** Whether a macOS session can show a window at all. */
function detectMacDesktopSession({ env = process.env } = {}) {
  if (env.SSH_CONNECTION || env.SSH_TTY) return "ssh";
  return "gui";
}

/** Whether a Linux session has a display server. */
function detectLinuxDesktopSession({ env = process.env } = {}) {
  if (env.DISPLAY || env.WAYLAND_DISPLAY) return "gui";
  if (env.XDG_SESSION_TYPE) return env.XDG_SESSION_TYPE;
  return "headless";
}

/* ------------------------------------------------------------------ */
/* Default browser: Windows                                            */
/* ------------------------------------------------------------------ */

/**
 * Windows default browser, from the registry key Windows writes.
 *
 * The value is a ProgId (`ChromeHTML`, `MSEdgeHTM`, `FirefoxURL-…`). The
 * `https` association is preferred; `http` is the fallback for a machine that
 * only has the older key.
 */
export function detectWindowsDefaultBrowser({ run = runCommand, reg = "reg.exe" } = {}) {
  for (const scheme of ["https", "http"]) {
    const result = run(reg, [
      "query",
      `HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\${scheme}\\UserChoice`,
      "/v",
      "ProgId",
    ]);
    const progId = parseRegistryProgId(result.stdout);
    if (progId) {
      return { id: mapProgIdToBrowser(progId), progId, source: "registry", scheme };
    }
  }
  return { id: null, progId: null, source: "registry" };
}

/** Pull the ProgId out of `reg query` output. Pure: unit-tested directly. */
export function parseRegistryProgId(text) {
  if (typeof text !== "string") return null;
  const match = /ProgId\s+REG_SZ\s+(\S+)/i.exec(text);
  return match ? match[1] : null;
}

/**
 * Map a Windows ProgId to a browser id.
 *
 * The hash suffix some ProgIds carry (`FirefoxURL-308046B0AF4A39CB`) is
 * stripped: it identifies the *choice*, not the program.
 */
export function mapProgIdToBrowser(progId) {
  if (typeof progId !== "string" || !progId) return null;
  const key = progId.split("-")[0].toLowerCase();
  const table = {
    chromehtml: "chrome",
    msedgehtm: "msedge",
    msedgedhtml: "msedge",
    firefoxurl: "firefox",
    bravehtml: "brave",
    opastable: "opera",
    opera: "opera",
    vivaldi: "vivaldi",
    safarihtml: "safari",
  };
  return table[key] ?? null;
}

/* ------------------------------------------------------------------ */
/* Default browser: macOS                                              */
/* ------------------------------------------------------------------ */

/**
 * The macOS default browser, from the Launch Services handler list.
 *
 * `NSWorkspace.urlForApplication(toOpen:)` is the supported API, but it needs
 * a compiled helper; the same Launch Services database is readable with
 * `plutil`, which ships with macOS. The per-user plist is the effective one.
 */
export function detectMacDefaultBrowser({
  run = runCommand,
  readFile = fs.readFileSync,
  homedir = os.homedir,
} = {}) {
  const candidates = [
    path.join(homedir(), "Library", "Preferences", "com.apple.LaunchServices", "com.apple.launchservices.secure.plist"),
    "/Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist",
  ];
  for (const file of candidates) {
    const result = run("plutil", ["-extract", "LSHandlers", "json", "-o", "-", file]);
    if (result.status === 0 && result.stdout.trim()) {
      const bundleId = parseLaunchServicesJson(result.stdout);
      if (bundleId) return { id: mapBundleIdToBrowser(bundleId), bundleId, source: "launch-services" };
    }
  }
  // `defaults read` prints the same array in the old-style plist syntax.
  const fallback = run("defaults", ["read", "com.apple.LaunchServices/com.apple.launchservices.secure", "LSHandlers"]);
  if (fallback.status === 0 && fallback.stdout.trim()) {
    const bundleId = parseLaunchServicesPlist(fallback.stdout);
    if (bundleId) return { id: mapBundleIdToBrowser(bundleId), bundleId, source: "launch-services" };
  }
  return { id: null, bundleId: null, source: "launch-services" };
}

/**
 * The `https` handler bundle id from a JSON `LSHandlers` array. Pure.
 */
export function parseLaunchServicesJson(text) {
  let handlers;
  try {
    handlers = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(handlers)) return null;
  let httpFallback = null;
  for (const handler of handlers) {
    if (!handler || typeof handler !== "object") continue;
    const scheme = String(handler.LSHandlerURLScheme ?? "").toLowerCase();
    if (scheme !== "https" && scheme !== "http") continue;
    const role = handler.LSHandlerRoleAll ?? handler.LSHandlerRoleViewer;
    if (typeof role !== "string" || !role) continue;
    // `https` is the association that matters; `http` is only a fallback.
    if (scheme === "https") return role;
    if (!httpFallback) httpFallback = role;
  }
  return httpFallback;
}

/**
 * The `https` handler bundle id from `defaults read` output. Pure.
 *
 * The old-style plist syntax has no reliable indentation, so the handlers are
 * read as `{ … }` blocks and each block is searched on its own.
 */
export function parseLaunchServicesPlist(text) {
  if (typeof text !== "string") return null;
  const blocks = text.match(/\{[^{}]*\}/g) ?? [];
  let httpFallback = null;
  for (const block of blocks) {
    const role = /LSHandlerRoleAll\s*=\s*"?([^";\n]+)"?/.exec(block)?.[1]?.trim();
    if (!role) continue;
    const scheme = /LSHandlerURLScheme\s*=\s*"?([^";\n]+)"?/.exec(block)?.[1]?.trim().toLowerCase();
    if (scheme === "https") return role;
    if (scheme === "http" && !httpFallback) httpFallback = role;
  }
  return httpFallback;
}

/** Map a macOS bundle id to a browser id. */
export function mapBundleIdToBrowser(bundleId) {
  if (typeof bundleId !== "string" || !bundleId) return null;
  const key = bundleId.toLowerCase();
  const table = {
    "com.apple.safari": "safari",
    "com.apple.safaritechnologypreview": "safari",
    "com.google.chrome": "chrome",
    "com.google.chrome.beta": "chrome",
    "com.google.chrome.dev": "chrome",
    "com.google.chrome.canary": "chrome",
    "com.microsoft.edgemac": "msedge",
    "com.microsoft.edgemac.beta": "msedge",
    "com.microsoft.edgemac.dev": "msedge",
    "org.mozilla.firefox": "firefox",
    "com.brave.browser": "brave",
    "com.operasoftware.opera": "opera",
    "com.vivaldi.vivaldi": "vivaldi",
  };
  return table[key] ?? null;
}

/* ------------------------------------------------------------------ */
/* Default browser: Linux                                              */
/* ------------------------------------------------------------------ */

/**
 * The Linux default browser, through the freedesktop.org mechanism.
 *
 * `xdg-settings` answers with a desktop entry id; the entry's `Exec=` line
 * names the program. `gio` is the fallback for a session without
 * `xdg-settings`.
 */
export function detectLinuxDefaultBrowser({ run = runCommand, readFile = fs.readFileSync } = {}) {
  const xdg = run("xdg-settings", ["get", "default-web-browser"]);
  if (xdg.status === 0) {
    const desktopFile = xdg.stdout.trim();
    if (desktopFile && desktopFile !== "") {
      const exec = readDesktopExec(desktopFile, { readFile });
      const id = mapExecToBrowser(exec);
      if (id) return { id, desktopFile, source: "xdg-settings" };
    }
  }
  const gio = run("gio", ["mime", "x-scheme-handler/http"]);
  if (gio.status === 0) {
    const desktopFile = (gio.stdout ?? "").split(/\r?\n/)[0]?.trim();
    if (desktopFile) {
      const exec = readDesktopExec(desktopFile, { readFile });
      const id = mapExecToBrowser(exec);
      if (id) return { id, desktopFile, source: "gio" };
    }
  }
  return { id: null, desktopFile: null, source: "xdg-settings" };
}

/** The `Exec=` line of a desktop entry, or null. */
export function readDesktopExec(desktopFile, { readFile = fs.readFileSync } = {}) {
  if (typeof desktopFile !== "string" || !desktopFile) return null;
  const file = desktopFile.includes("/")
    ? desktopFile
    : path.join("/usr/share/applications", desktopFile);
  let text;
  try {
    text = readFile(file, "utf8");
  } catch {
    return null;
  }
  return parseDesktopExec(text);
}

/** The `Exec=` value of a desktop entry's text. Pure. */
export function parseDesktopExec(text) {
  if (typeof text !== "string") return null;
  const match = /^\s*Exec\s*=\s*(.+)$/m.exec(text);
  return match ? match[1].trim() : null;
}

/** Map a desktop `Exec=` line to a browser id. */
export function mapExecToBrowser(exec) {
  if (typeof exec !== "string" || !exec) return null;
  const s = exec.toLowerCase();
  if (s.includes("google-chrome") || s.includes("google-chrome-stable")) return "chrome";
  if (s.includes("chromium")) return "chromium";
  if (s.includes("microsoft-edge") || s.includes("msedge")) return "msedge";
  if (s.includes("firefox")) return "firefox";
  if (s.includes("brave")) return "brave";
  if (s.includes("vivaldi")) return "vivaldi";
  if (s.includes("opera")) return "opera";
  if (s.includes("safari")) return "safari";
  return null;
}

/* ------------------------------------------------------------------ */
/* Installed browsers                                                  */
/* ------------------------------------------------------------------ */

/** Well-known install locations per platform. */
const INSTALL_PATHS = {
  win32: [
    ["chrome", ["Program Files/Google/Chrome/Application/chrome.exe", "Program Files (x86)/Google/Chrome/Application/chrome.exe"]],
    ["msedge", ["Program Files/Microsoft/Edge/Application/msedge.exe", "Program Files (x86)/Microsoft/Edge/Application/msedge.exe"]],
    ["firefox", ["Program Files/Mozilla Firefox/firefox.exe", "Program Files (x86)/Mozilla Firefox/firefox.exe"]],
  ],
  darwin: [
    ["chrome", ["Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]],
    ["msedge", ["Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"]],
    ["firefox", ["Applications/Firefox.app/Contents/MacOS/firefox"]],
    ["safari", ["Applications/Safari.app/Contents/MacOS/Safari"]],
    ["brave", ["Applications/Brave Browser.app/Contents/MacOS/Brave Browser"]],
  ],
  linux: [
    ["chrome", ["usr/bin/google-chrome", "usr/bin/google-chrome-stable", "opt/google/chrome/chrome"]],
    ["chromium", ["usr/bin/chromium", "usr/bin/chromium-browser"]],
    ["msedge", ["usr/bin/microsoft-edge", "opt/microsoft/msedge/msedge"]],
    ["firefox", ["usr/bin/firefox", "snap/bin/firefox"]],
    ["brave", ["usr/bin/brave-browser"]],
    ["opera", ["usr/bin/opera"]],
    ["vivaldi", ["usr/bin/vivaldi"]],
  ],
};

/**
 * The branded browsers installed on a host.
 *
 * "Installed" is not the same as "default": the default is what the user
 * chose, and it is reported separately.
 */
export function detectInstalledBrowsers({
  platform = process.platform,
  env = process.env,
  exists = fs.existsSync,
  roots = null,
} = {}) {
  const found = [];
  const table = INSTALL_PATHS[platform] ?? [];
  for (const [id, relativePaths] of table) {
    for (const relative of relativePaths) {
      const candidates = roots
        ? [path.join(roots, relative)]
        : [path.join("/", relative), path.join(env.HOME ?? os.homedir(), relative)];
      for (const candidate of candidates) {
        if (exists(candidate)) {
          found.push({ id, path: candidate });
          break;
        }
      }
      if (found.some((b) => b.id === id)) break;
    }
  }
  return found;
}

/* ------------------------------------------------------------------ */
/* Dispatch                                                            */
/* ------------------------------------------------------------------ */

/**
 * The user's default browser on the rendering host.
 *
 * `source` says how it was found, so the manifest can be honest about what is
 * known: `registry` (Windows), `launch-services` (macOS), `xdg-settings`
 * (Linux) or `installed` (no default could be read, but a branded browser is
 * present).
 */
export function detectDefaultBrowser({ host, platform = process.platform, run = runCommand, readFile = fs.readFileSync, exists = fs.existsSync, env = process.env } = {}) {
  const renderPlatform = host?.renderPlatform ?? platform;
  let detected = { id: null, source: null, detail: null };

  if (renderPlatform === "win32") {
    detected = detectWindowsDefaultBrowser({ run });
  } else if (renderPlatform === "darwin") {
    detected = detectMacDefaultBrowser({ run, readFile });
  } else if (renderPlatform === "linux") {
    detected = detectLinuxDefaultBrowser({ run, readFile });
  }

  if (detected.id) {
    return {
      id: detected.id,
      name: browserName(detected.id),
      source: "system-default",
      detail: detected.progId ?? detected.bundleId ?? detected.desktopFile ?? null,
      detectedBy: detected.source,
    };
  }

  // No default could be read. A branded browser that is installed is still a
  // real browser on the host, and using it is not the same substitution as
  // falling back to a bundled build — but it is reported as "installed", not
  // as "the user's default".
  const installed = detectInstalledBrowsers({ platform: renderPlatform, env, exists });
  const supported = installed.find((b) => PLAYWRIGHT_NATIVE_CHANNELS.includes(b.id)) ?? installed[0] ?? null;
  return {
    id: supported?.id ?? null,
    name: supported ? browserName(supported.id) : null,
    source: supported ? "system-installed" : "none",
    detail: supported?.path ?? null,
    detectedBy: supported ? "install-scan" : null,
  };
}
