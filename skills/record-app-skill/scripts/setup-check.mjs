#!/usr/bin/env node
/**
 * Report whether this machine can record and render a demo, and what to
 * install for anything that is missing.
 *
 * This script never installs anything and never modifies the target
 * application. It only inspects and explains.
 *
 * Usage:
 *   node setup-check.mjs [--backend local-playwright|windows-native|auto] [--json]
 *
 * Exit codes: 0 all required components present · 4 something required is missing
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EXIT } from "./lib.mjs";
import { checkFfmpeg, inspectFfmpeg, installGuidance, isPlaywrightBundled, findFont } from "./ffmpeg.mjs";
import {
  SKILL_DIR,
  resolvePlaywright,
  detectWindowsBackend,
  detectHostEnvironment,
  hostLabel,
  resolveBackend,
  isWsl,
  windowsRuntimeDirWindows,
  localFfmpegRevision,
  findLocalPlaywrightFfmpeg,
  findWindowsPlaywrightFfmpeg,
  windowsFfmpegRevision,
  localPlaywrightCacheDir,
} from "./browser-env.mjs";
import { browserName } from "./host-env.mjs";

function parseArgs(argv) {
  const args = { backend: "auto", json: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--backend": args.backend = argv[++i]; break;
      case "--json": args.json = true; break;
      case "-h":
      case "--help": args.help = true; break;
      default: throw new Error(`unknown option: ${argv[i]}`);
    }
  }
  return args;
}

const HELP = `Check whether this machine can record and render a demo.

  node setup-check.mjs [--backend auto|native|local-playwright|windows-native] [--json]

Exit codes: 0 ready · 4 a required component is missing
`;

const MIN_NODE_MAJOR = 20;

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    process.exit(EXIT.OK);
  }

  const required = [];
  const optional = [];
  const guidance = [];

  /* ---- Node.js ------------------------------------------------------ */
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const nodeOk = nodeMajor >= MIN_NODE_MAJOR;
  (nodeOk ? optional : required).push({
    component: "node",
    ok: nodeOk,
    detail: `Node.js ${process.versions.node} (${process.execPath})`,
    fix: nodeOk ? null : `Install Node.js ${MIN_NODE_MAJOR} or newer from https://nodejs.org — Playwright requires it.`,
  });
  if (!nodeOk && nodeMajor < 18) {
    guidance.push(`Your Node.js (${process.versions.node}) is too old. Upgrade before anything else.`);
  }

  /* ---- Playwright + browser ---------------------------------------- */
  let pw = null;
  try {
    pw = resolvePlaywright();
    optional.push({ component: "playwright", ok: true, detail: `playwright ${pw.version} (${pw.path})` });
  } catch (err) {
    required.push({
      component: "playwright",
      ok: false,
      detail: "the skill's Playwright dependency is not installed",
      fix:
        `npm --prefix "${SKILL_DIR}" install\n` +
        `npx --prefix "${SKILL_DIR}" playwright install chromium\n` +
        `(This installs inside the skill directory and does not touch your application.)`,
    });
    guidance.push("Playwright is missing; run the two commands above.");
  }

  let browserPath = null;
  let browserOk = false;
  if (pw) {
    try {
      browserPath = pw.playwright.chromium.executablePath();
      browserOk = Boolean(browserPath) && fs.existsSync(browserPath);
    } catch {
      browserOk = false;
    }
    if (!browserOk) {
      required.push({
        component: "browser",
        ok: false,
        detail: "the Chromium browser binary is not installed",
        fix: `npx --prefix "${SKILL_DIR}" playwright install chromium`,
      });
      guidance.push("The Chromium browser binary is missing; install it with the command above.");
    } else {
      let version = null;
      try {
        version = pw.playwright.chromium.executablePath().match(/chromium[_a-z]*-\d+/)?.[0] ?? null;
      } catch {
        /* advisory */
      }
      optional.push({
        component: "browser",
        ok: true,
        detail: `Chromium at ${browserPath}${version ? ` (${version})` : ""} — the fallback when no branded browser is installed`,
      });
    }
  }

  /* ---- FFmpeg (required for the MP4) -------------------------------- */
  const ff = checkFfmpeg({ requireMp4: true });
  const ffProbeInfo = ff.ffprobe ? inspectFfmpeg(ff.ffprobe, { full: false }) : null;

  if (ff.ok) {
    optional.push({
      component: "ffmpeg",
      ok: true,
      detail: `${ff.ffmpegReport.version ?? "ffmpeg"}${ff.ffmpegReport.hasH264 ? " (H.264 + MP4 supported)" : ""}`,
    });
  } else {
    required.push({
      component: "ffmpeg",
      ok: false,
      detail: ff.problems.join("; ") || "ffmpeg was not found",
      fix: installGuidance().join("\n"),
    });
    guidance.push(...installGuidance());
  }

  if (ffProbeInfo?.exists) {
    optional.push({ component: "ffprobe", ok: true, detail: ffProbeInfo.version ?? "ffprobe present" });
  } else {
    optional.push({
      component: "ffprobe",
      ok: false,
      severity: "optional",
      detail: "ffprobe not found — media will be validated with the built-in container parser instead",
      fix: "Usually shipped with ffmpeg; install ffmpeg and ffprobe will come with it.",
    });
  }

  /* ---- Playwright's own ffmpeg (required by page.screencast) --------- */
  const localRevision = localFfmpegRevision();
  const localFfmpeg = findLocalPlaywrightFfmpeg();
  if (localFfmpeg) {
    optional.push({
      component: "screencast-ffmpeg",
      ok: true,
      detail: `Playwright ffmpeg revision ${localRevision ?? "unknown"} at ${localFfmpeg}`,
    });
  } else {
    required.push({
      component: "screencast-ffmpeg",
      ok: false,
      detail:
        `Playwright's ffmpeg build${localRevision ? ` (revision ${localRevision})` : ""} is missing at ` +
        `${localPlaywrightCacheDir()}; recording cannot produce a video file without it`,
      fix: `npx --prefix "${SKILL_DIR}" playwright install ffmpeg`,
    });
    guidance.push(
      "Playwright's ffmpeg build is missing. Install it with:\n" +
        `  npx --prefix "${SKILL_DIR}" playwright install ffmpeg`
    );
  }

  /* ---- Fonts (contact sheet labels) --------------------------------- */
  const font = findFont();
  optional.push({
    component: "font",
    ok: Boolean(font),
    severity: "optional",
    detail: font ? `font available for contact-sheet labels: ${font}` : "no font found; contact-sheet cells will be unlabelled",
    fix: font ? null : "Install a basic font package (e.g. fonts-dejavu) for labelled contact sheets. Labels are optional — the sheet is still produced.",
  });

  /* ---- The rendering host --------------------------------------------- */
  const host = detectHostEnvironment();
  optional.push({
    component: "host",
    ok: true,
    severity: "optional",
    detail:
      `${hostLabel(host)}` +
      `${host.shellPlatform !== host.renderPlatform ? ` (the agent runs on ${host.shellPlatform})` : ""}` +
      `${host.networking ? `, WSL networking: ${host.networking}` : ""}`,
    fix: null,
  });

  /* ---- The browser the demo will actually use ----------------------- */
  // The demo should look like the product the developer sees every day, which
  // means the browser they already have. Playwright's bundled Chromium renders
  // fonts differently, so its presence is not a substitute.
  const backend = resolveBackend(args.backend);
  const nativeBrowser = backend.browser ?? {};
  optional.push({
    component: "system-browser",
    ok: Boolean(nativeBrowser.id) && nativeBrowser.source !== "playwright-bundled",
    severity: "optional",
    detail: nativeBrowser.id
      ? `${browserName(nativeBrowser.id)} on ${hostLabel(host)} [${nativeBrowser.source ?? "unknown"}]` +
        `${nativeBrowser.version ? `, version ${nativeBrowser.version}` : ""}`
      : "no branded browser was found on the rendering host — recordings fall back to Playwright's bundled Chromium, which renders fonts differently",
    fix: nativeBrowser.id
      ? null
      : "Install Google Chrome or Microsoft Edge to record with the fonts your users actually see.",
  });

  /* ---- Windows-native backend --------------------------------------- */
  const windows = detectWindowsBackend();
  let windowsEntry;
  if (!windows.wsl) {
    windowsEntry = {
      component: "windows-native",
      ok: true,
      severity: "optional",
      detail: "not running in WSL — this host records its own browser directly",
      fix: null,
    };
  } else if (windows.usable) {
    windowsEntry = {
      component: "windows-native",
      ok: true,
      detail:
        `ready — ${windows.defaultBrowser?.id ? browserName(windows.defaultBrowser.id) : "Windows Chrome"}` +
        `${windows.browsers[0]?.version ? ` ${windows.browsers[0].version}` : ""}, ` +
        `Windows Node, Playwright ${windows.playwrightVersion ?? "?"} ` +
        `(ffmpeg revision ${windowsFfmpegRevision() ?? "unknown"})`,
      fix: null,
    };
  } else {
    windowsEntry = {
      component: "windows-native",
      ok: false,
      severity: "optional",
      detail: `not available: ${windows.reasons.join("; ")}`,
      fix: [
        windows.browsers.length ? null : "Install Google Chrome for Windows (https://www.google.com/chrome/).",
        windows.node ? null : "Install Node.js for Windows (https://nodejs.org).",
        windows.usable ? null : `Then run: node "${path.join(SKILL_DIR, "scripts", "win", "setup-runtime.mjs")}"`,
      ]
        .filter(Boolean)
        .join("\n"),
      runtimeDir: windowsRuntimeDirWindows(),
      ffmpeg: findWindowsPlaywrightFfmpeg(),
    };
  }
  optional.push(windowsEntry);

  /* ---- The backend decision ------------------------------------------ */
  if (backend.unavailable) {
    required.push({
      component: "requested-backend",
      ok: false,
      detail: `the ${args.backend} backend is unavailable: ${backend.reason}`,
      fix: [
        ...(backend.requirements ?? []).map((r) => `Needs: ${r}`),
        ...(backend.alternatives ?? []).map((a) => `Or: ${a}`),
      ].join("\n") || "Run env-detect.mjs for the full report.",
    });
  }

  /* ---- Output directory writability --------------------------------- */
  const tmpDir = path.join(os.tmpdir(), "record-app-skill-setup-check");
  let writable = false;
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    const probe = path.join(tmpDir, `.probe-${process.pid}`);
    fs.writeFileSync(probe, "ok");
    fs.rmSync(probe, { force: true });
    writable = true;
  } catch {
    writable = false;
  }
  (writable ? optional : required).push({
    component: "output",
    ok: writable,
    detail: writable ? `temporary output is writable (${tmpDir})` : `cannot write to ${tmpDir}`,
    fix: writable ? null : "Check permissions on your temporary directory, or set RECORD_APP_SKILL_TMP to a writable path.",
  });

  const ready = required.every((r) => r.ok);
  const report = {
    skill: "record-app-skill",
    checkedAt: new Date().toISOString(),
    ready,
    exitCode: ready ? EXIT.OK : EXIT.MISSING_DEPENDENCY,
    environment: {
      platform: process.platform,
      arch: process.arch,
      node: process.versions.node,
      wsl: isWsl(),
      distro: process.env.WSL_DISTRO_NAME ?? null,
      skillDir: SKILL_DIR,
    },
    host: {
      kind: host.kind,
      label: hostLabel(host),
      shellPlatform: host.shellPlatform,
      renderPlatform: host.renderPlatform,
      networking: host.networking,
    },
    browser: {
      id: backend.browser?.id ?? null,
      name: backend.browser?.name ?? null,
      source: backend.browser?.source ?? null,
      version: backend.browser?.version ?? null,
    },
    backend: {
      requested: backend.requested,
      resolved: backend.backend,
      strategy: backend.strategy,
      channel: backend.channel,
      reason: backend.reason,
      available: !backend.unavailable,
    },
    required,
    optional,
    guidance: [...new Set(guidance)],
  };

  if (args.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    const mark = (c) => (c.ok ? "ok  " : c.severity === "optional" ? "warn" : "MISS");
    process.stdout.write(`\nrecord-app-skill setup check\n`);
    process.stdout.write(`  environment : ${process.platform}/${process.arch}, Node ${process.versions.node}${isWsl() ? `, WSL (${process.env.WSL_DISTRO_NAME ?? "?"})` : ""}\n`);
    process.stdout.write(`  rendering   : ${hostLabel(host)}\n`);
    process.stdout.write(`  backend     : ${backend.backend} (${backend.reason})\n\n`);
    for (const c of [...required, ...optional]) {
      process.stdout.write(`  [${mark(c)}] ${c.component.padEnd(16)} ${c.detail}\n`);
      if (!c.ok && c.fix) {
        for (const line of String(c.fix).split("\n")) process.stdout.write(`         → ${line}\n`);
      }
    }
    process.stdout.write(
      ready
        ? `\nReady. Record with: node scripts/record-workflow.mjs --plan workflow.json\n`
        : `\nNot ready: ${required.filter((r) => !r.ok).map((r) => r.component).join(", ")} must be resolved first.\n`
    );
    if (report.guidance.length && !ready) {
      process.stdout.write(`\n${report.guidance.join("\n")}\n`);
    }
  }

  process.exit(report.exitCode);
}


main();
