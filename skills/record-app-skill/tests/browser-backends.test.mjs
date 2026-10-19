/**
 * Browser backend selection, host detection and browser isolation.
 *
 * The logic here decides *which browser draws the pixels of a recording*, so
 * it is tested against every operating system the skill supports — including
 * the ones this machine is not — using injected detection. A mocked test
 * proves the decision logic; it does not prove that a given platform renders
 * a given way, and the tests say so where that matters.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EXIT } from "../scripts/lib.mjs";
import { runScript, tmpDir } from "./helpers.mjs";

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const {
  resolveBackend,
  selectBrowser,
  nativeAlternatives,
  hostLabel,
  detectWindowsBackend,
} = await import("../scripts/browser-env.mjs");

const {
  detectHostEnvironment,
  detectWsl,
  parseRegistryProgId,
  mapProgIdToBrowser,
  parseLaunchServicesJson,
  parseLaunchServicesPlist,
  mapBundleIdToBrowser,
  parseDesktopExec,
  mapExecToBrowser,
  browserName,
  PLAYWRIGHT_NATIVE_CHANNELS,
} = await import("../scripts/host-env.mjs");

const { FORBIDDEN_BROWSER_ARGS, launchOptionsFor, contextOptionsFor, renderingSettingsFor } = await import(
  "../scripts/capture.mjs"
);

/* ------------------------------------------------------------------ */
/* Environments used by the tests                                      */
/* ------------------------------------------------------------------ */

const WSL = {
  kind: "wsl-windows",
  shellPlatform: "linux",
  renderPlatform: "win32",
  wsl: true,
  distro: "archlinux",
  networking: "nat",
  desktopSession: null,
};
const WINDOWS = {
  kind: "windows",
  shellPlatform: "win32",
  renderPlatform: "win32",
  wsl: false,
  distro: null,
  networking: null,
  desktopSession: null,
};
const MACOS = {
  kind: "macos",
  shellPlatform: "darwin",
  renderPlatform: "darwin",
  wsl: false,
  distro: null,
  networking: null,
  desktopSession: "gui",
};
const LINUX = {
  kind: "linux",
  shellPlatform: "linux",
  renderPlatform: "linux",
  wsl: false,
  distro: "debian",
  distroName: "Debian",
  networking: null,
  desktopSession: "gui",
};

const installed = (...ids) => ids.map((id) => ({ id, path: `/opt/${id}`, version: "1.2.3" }));
const defaultIs = (id) => () => (id ? { id, source: "system-default" } : null);

/* ------------------------------------------------------------------ */
/* The rendering host is not the shell                                 */
/* ------------------------------------------------------------------ */

test("WSL is detected, and the rendering host is Windows — not the Linux distro", () => {
  const wsl = detectWsl({
    platform: "linux",
    env: { WSL_DISTRO_NAME: "archlinux" },
    readFile: () => "Linux version 6.18-microsoft-standard-WSL2",
  });
  assert.equal(wsl.wsl, true);
  assert.equal(wsl.distro, "archlinux");

  const host = detectHostEnvironment({
    platform: "linux",
    env: { WSL_DISTRO_NAME: "archlinux" },
    readFile: () => "Linux version 6.18-microsoft-standard-WSL2",
    run: () => ({ status: 0, stdout: "nat\n", stderr: "" }),
  });
  assert.equal(host.kind, "wsl-windows");
  assert.equal(host.shellPlatform, "linux", "the agent runs on Linux");
  assert.equal(host.renderPlatform, "win32", "the frames come from Windows");
  assert.equal(host.networking, "nat");
  assert.match(hostLabel(host), /Windows/);
});

test("a plain Linux host is not mistaken for WSL", () => {
  const host = detectHostEnvironment({
    platform: "linux",
    env: {},
    readFile: (file) => {
      if (String(file).endsWith("os-release")) return 'ID=debian\nPRETTY_NAME="Debian GNU/Linux"\n';
      return "Linux version 6.1.0-generic";
    },
    run: () => ({ status: 1, stdout: "", stderr: "" }),
  });
  assert.equal(host.kind, "linux");
  assert.equal(host.wsl, false);
  assert.equal(host.renderPlatform, "linux");
  assert.equal(host.distro, "debian");
});

/* ------------------------------------------------------------------ */
/* Default browser detection, per platform                             */
/* ------------------------------------------------------------------ */

test("Windows reads the registered default browser from the registry", () => {
  const stdout = [
    "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice",
    "    ProgId    REG_SZ    ChromeHTML",
    "",
  ].join("\n");
  assert.equal(parseRegistryProgId(stdout), "ChromeHTML");
  assert.equal(parseRegistryProgId("no value here"), null);
  assert.equal(mapProgIdToBrowser("ChromeHTML"), "chrome");
  assert.equal(mapProgIdToBrowser("MSEdgeHTM"), "msedge");
  assert.equal(mapProgIdToBrowser("FirefoxURL-308046B0AF4A39CB"), "firefox");
  assert.equal(mapProgIdToBrowser("BraveHTML"), "brave");
  assert.equal(mapProgIdToBrowser("SomethingElseHTML"), null);
});

test("macOS reads the default browser from the Launch Services handlers", () => {
  const json = JSON.stringify([
    { LSHandlerURLScheme: "http", LSHandlerRoleAll: "com.apple.Safari" },
    { LSHandlerURLScheme: "https", LSHandlerRoleAll: "com.google.Chrome" },
  ]);
  assert.equal(parseLaunchServicesJson(json), "com.google.Chrome");
  assert.equal(parseLaunchServicesJson("not json"), null);
  assert.equal(mapBundleIdToBrowser("com.apple.Safari"), "safari");
  assert.equal(mapBundleIdToBrowser("com.microsoft.edgemac"), "msedge");
  assert.equal(mapBundleIdToBrowser("org.mozilla.firefox"), "firefox");
  assert.equal(mapBundleIdToBrowser("com.vivaldi.vivaldi"), "vivaldi");

  // The old-style `defaults read` syntax has to work too.
  const plist = `(
    {
        LSHandlerContentType = "public.html";
        LSHandlerRoleAll = "com.apple.Safari";
        LSHandlerURLScheme = http;
    },
    {
        LSHandlerContentType = "public.html";
        LSHandlerRoleAll = "com.google.Chrome";
        LSHandlerURLScheme = https;
    }
)`;
  assert.equal(parseLaunchServicesPlist(plist), "com.google.Chrome");
});

test("Linux reads the default browser from the freedesktop.org mechanism", () => {
  const entry = ["[Desktop Entry]", "Name=Google Chrome", "Exec=/usr/bin/google-chrome-stable %U"].join("\n");
  assert.equal(parseDesktopExec(entry), "/usr/bin/google-chrome-stable %U");
  assert.equal(mapExecToBrowser("/usr/bin/google-chrome-stable %U"), "chrome");
  assert.equal(mapExecToBrowser("/usr/bin/microsoft-edge --ozone-platform-hint=%U"), "msedge");
  assert.equal(mapExecToBrowser("/usr/bin/firefox %u"), "firefox");
  assert.equal(mapExecToBrowser("/usr/bin/chromium-browser"), "chromium");
  assert.equal(mapExecToBrowser("/usr/bin/brave-browser"), "brave");
  assert.equal(mapExecToBrowser("/usr/bin/something-else"), null);
});

/* ------------------------------------------------------------------ */
/* Backend selection                                                   */
/* ------------------------------------------------------------------ */

test("inside WSL the Windows host is the rendering platform", () => {
  const resolved = resolveBackend("auto", {
    environment: WSL,
    detectDefault: defaultIs("chrome"),
    detectInstalled: () => installed("chrome", "msedge"),
  });
  // The WSL branch consults the Windows host directly, so the injected
  // detection is only a fallback; the assertion is about the platform.
  assert.equal(resolved.backend, "windows-native");
  assert.equal(resolved.strategy, "windows-worker");
  assert.equal(resolved.host.renderPlatform, "win32");
  assert.equal(resolved.host.shellPlatform, "linux");
});

test("native Windows uses the host's registered default browser", () => {
  const resolved = resolveBackend("auto", {
    environment: WINDOWS,
    detectDefault: defaultIs("chrome"),
    detectInstalled: () => installed("chrome", "msedge"),
  });
  assert.equal(resolved.backend, "native");
  assert.equal(resolved.strategy, "playwright-channel");
  assert.equal(resolved.channel, "chrome");
  assert.equal(resolved.browser.name, "Google Chrome");
  assert.equal(resolved.browser.source, "system-default");
  assert.equal(resolved.unavailable, false);
});

test("native macOS uses the default browser, and reports SafariDriver's requirements", () => {
  const chrome = resolveBackend("auto", {
    environment: MACOS,
    detectDefault: defaultIs("chrome"),
    detectInstalled: () => installed("chrome"),
  });
  assert.equal(chrome.backend, "native");
  assert.equal(chrome.channel, "chrome");
  assert.equal(chrome.unavailable, false);

  const safari = resolveBackend("auto", {
    environment: MACOS,
    detectDefault: defaultIs("safari"),
    detectInstalled: () => installed("safari", "chrome"),
  });
  assert.equal(safari.unavailable, true, "Safari is not silently replaced by something else");
  assert.equal(safari.strategy, "safaridriver");
  assert.match(safari.reason, /Safari/);
  assert.ok(
    safari.requirements.some((r) => /SafariDriver/.test(r)),
    "the requirements must name SafariDriver"
  );
  assert.ok(
    safari.requirements.some((r) => /Allow Remote Automation/.test(r)),
    "the requirements must name the Safari setting that has to be enabled"
  );
  assert.ok(
    safari.alternatives.some((a) => /Google Chrome/.test(a)),
    "an installed alternative must be offered"
  );
});

test("native Linux keeps working, with the installed browser when there is one", () => {
  const withChrome = resolveBackend("auto", {
    environment: LINUX,
    detectDefault: defaultIs("chrome"),
    detectInstalled: () => installed("chrome"),
  });
  assert.equal(withChrome.backend, "native");
  assert.equal(withChrome.channel, "chrome");
  assert.equal(withChrome.unavailable, false);

  // A bare machine with no branded browser falls back to the portable build —
  // and says so, because that build renders fonts differently.
  const bare = resolveBackend("auto", {
    environment: LINUX,
    detectDefault: defaultIs(null),
    detectInstalled: () => [],
  });
  assert.equal(bare.backend, "local-playwright");
  assert.equal(bare.channel, "chromium");
  assert.equal(bare.browser.source, "playwright-bundled");
  assert.ok(bare.warnings.some((w) => /bundled Chromium/.test(w)));
});

test("a default browser that cannot be driven is an error, never a quiet swap", () => {
  for (const id of ["firefox", "brave", "opera", "safari"]) {
    const resolved = resolveBackend("auto", {
      environment: id === "safari" ? MACOS : WINDOWS,
      detectDefault: defaultIs(id),
      detectInstalled: () => installed(id, "chrome"),
    });
    assert.equal(resolved.unavailable, true, `${id} must not be silently replaced`);
    assert.notEqual(resolved.channel, "chrome", "the failed browser must not become a different one");
    assert.ok(resolved.alternatives.length > 0, "alternatives must be offered");
  }
});

test("an explicitly requested native backend never falls back", () => {
  const resolved = resolveBackend("native", {
    environment: WINDOWS,
    detectDefault: defaultIs("firefox"),
    detectInstalled: () => installed("firefox", "chrome"),
  });
  assert.equal(resolved.unavailable, true);
  assert.equal(resolved.backend, "native");
  assert.notEqual(resolved.channel, "chrome");
});

test("an explicitly selected browser is honoured, and refused when it is absent", () => {
  const present = resolveBackend("native", {
    environment: WINDOWS,
    channel: "msedge",
    detectDefault: defaultIs("chrome"),
    detectInstalled: () => installed("chrome", "msedge"),
  });
  assert.equal(present.channel, "msedge");
  assert.equal(present.browser.source, "user-selected");
  assert.equal(present.unavailable, false);

  const absent = resolveBackend("native", {
    environment: WINDOWS,
    channel: "msedge",
    detectDefault: defaultIs("chrome"),
    detectInstalled: () => installed("chrome"),
  });
  assert.equal(absent.unavailable, true);
  assert.match(absent.reason, /not installed/);
});

test("the local Playwright backend stays available as the portable escape hatch", () => {
  const resolved = resolveBackend("local-playwright", {
    environment: LINUX,
    detectDefault: defaultIs("chrome"),
    detectInstalled: () => installed("chrome"),
  });
  assert.equal(resolved.backend, "local-playwright");
  assert.equal(resolved.unavailable, false);
  // No channel was named, so the portable build is used.
  assert.equal(resolved.channel, "chromium");
  assert.equal(resolved.browser.source, "playwright-bundled");
});

test("windows-native is refused on a host that is not Windows", () => {
  const resolved = resolveBackend("windows-native", {
    environment: MACOS,
    detectDefault: defaultIs("chrome"),
    detectInstalled: () => installed("chrome"),
  });
  assert.equal(resolved.unavailable, true);
  assert.match(resolved.reason, /Windows host/);
});

test("the browser selection order is: explicit, then default, then installed", () => {
  const explicit = selectBrowser({
    requestedChannel: "msedge",
    defaultBrowser: { id: "chrome" },
    installed: installed("chrome", "msedge"),
  });
  assert.equal(explicit.id, "msedge");
  assert.equal(explicit.source, "user-selected");

  const byDefault = selectBrowser({
    defaultBrowser: { id: "chrome" },
    installed: installed("chrome", "msedge"),
  });
  assert.equal(byDefault.id, "chrome");
  assert.equal(byDefault.source, "system-default");

  const byInstall = selectBrowser({ installed: installed("msedge") });
  assert.equal(byInstall.id, "msedge");
  assert.equal(byInstall.source, "system-installed");

  const nothing = selectBrowser({ installed: [] });
  assert.equal(nothing.ok, false);
  assert.equal(nothing.id, null);
});

test("the alternatives name the browsers that are actually installed", () => {
  const alternatives = nativeAlternatives({
    selection: { id: "firefox" },
    installed: installed("chrome", "msedge"),
  });
  assert.ok(alternatives.some((a) => /Google Chrome is installed/.test(a)));
  assert.ok(alternatives.some((a) => /Microsoft Edge is installed/.test(a)));
  assert.ok(alternatives.some((a) => /local-playwright/.test(a)));
});

/* ------------------------------------------------------------------ */
/* Isolation                                                           */
/* ------------------------------------------------------------------ */

test("the everyday browser profile is never opened and no debug port is opened", () => {
  const plan = { browser: { channel: "auto", headless: true, viewport: { width: 1440, height: 900 } } };
  const options = launchOptionsFor(plan, { detect: () => "chrome", resolved: "chrome" });
  assert.deepEqual(options, { headless: true, channel: "chrome" });
  // No profile, no debug port, no font or colour overrides, no extensions.
  assert.equal(options.userDataDir, undefined);
  assert.equal(options.args, undefined);
  for (const flag of FORBIDDEN_BROWSER_ARGS) {
    assert.ok(!JSON.stringify(options).includes(flag), `${flag} must never be passed`);
  }
});

test("the recording does not change the application's own rendering", () => {
  const plan = {
    browser: {
      channel: "auto",
      headless: true,
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
      locale: null,
      colorScheme: null,
      reducedMotion: null,
    },
  };
  const options = contextOptionsFor(plan);
  assert.equal(options.viewport.width, 1440);
  assert.equal(options.deviceScaleFactor, 2);
  // The host's own preferences are left alone: Playwright would otherwise
  // force a light colour scheme over a dark system.
  assert.equal(options.colorScheme, undefined);
  assert.equal(options.reducedMotion, undefined);
  assert.equal(options.locale, undefined);

  const settings = renderingSettingsFor(plan);
  assert.equal(settings.colorScheme, "system");
  assert.equal(settings.reducedMotion, "system");
  assert.equal(settings.fontsInjected, false);
  assert.equal(settings.applicationCssOverridden, false);
  assert.equal(settings.grayscaleProfile, "off");
});

test("the browser really runs in a throwaway profile, not the user's own", async (t) => {
  if (process.platform !== "linux") {
    return t.skip("the process command line can only be inspected on Linux");
  }
  const { resolvePlaywright } = await import("../scripts/browser-env.mjs");
  const pw = resolvePlaywright({ required: false });
  if (!pw) return t.skip("Playwright is not installed");

  // A harmless, unique switch marks *this* browser's process, so the test
  // does not have to guess which of several running Chromium processes is
  // ours. Chromium ignores switches it does not know.
  const token = `record-app-skill-isolation-${process.pid}-${Date.now()}`;
  const browser = await pw.playwright.chromium.launch({
    headless: true,
    args: [`--awd-isolation-token=${token}`],
  });
  const profiles = [];
  try {
    const found = chromeProfiles(token);
    assert.ok(found.length > 0, "the launched browser must have a profile directory");
    for (const { userDataDir, cmdline } of found) {
      profiles.push(userDataDir);
      assert.ok(
        userDataDir.startsWith(os.tmpdir()),
        `the browser must use a temporary profile, not ${userDataDir}`
      );
      assert.ok(
        !userDataDir.includes(path.join(os.homedir(), ".config")),
        `the everyday profile must never be opened: ${userDataDir}`
      );
      // Playwright talks to the browser over its own pipe; nothing may open a
      // debugging *port* that another process could connect to.
      assert.ok(
        !/--remote-debugging-port=/.test(cmdline),
        "no remote debugging port may be opened"
      );
    }
  } finally {
    await browser.close();
  }

  // The temporary profile is cleaned up with the browser: nothing is left
  // behind that could carry state into the next run.
  await new Promise((resolve) => setTimeout(resolve, 500));
  for (const dir of profiles) {
    assert.ok(!fs.existsSync(dir), `the temporary profile must be removed: ${dir}`);
  }
});

/** The profile directories of the Chromium processes carrying `token`. */
function chromeProfiles(token = null) {
  const profiles = [];
  let entries;
  try {
    entries = fs.readdirSync("/proc");
  } catch {
    return profiles;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    let cmdline;
    try {
      cmdline = fs.readFileSync(`/proc/${entry}/cmdline`, "utf8");
    } catch {
      continue;
    }
    if (!cmdline.includes("chrome")) continue;
    if (token && !cmdline.includes(token)) continue;
    const match = /--user-data-dir=(\S+)/.exec(cmdline);
    if (match) profiles.push({ userDataDir: match[1], cmdline });
  }
  return profiles;
}

/* ------------------------------------------------------------------ */
/* Legacy plans                                                        */
/* ------------------------------------------------------------------ */

test("a plan written before the native-browser work still resolves and validates", async () => {
  const { validatePlan } = await import("../scripts/lib.mjs");
  const legacy = {
    schemaVersion: 1,
    title: "Legacy plan",
    baseUrl: "http://127.0.0.1:4319",
    startRoute: "/tasks",
    steps: [{ id: "look", action: "waitFor", target: { css: "body" }, expect: { visible: true } }],
  };
  const { errors, plan } = validatePlan(legacy);
  assert.deepEqual(errors, [], "an old plan must still be valid");
  assert.equal(plan.browser.backend, "auto");
  assert.equal(plan.browser.channel, "auto");
  assert.equal(plan.browser.viewport.width, 1440);
  assert.equal(plan.browser.colorScheme, null, "the host's colour scheme is used unless asked otherwise");
  assert.equal(plan.browser.reducedMotion, null);
});

/* ------------------------------------------------------------------ */
/* The environment report                                              */
/* ------------------------------------------------------------------ */

test("the environment report is short, structured and names the rendering host", () => {
  const result = runScript("env-detect.mjs", ["--json"], { timeout: 120000 });
  assert.equal(result.code, EXIT.OK, `env-detect failed:\n${result.stdout}${result.stderr}`);
  assert.ok(result.json, "the report must be machine-readable");
  assert.equal(result.json.host.shellPlatform, process.platform);
  assert.ok(["wsl-windows", "windows", "macos", "linux", "unknown"].includes(result.json.host.kind));
  assert.ok(result.json.backend.resolved);
  assert.ok(typeof result.json.backend.available === "boolean");
  // A summary, not a dump: the whole report is small enough to read.
  assert.ok(result.stdout.length < 4000, `the report must stay small: ${result.stdout.length} characters`);
});

test("the environment report is readable by a person too", () => {
  const result = runScript("env-detect.mjs", [], { timeout: 120000 });
  assert.equal(result.code, EXIT.OK, `env-detect failed:\n${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /record-app-skill environment/);
  assert.match(result.stdout, /rendering\s+:/);
  assert.match(result.stdout, /browser\s+:/);
  assert.doesNotMatch(result.stdout, /at Object\.|ReferenceError/);
});

/* ------------------------------------------------------------------ */
/* The skill's own instructions                                        */
/* ------------------------------------------------------------------ */

test("the skill stays short enough to be read once, and defers the details", () => {
  const skill = fs.readFileSync(path.join(SKILL_DIR, "SKILL.md"), "utf8");
  const lines = skill.split("\n");
  // The Agent Skills specification asks for under 500 lines; this skill's
  // working budget is tighter, so the instructions cannot quietly grow.
  assert.ok(lines.length <= 210, `SKILL.md must stay concise: ${lines.length} lines`);
  assert.ok(lines.length < 500, "the Agent Skills specification asks for under 500 lines");

  // The frontmatter the specification requires.
  assert.match(skill, /^---\n/, "SKILL.md must start with frontmatter");
  assert.match(skill, /^name:\s*record-app-skill\s*$/m);
  assert.match(skill, /^description:\s*\S/m);
  const description = /^description:\s*(.+)$/m.exec(skill)?.[1] ?? "";
  assert.ok(description.length > 0 && description.length <= 1024, "the description must fit the specification");

  // References are one level deep and every link resolves.
  const links = [...skill.matchAll(/\]\((references\/[^)]+)\)/g)].map((m) => m[1]);
  assert.ok(links.length > 0, "the skill must point at its references");
  for (const link of links) {
    assert.match(link, /^references\/[^/]+\.md$/, `references must be one level deep: ${link}`);
    assert.ok(fs.existsSync(path.join(SKILL_DIR, link)), `missing reference: ${link}`);
  }

  // The skill must not tell the agent to read everything every time.
  assert.doesNotMatch(skill, /read all (the )?references/i);
  assert.doesNotMatch(skill, /read every reference/i);
});

test("the bundled example plan still validates under the current schema", async () => {
  const { validatePlan } = await import("../scripts/lib.mjs");
  const example = JSON.parse(
    fs.readFileSync(path.join(SKILL_DIR, "assets", "templates", "workflow.example.json"), "utf8")
  );
  const { errors } = validatePlan(example);
  assert.deepEqual(errors, [], "the example must match the schema the skill documents");
});
