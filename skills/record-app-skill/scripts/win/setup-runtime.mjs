#!/usr/bin/env node
/**
 * Install the Playwright runtime used by the native-Windows recording path.
 *
 * Run this from WSL. It installs into %LOCALAPPDATA%\record-app-skill\
 * playwright-runtime on the Windows side, so native Windows Chrome can be
 * driven without touching the WSL skill's own dependencies and without
 * requiring Playwright inside the WSL filesystem to be visible to Windows.
 *
 * Nothing is installed globally and no system configuration is changed.
 *
 * Usage:
 *   node scripts/win/setup-runtime.mjs [--force] [--version 1.64.1]
 *
 * Exit codes: 0 ok · 2 not applicable · 4 interop missing · 1 install failed
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { EXIT, assertSafeExternalPath, redactSecrets } from "../lib.mjs";
import { isWsl, linuxPathToWindows, windowsPathToLinuxPure, detectWindowsBackend, findWindowsPlaywrightFfmpeg, windowsFfmpegRevision, SKILL_DIR } from "../browser-env.mjs";

function parseArgs(argv) {
  const args = { force: false, version: null };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--force": args.force = true; break;
      case "--version": args.version = argv[++i]; break;
      case "-h":
      case "--help": args.help = true; break;
      default: throw new Error(`unknown option: ${argv[i]}`);
    }
  }
  return args;
}

const HELP = `Install the Windows-side Playwright runtime (run from WSL).

  node scripts/win/setup-runtime.mjs [--force] [--version <x.y.z>]

  --force            reinstall even when a matching runtime is present
  --version <x.y.z>  Playwright version to install (default: the skill's version)

Exit codes: 0 ok · 2 not applicable · 4 interop missing · 1 install failed
`;

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    process.exit(EXIT.OK);
  }

  if (!isWsl()) {
    process.stderr.write(
      "This script is only needed inside WSL.\n" +
        "On Linux, macOS or Windows, Playwright is installed with the skill itself:\n" +
        `  npm --prefix "${SKILL_DIR}" install\n`
    );
    process.exit(EXIT.INVALID_PLAN);
  }

  const detected = detectWindowsBackend();
  if (!detected.interop) {
    process.stderr.write(
      "Windows interop is not available from this WSL distribution, so the Windows-side runtime cannot be installed.\n" +
        `  details: ${detected.reasons.join("; ")}\n`
    );
    process.exit(EXIT.MISSING_DEPENDENCY);
  }
  if (!detected.node) {
    process.stderr.write(
      "Windows Node.js was not found. Install Node.js for Windows first (https://nodejs.org),\n" +
        "then re-run this script.\n"
    );
    process.exit(EXIT.MISSING_DEPENDENCY);
  }

  // Version to install: the skill's own Playwright version, so both backends
  // behave identically, unless overridden.
  let version = args.version;
  if (!version) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(SKILL_DIR, "package.json"), "utf8"));
      const semver = (pkg.dependencies?.playwright ?? "").replace(/^[^\d]*/, "");
      const installed = path.join(SKILL_DIR, "node_modules", "playwright", "package.json");
      version = fs.existsSync(installed) ? JSON.parse(fs.readFileSync(installed, "utf8")).version : semver || "latest";
    } catch {
      version = "latest";
    }
  }

  const runtimeWin = detected.runtimeLinuxPath ? linuxPathToWindows(detected.runtimeLinuxPath) : null;
  if (!runtimeWin) {
    process.stderr.write("could not determine %LOCALAPPDATA% on the Windows side\n");
    process.exit(EXIT.MISSING_DEPENDENCY);
  }

  const markerPath = path.join(detected.runtimeLinuxPath, "node_modules", "playwright", "package.json");
  if (!args.force && fs.existsSync(markerPath)) {
    try {
      const have = JSON.parse(fs.readFileSync(markerPath, "utf8")).version;
      if (have === version || version === "latest") {
        process.stdout.write(`Windows Playwright runtime already present (playwright ${have}) at ${detected.runtimeLinuxPath}\n`);
        process.exit(EXIT.OK);
      }
      process.stdout.write(`Windows runtime has playwright ${have}; installing ${version}...\n`);
    } catch {
      /* fall through to install */
    }
  }

  assertSafeExternalPath(runtimeWin, "Windows runtime path");

  // Passing a complex command line through WSL interop is fragile: escaped
  // quotes reach cmd.exe mangled ("The filename, directory name, or volume
  // label syntax is incorrect"). Writing a small batch file on the Windows side
  // and executing that removes every quoting ambiguity, because cmd.exe then
  // parses the quoting itself.
  const winNode = linuxPathToWindows(detected.node);
  const runtimeLinux = detected.runtimeLinuxPath;
  const parentLinux = runtimeLinux.replace(/[\\/][^\\/]*$/, "");
  fs.mkdirSync(parentLinux, { recursive: true });
  const batchLinux = path.join(parentLinux, "setup-runtime.cmd");
  const npmPath = winNode.replace(/\\[^\\]*$/, "\\npm.cmd");
  const nodePath = winNode;

  const spec = version === "latest" ? "playwright" : `playwright@${version}`;
  const batch = [
    "@echo off",
    "setlocal",
    `set "RUNTIME=${runtimeWin}"`,
    'if not exist "%RUNTIME%" mkdir "%RUNTIME%"',
    'cd /d "%RUNTIME%"',
    `"${npmPath}" install ${spec} --no-audit --no-fund --loglevel=error`,
    "if errorlevel 1 exit /b 1",
    "rem page.screencast needs Playwright's own ffmpeg build to mux the raw",
    "rem recording. It is installed per-user and changes no system settings.",
    `"${nodePath}" "%RUNTIME%\\node_modules\\playwright\\cli.js" install ffmpeg`,
    "if errorlevel 1 exit /b 2",
    "exit /b 0",
  ].join("\r\n");
  fs.writeFileSync(batchLinux, batch, "utf8");

  const cmdExe = "/mnt/c/Windows/System32/cmd.exe";
  const batchWin = linuxPathToWindows(batchLinux);
  assertSafeExternalPath(batchWin, "batch path");

  process.stdout.write(
    `Installing ${spec} into ${runtimeWin}\n` +
      `(downloaded from npm on the Windows side; nothing is installed globally)\n\n`
  );

  const result = spawnSync(cmdExe, ["/d", "/c", batchWin], {
    encoding: "utf8",
    timeout: 900000,
    windowsHide: true,
    cwd: "/mnt/c",
  });

  const out = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (out) process.stdout.write(`${out}\n`);

  const installedPkg = path.join(detected.runtimeLinuxPath, "node_modules", "playwright", "package.json");
  if (result.status !== 0 || !fs.existsSync(installedPkg)) {
    process.stderr.write(
      `\nFailed to install the Windows Playwright runtime (exit ${result.status ?? "?"}).\n` +
        `The generated script was left at ${batchLinux} for inspection.\n` +
        `You can also install it manually from a Windows terminal:\n` +
        `  cd %LOCALAPPDATA%\\record-app-skill\\playwright-runtime\n` +
        `  npm install ${spec}\n`
    );
    process.exit(EXIT.INTERNAL);
  }
  fs.rmSync(batchLinux, { force: true });

  const have = JSON.parse(fs.readFileSync(installedPkg, "utf8")).version;
  process.stdout.write(`\nWindows Playwright runtime ready (playwright ${have}).\n`);

  // `page.screencast` muxes the raw recording with Playwright's own ffmpeg
  // build, and Playwright pins that download by revision. A stale revision from
  // an older Playwright is not usable, so verify the exact revision.
  const revision = windowsFfmpegRevision();
  const pwFfmpeg = findWindowsPlaywrightFfmpeg();
  if (!pwFfmpeg) {
    process.stderr.write(
      `\nERROR: Playwright's ffmpeg build is still missing${revision ? ` (expected revision ffmpeg-${revision})` : ""}.\n` +
        `The windows-native backend cannot record without it.\n` +
        `Install it from a Windows terminal:\n` +
        `  cd %LOCALAPPDATA%\\record-app-skill\\playwright-runtime\n` +
        `  npx playwright install ffmpeg\n`
    );
    process.exit(EXIT.MISSING_DEPENDENCY);
  }
  process.stdout.write(`Playwright ffmpeg present (revision ${revision ?? "unknown"}): ${pwFfmpeg}\n`);

  // Verify a Windows-side browser is also present, since both are required.
  if (!detected.browsers?.length) {
    process.stdout.write(
      "\nNote: no Windows Chrome or Edge was found. Install Google Chrome for Windows\n" +
        "(https://www.google.com/chrome/) to use the windows-native backend.\n"
    );
  } else {
    const found = detected.browsers.map((b) => `${b.id}${b.version ? ` ${b.version}` : ""}`).join(", ");
    process.stdout.write(`Windows browser(s) detected: ${found}\n`);
    if (detected.defaultBrowser?.id) {
      process.stdout.write(
        `This machine's default browser is ${detected.defaultBrowser.id}` +
          `${detected.defaultBrowser.progId ? ` (${detected.defaultBrowser.progId})` : ""}.\n`
      );
    }
    process.stdout.write(`Next: node scripts/record-workflow.mjs --plan <plan> --backend windows-native\n`);
  }

  process.exit(EXIT.OK);
}

try {
  main();
} catch (err) {
  process.stderr.write(`error: ${redactSecrets(err?.message ?? String(err))}\n\n${HELP}`);
  process.exit(EXIT.INVALID_PLAN);
}
