#!/usr/bin/env node
/**
 * Windows-side worker for the `windows-native` backend.
 *
 * This script only ever runs under Windows Node. It is launched by
 * `scripts/win-exec.mjs` from WSL and is responsible for:
 *
 *   1. refusing to run anywhere except Windows (so a misconfigured launch fails
 *      loudly instead of silently recording with the wrong browser),
 *   2. preflighting the Windows-side pieces (installed Chrome, Playwright
 *      runtime) and reporting precisely which one is missing,
 *   3. re-entering `scripts/record-workflow.mjs` under Windows Node, so the same
 *      executor is used by both backends and behaviour cannot drift,
 *   4. writing a structured report so the WSL side can explain what happened.
 *
 * Everything crosses the WSL boundary as argv or files: WSL interop does not
 * forward environment variables to Windows processes.
 *
 * Exit codes: 0 ok · 2 not Windows/usage · 4 a Windows dependency is missing
 *             (Chrome, the Playwright runtime, Playwright's ffmpeg) ·
 *             6 the application is unreachable from Windows ·
 *             otherwise the recorder's own code, which is the same contract.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { findWindowsPlaywrightFfmpeg } from "../browser-env.mjs";
import { detectWindowsDefaultBrowser } from "../host-env.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(HERE, "..", "..");

function parseArgs(argv) {
  const args = {
    plan: null,
    outDir: null,
    runDir: null,
    report: null,
    runtime: null,
    runName: null,
    maxDurationMs: null,
    quality: null,
    fps: null,
    allowConsequential: false,
    headed: false,
    channel: null,
    shellPlatform: null,
    internal: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${a}`);
      return v;
    };
    switch (a) {
      case "--plan": args.plan = next(); break;
      case "--out-dir": args.outDir = next(); break;
      case "--run-dir": args.runDir = next(); break;
      case "--report": args.report = next(); break;
      case "--runtime": args.runtime = next(); break;
      case "--run-name": args.runName = next(); break;
      case "--max-duration-ms": args.maxDurationMs = next(); break;
      case "--quality": args.quality = next(); break;
      case "--fps": args.fps = next(); break;
      case "--channel": args.channel = next(); break;
      case "--shell-platform": args.shellPlatform = next(); break;
      case "--allow-consequential": args.allowConsequential = true; break;
      case "--headed": args.headed = true; break;
      case "--internal-windows-run": args.internal = true; break;
      default: throw new Error(`unknown option: ${a}`);
    }
  }
  return args;
}

function writeReport(reportPath, payload) {
  if (!reportPath) return;
  try {
    fs.writeFileSync(reportPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
  } catch {
    /* the report is diagnostic; never fail the run because of it */
  }
}

/** Locate an installed Chrome/Edge on this Windows machine. */
export function findChromeOnWindows(env = process.env) {
  const roots = [
    env["PROGRAMFILES"] && path.join(env["PROGRAMFILES"], "Google", "Chrome", "Application"),
    env["PROGRAMFILES(X86)"] && path.join(env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application"),
    env["LOCALAPPDATA"] && path.join(env["LOCALAPPDATA"], "Google", "Chrome", "Application"),
    env["PROGRAMFILES"] && path.join(env["PROGRAMFILES"], "Microsoft", "Edge", "Application"),
    env["PROGRAMFILES(X86)"] && path.join(env["PROGRAMFILES(X86)"], "Microsoft", "Edge", "Application"),
  ].filter(Boolean);
  for (const root of roots) {
    for (const [exe, channel] of [["chrome.exe", "chrome"], ["msedge.exe", "msedge"]]) {
      const candidate = path.join(root, exe);
      if (fs.existsSync(candidate)) return { id: channel, path: candidate };
    }
  }
  return null;
}

/**
 * The browser this worker will drive.
 *
 * The order is: the channel the WSL side selected, then the browser Windows
 * itself records as the user's default, then any installed Chromium browser.
 * A default that cannot be driven (Firefox, say) is never quietly replaced:
 * the run stops with the reason.
 */
export function selectWindowsBrowser({ requested = null, detected = null, installed = null, env = process.env } = {}) {
  const installedBrowser = installed ?? findChromeOnWindows(env);
  const installedId = installedBrowser?.id ?? null;
  if (requested && requested !== "auto") {
    const ok = requested === installedId;
    return {
      ok,
      id: requested,
      source: "user-selected",
      path: ok ? installedBrowser.path : null,
      reason: ok
        ? `the requested browser (${requested}) is installed`
        : `the requested browser (${requested}) is not installed on this Windows machine`,
    };
  }
  if (detected?.id) {
    const supported = detected.id === "chrome" || detected.id === "msedge";
    if (supported) {
      return {
        ok: true,
        id: detected.id,
        source: "system-default",
        path: installedBrowser?.path ?? null,
        reason: `${detected.id === "chrome" ? "Google Chrome" : "Microsoft Edge"} is this machine's registered default browser`,
      };
    }
    return {
      ok: false,
      id: detected.id,
      source: "system-default",
      path: null,
      reason: `this machine's default browser is ${detected.id}, and this skill cannot drive it natively`,
    };
  }
  if (installedBrowser) {
    return {
      ok: true,
      id: installedBrowser.id,
      source: "system-installed",
      path: installedBrowser.path,
      reason: "no registered default browser could be read; an installed browser will be used",
    };
  }
  return {
    ok: false,
    id: null,
    source: "none",
    path: null,
    reason: "no Google Chrome or Microsoft Edge is installed on this Windows machine",
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (process.platform !== "win32") {
    process.stderr.write(
      `win/worker.mjs must run under Windows Node (this is ${process.platform}).\n` +
        `It is normally launched for you by scripts/win-exec.mjs from WSL.\n`
    );
    process.exit(2);
  }
  if (!args.plan || !args.outDir) {
    process.stderr.write("win/worker.mjs requires --plan and --out-dir\n");
    process.exit(2);
  }

  const report = {
    worker: "record-app-skill/win",
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    windowsNode: process.execPath,
    startedAt: new Date().toISOString(),
    args: {
      plan: args.plan,
      runDir: args.runDir,
      outDir: args.outDir,
      runName: args.runName,
      headed: args.headed,
    },
    chrome: null,
    playwright: null,
    exitCode: null,
    stderrTail: [],
  };

  // ---- preflight: Playwright runtime --------------------------------
  const runtimeDir = args.runtime ?? path.join(os.homedir(), "AppData", "Local", "record-app-skill", "playwright-runtime");
  const runtimePkg = path.join(runtimeDir, "node_modules", "playwright", "package.json");
  if (!fs.existsSync(runtimePkg)) {
    report.exitCode = 4;
    report.error =
      `the Windows Playwright runtime is missing at ${runtimeDir}. ` +
      `Install it from WSL with: node scripts/win/setup-runtime.mjs`;
    writeReport(args.report, report);
    process.stderr.write(`${report.error}\n`);
    process.exit(4);
  }
  try {
    report.playwright = JSON.parse(fs.readFileSync(runtimePkg, "utf8")).version;
  } catch {
    report.playwright = "unknown";
  }

  // ---- preflight: a Chromium-based browser to drive -------------------
  // The Windows host's *registered default* browser is what the recording
  // should use, so that is what is asked for first. A default that cannot be
  // driven natively is an error with the alternatives, never a quiet swap.
  const detectedDefault = detectWindowsDefaultBrowser();
  const selection = selectWindowsBrowser({
    requested: args.channel,
    detected: detectedDefault,
  });
  if (!selection.ok) {
    // Exit codes are the shared contract, not worker-local ones: a missing
    // browser is a missing dependency (4), never the contract's 3, which means
    // "output conflict" to every caller.
    report.exitCode = 4;
    report.error =
      `${selection.reason}. ` +
      "Install Google Chrome (https://www.google.com/chrome/) or Microsoft Edge, " +
      "select a different browser explicitly, or use --backend local-playwright.";
    writeReport(args.report, report);
    process.stderr.write(`${report.error}\n`);
    process.exit(4);
  }
  report.chrome = selection.path;
  report.browser = {
    id: selection.id,
    source: selection.source,
    reason: selection.reason,
    defaultBrowser: detectedDefault.id ?? null,
  };

  // ---- preflight: Playwright's ffmpeg (needed by page.screencast) ------
  const pwFfmpeg = findWindowsPlaywrightFfmpeg();
  if (!pwFfmpeg) {
    report.exitCode = 4;
    report.error =
      "Playwright's ffmpeg build is missing on this Windows machine. `page.screencast` needs it to mux the " +
      "raw recording. Install it with: node scripts/win/setup-runtime.mjs";
    writeReport(args.report, report);
    process.stderr.write(`${report.error}\n`);
    process.exit(4);
  }
  report.playwrightFfmpeg = pwFfmpeg;

  // ---- preflight: is the application reachable *from Windows*? --------
  // This is the most common windows-native failure: the server runs fine inside
  // WSL, but Windows cannot route to it. Diagnosing it here produces a clear
  // message instead of a browser-level connection error mid-recording.
  const baseUrl = readBaseUrl(args.plan);
  if (baseUrl) {
    const probe = await probeUrl(baseUrl);
    report.urlProbe = probe;
    if (!probe.ok) {
      // An unreachable application is an environment problem (6), exactly as it
      // is on the Linux path — not a workflow failure, which would tell the
      // caller their steps were wrong instead of their server being down.
      report.exitCode = 6;
      report.error =
        `the application at ${baseUrl} is not reachable from Windows ` +
        `(tried ${probe.attempts.map((a) => a.url).join(", ")}). ` +
        `WSL and Windows do not always share loopback addresses: ` +
        `check that the dev server is running and bound to 0.0.0.0 or that WSL localhost forwarding is enabled, ` +
        `or record with --backend local-playwright instead.`;
      writeReport(args.report, report);
      process.stderr.write(`${report.error}\n`);
      process.exit(6);
    }
    if (probe.ok && probe.resolvedUrl && probe.resolvedUrl.replace(/\/$/, "") !== baseUrl.replace(/\/$/, "")) {
      process.stderr.write(
        `[win-worker] note: ${baseUrl} is reachable from Windows as ${probe.resolvedUrl}; the recorder will use the reachable address\n`
      );
    }
  }

  // ---- re-enter the shared recorder under Windows ---------------------
  const recorder = path.join(SKILL_DIR, "scripts", "record-workflow.mjs");
  if (!fs.existsSync(recorder)) {
    report.exitCode = 2;
    report.error = `could not find the recorder at ${recorder}`;
    writeReport(args.report, report);
    process.stderr.write(`${report.error}\n`);
    process.exit(2);
  }

  const childArgs = [
    recorder,
    "--plan", args.plan,
    "--internal-backend", "windows-native",
  ];
  if (args.runDir) childArgs.push("--run-dir", args.runDir);
  if (args.outDir) childArgs.push("--out-dir", args.outDir);
  if (args.runName) childArgs.push("--run-name", args.runName);
  if (args.maxDurationMs) childArgs.push("--max-duration-ms", String(args.maxDurationMs));
  if (args.quality) childArgs.push("--quality", String(args.quality));
  if (args.fps) childArgs.push("--fps", String(args.fps));
  if (args.allowConsequential) childArgs.push("--allow-consequential");
  if (args.headed) childArgs.push("--headed");

  // Windows-launched browsers must not inherit a WSL-side browser path.
  const childEnv = { ...process.env };
  delete childEnv.PLAYWRIGHT_BROWSERS_PATH;
  delete childEnv.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD;
  delete childEnv.RECORD_APP_SKILL_NO_WINDOWS_INTEROP;

  childEnv.RECORD_APP_SKILL_PLAYWRIGHT_PATH = runtimeDir;
  // Where the agent is running, so the manifest can say that the pixels came
  // from Windows while the agent was on the Linux side.
  if (args.shellPlatform) childEnv.RECORD_APP_SKILL_SHELL_PLATFORM = args.shellPlatform;
  // Force the branded Chrome/Edge channel: a bundled Linux download would be
  // the wrong rendering environment, and the channel has already been chosen
  // from the host's own default browser.
  childEnv.RECORD_APP_SKILL_FORCE_CHANNEL = selection.id;

  process.stderr.write(
    `[win-worker] Windows ${process.arch}, Node ${process.version}\n` +
      `[win-worker] browser: ${selection.id} (${selection.source}) — ${selection.path ?? "?"}\n` +
      `[win-worker] playwright: ${report.playwright} (${runtimeDir})\n`
  );

  const child = spawn(process.execPath, childArgs, {
    stdio: ["ignore", "inherit", "pipe"],
    env: childEnv,
    windowsHide: true,
    cwd: path.dirname(process.execPath), // a real Windows directory, never a UNC cwd
  });

  const tail = [];
  child.stderr.on("data", (chunk) => {
    const text = String(chunk);
    process.stderr.write(text);
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) tail.push(line);
    }
    while (tail.length > 25) tail.shift();
  });

  child.on("close", (code) => {
    report.exitCode = code ?? 1;
    report.stderrTail = tail;
    report.finishedAt = new Date().toISOString();
    writeReport(args.report, report);
    process.exit(report.exitCode);
  });

  child.on("error", (err) => {
    report.exitCode = 1;
    report.error = `failed to start the recorder: ${err.message}`;
    writeReport(args.report, report);
    process.stderr.write(`${report.error}\n`);
    process.exit(1);
  });
}

/** Read `baseUrl` from a plan file without failing the run if it is unreadable. */
function readBaseUrl(planFile) {
  try {
    const plan = JSON.parse(fs.readFileSync(planFile, "utf8"));
    return typeof plan.baseUrl === "string" && plan.baseUrl ? plan.baseUrl : null;
  } catch {
    return null;
  }
}

/**
 * Probe a URL from the Windows side, trying both the given host and the
 * localhost/127.0.0.1 alternative, since which one reaches a WSL server from
 * Windows depends on the WSL networking mode.
 */
async function probeUrl(rawUrl, { timeoutMs = 10000 } = {}) {
  let target;
  try {
    target = new URL(rawUrl);
  } catch {
    return { ok: false, attempts: [{ url: rawUrl, error: "invalid URL" }] };
  }
  const candidates = [target.toString()];
  if (target.hostname === "localhost" || target.hostname === "127.0.0.1") {
    const alt = new URL(target.toString());
    alt.hostname = target.hostname === "localhost" ? "127.0.0.1" : "localhost";
    candidates.push(alt.toString());
  }
  const attempts = [];
  for (const candidate of candidates) {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(candidate, { method: "GET", redirect: "manual", signal: controller.signal });
      clearTimeout(timer);
      attempts.push({ url: candidate, status: res.status, ms: Date.now() - started });
      return { ok: true, resolvedUrl: candidate, status: res.status, attempts };
    } catch (err) {
      clearTimeout(timer);
      attempts.push({
        url: candidate,
        error: err?.name === "AbortError" ? "timed out" : String(err?.cause?.code ?? err?.message ?? err),
        ms: Date.now() - started,
      });
    }
  }
  return { ok: false, resolvedUrl: null, attempts };
}

try {
  await main();
} catch (err) {
  process.stderr.write(`win/worker.mjs: ${err?.stack ?? err}\n`);
  process.exit(2);
}
