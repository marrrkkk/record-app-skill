/**
 * Delegate a recording to native Windows Chrome.
 *
 * Runs on the WSL side. Everything it needs crosses the boundary as argv or as
 * files, because WSL interop does not forward environment variables into
 * Windows processes. Node on Windows can execute and import scripts from the
 * WSL filesystem over UNC, so the worker runs the same recorder source that the
 * local backend runs — one executor, two browser environments.
 *
 * Nothing here installs anything: missing prerequisites are reported with the
 * exact command that fixes them.
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { EXIT, assertSafeExternalPath, formatBytes, failureStatus, writeFailureReport } from "./lib.mjs";
import {
  detectWindowsBackend,
  linuxPathToWindows,
  windowsPathToLinuxPure,
  wslDistro,
  SKILL_DIR,
} from "./browser-env.mjs";

const WORKER_REPORT = "windows-worker.json";

/** Read a JSON file, or return null: the summary is diagnostic, never fatal. */
function readJsonIfPresent(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Convert paths and run the Windows worker.
 *
 * @returns {Promise<{code:number, ok:boolean, runDir:string, backend:string,
 *   reportPath:string|null, failure:object|null, warnings:string[]}>}
 */
export async function runWindowsRecording({
  plan,
  runDirLinux,
  planFile,
  maxDurationMs,
  allowConsequential,
  headed,
  quality = null,
  fps = null,
  channel = null,
  json = false,
}) {
  const windows = detectWindowsBackend();
  const problems = [];
  if (!windows.wsl) problems.push("not running inside WSL");
  if (!windows.interop) problems.push("Windows interop (cmd.exe) is unavailable");
  if (!windows.node) problems.push("Windows Node.js was not found (install from https://nodejs.org)");
  if (!windows.browsers?.length) {
    problems.push(
      "no Google Chrome or Microsoft Edge was found on the Windows side " +
        "(looked in C:\\Program Files and C:\\Program Files (x86))"
    );
  }
  const defaultBrowser = windows.defaultBrowser ?? { id: null };
  if (defaultBrowser.id && !["chrome", "msedge"].includes(defaultBrowser.id)) {
    problems.push(
      `the Windows default browser is ${defaultBrowser.id}, which this skill cannot drive natively; ` +
        `install Google Chrome or Microsoft Edge, or select one explicitly`
    );
  }
  if (!windows.runtimeInstalled) {
    problems.push("the Windows Playwright runtime is not installed (run scripts/win/setup-runtime.mjs)");
  }
  if (problems.length) {
    return {
      code: EXIT.MISSING_DEPENDENCY,
      ok: false,
      runDir: runDirLinux,
      backend: "windows-native",
      reportPath: null,
      failure: {
        stepId: null,
        name: "WindowsBackendUnavailable",
        message: `native Windows rendering is unavailable: ${problems.join("; ")}`,
        guidance: "Run: node scripts/setup-check.mjs --backend windows-native",
      },
      warnings: [],
      artifacts: [],
    };
  }

  const worker = path.join(SKILL_DIR, "scripts", "win", "worker.mjs");
  // The worker itself is executed by Windows Node, so its own path must be a
  // Windows-visible path too (a bare Linux path would resolve to C:\home\...).
  const workerWin = linuxPathToWindows(worker);
  const runtimeWin = linuxPathToWindows(windows.runtimeLinuxPath);
  const planWin = linuxPathToWindows(path.resolve(planFile));
  const outWin = linuxPathToWindows(runDirLinux);
  const reportLinux = path.join(runDirLinux, WORKER_REPORT);
  const reportWin = linuxPathToWindows(reportLinux);

  for (const [value, label] of [
    [workerWin, "worker path"],
    [planWin, "plan path"],
    [outWin, "output directory"],
    [reportWin, "report path"],
  ]) {
    assertSafeExternalPath(value, label);
  }

  // The plan is re-read by the Windows side, so make sure it is reachable and
  // is the same content that was validated here.
  const workerArgs = [
    workerWin,
    "--plan", planWin,
    // The run directory is decided here, so both sides record into the same
    // directory instead of the Windows side creating a second nested one.
    "--run-dir", outWin,
    "--out-dir", linuxPathToWindows(path.dirname(runDirLinux)),
    "--report", reportWin,
    "--runtime", runtimeWin,
  ];
  if (plan.title) workerArgs.push("--run-name", plan.title);
  if (Number.isFinite(maxDurationMs)) workerArgs.push("--max-duration-ms", String(maxDurationMs));
  if (quality) workerArgs.push("--quality", String(quality));
  if (Number.isFinite(fps)) workerArgs.push("--fps", String(fps));
  // Where the agent itself is running. The Windows side records the pixels,
  // but the manifest should still say that the agent was on the Linux side.
  workerArgs.push("--shell-platform", process.platform);
  // The browser the WSL side selected for the Windows host. The worker
  // re-checks it against what is actually installed and falls back to the
  // host's own default when the selection cannot be honoured.
  if (channel) workerArgs.push("--channel", String(channel));
  if (allowConsequential) workerArgs.push("--allow-consequential");
  if (headed) workerArgs.push("--headed");

  process.stderr.write(
    `\nDelegating to native Windows Chrome\n` +
      `  distro  : ${wslDistro()}\n` +
      `  browser : ${defaultBrowser.id ?? "the Windows default browser"}${windows.browsers?.[0] ? ` (${linuxPathToWindows(windows.browsers[0].linuxPath)})` : ""}\n` +
      `  plan    : ${planWin}\n` +
      `  output  : ${outWin}\n\n`
  );

  const started = Date.now();
  // cmd.exe is not used: node.exe is invoked directly, so no shell quoting is
  // involved at all. The working directory stays on a real Windows drive
  // because a UNC current directory confuses some Windows tooling.
  const result = spawnSync(windows.node, workerArgs, {
    encoding: "utf8",
    timeout: Math.max(120000, (maxDurationMs ?? 240000) + 180000),
    windowsHide: true,
    cwd: "/mnt/c",
    maxBuffer: 32 * 1024 * 1024,
  });

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (stderr.trim()) process.stderr.write(toLinuxPaths(stderr, windows));
  if (stdout.trim()) {
    // When the caller asked for JSON, stdout belongs to their parser: the
    // Windows-side human summary goes to stderr instead of corrupting it.
    const text = toLinuxPaths(stdout, windows);
    if (json) process.stderr.write(text);
    else process.stdout.write(text);
  }

  const exitCode = typeof result.status === "number" ? result.status : EXIT.INTERNAL;
  let workerReport = null;
  try {
    workerReport = JSON.parse(fs.readFileSync(reportLinux, "utf8"));
  } catch {
    /* older or failed runs may not have written one */
  }

  // Summarize what the Windows side actually produced, so the caller reports
  // real numbers rather than assuming success.
  const demoLinux = path.join(runDirLinux, "demo.mp4");
  const rawLinux = path.join(runDirLinux, "raw-recording.webm");
  const artifacts = [demoLinux, rawLinux].filter((f) => fs.existsSync(f) && fs.statSync(f).size > 0);

  // The Windows side wrote the same artifacts the Linux path writes, so the
  // summary is derived from them rather than from the worker's exit code: a
  // caller must get the same field names and the same meaning on either
  // backend.
  const timeline = readJsonIfPresent(path.join(runDirLinux, "timeline.json"));
  const steps = timeline?.steps ?? [];
  const stepsFailed = steps.filter((s) => s.status !== "ok").length;
  const recordedOk = exitCode === EXIT.OK && Boolean(timeline) && stepsFailed === 0;

  const summary = {
    code: exitCode,
    ok: recordedOk,
    runDir: runDirLinux,
    backend: "windows-native",
    reportPath: fs.existsSync(reportLinux) ? reportLinux : null,
    elapsedMs: Date.now() - started,
    worker: workerReport
      ? {
          platform: workerReport.platform,
          node: workerReport.node,
          playwright: workerReport.playwright,
          chrome: workerReport.chrome,
          error: workerReport.error ?? null,
          stderrTail: workerReport.stderrTail ?? [],
        }
      : null,
    status: recordedOk ? "recorded" : timeline ? "workflow-failed" : failureStatus(exitCode),
    rawRecording: fs.existsSync(rawLinux) ? rawLinux : null,
    rawBytes: fs.existsSync(rawLinux) ? fs.statSync(rawLinux).size : 0,
    rawBytesHuman: fs.existsSync(rawLinux) ? formatBytes(fs.statSync(rawLinux).size) : null,
    durationMs: timeline?.captureDurationMs ?? null,
    steps: steps.length,
    stepsFailed,
    failure: recordedOk
      ? null
      : timeline
        ? (() => {
            const failed = steps.find((s) => s.status !== "ok");
            return failed?.error
              ? { stepId: failed.id, ...failed.error }
              : { stepId: null, name: "StepFailed", message: `${stepsFailed} step(s) failed` };
          })()
        : {
            stepId: null,
            name: workerExitName(exitCode),
            message:
              workerReport?.error ??
              (workerReport?.stderrTail?.length
                ? workerReport.stderrTail.slice(-3).join(" ")
                : `the Windows worker exited with code ${exitCode}`),
          },
    warnings: timeline?.warnings ?? [],
    artifacts,
  };

  if (exitCode !== EXIT.OK && !artifacts.length) {
    summary.failure.message +=
      `\nNo recording was produced. Run the Windows worker directly for details:\n` +
      `  node scripts/win/worker.mjs --plan "${planWin}" --out-dir "${outWin}"`;
  }

  // A delegated failure must leave the same two files a local failure does:
  // the recorder writes its own when it got far enough to record, and this
  // path writes them when the worker failed before that. Without this the run
  // directory held only `windows-worker.json`, so "read report.md in the run
  // directory" — what the skill tells an agent to do — was false on Windows.
  if (exitCode !== EXIT.OK && !fs.existsSync(path.join(runDirLinux, "manifest.json"))) {
    writeFailureReport(runDirLinux, exitCode, summary.failure.message, {
      backend: "windows-native",
      worker: workerReport
        ? { platform: workerReport.platform, node: workerReport.node, error: workerReport.error ?? null }
        : null,
    });
  }

  return summary;
}

const BS = String.fromCharCode(92);

/** `\\host\distro\` — built by concatenation so no escaping rules apply. */
function uncPrefix(host, distro) {
  return `${BS}${BS}${host}${BS}${distro}${BS}`;
}

/**
 * Rewrite Windows paths in delegated output back into paths a WSL user can
 * paste into a shell: `\\wsl.localhost\<distro>\a\b` becomes `/a/b`, and
 * `C:\a\b` becomes `/mnt/c/a/b`.
 *
 * This only affects what is *displayed*. Reports are read from files, never
 * re-parsed from this text, so a display-only rewrite cannot corrupt data.
 */
export function toLinuxPaths(text, windows = null) {
  if (typeof text !== "string" || !text) return text;
  const distro = windows?.wsl ? wslDistro() : null;
  let out = text;

  if (distro) {
    for (const host of ["wsl.localhost", "wsl$"]) {
      const plain = uncPrefix(host, distro);
      // Both the console form and the JSON-escaped form (every `\` doubled).
      for (const prefix of [plain, plain.split(BS).join(BS + BS)]) {
        out = out.split(prefix).join("/");
      }
    }
  }

  // Any token still holding backslashes is a Windows path: normalise it. Empty
  // segments are dropped so a JSON-escaped path (`C:\\a\\b`) collapses to the
  // same result as the plain form (`C:\a\b`).
  out = out.replace(/[^\s"']*\\[^\s"']*/g, (token) =>
    token
      .split(BS)
      .filter((segment) => segment !== "")
      .join("/")
  );
  // Drive letters that correspond to a WSL mount point.
  out = out.replace(/(^|[\s"'(])([a-zA-Z]):\//g, (_, lead, drive) => `${lead}/mnt/${drive.toLowerCase()}/`);
  return out;
}

function workerExitName(code) {
  switch (code) {
    case 2:
      return "WindowsWorkerUsageError";
    case 6:
      return "WindowsAppUnreachable";
    case 4:
      // Chrome, the Playwright runtime or Playwright's ffmpeg is missing on
      // the Windows side. The worker speaks the shared exit-code contract, so
      // this is the same code a local run uses for a missing dependency.
      return "WindowsDependencyMissing";
    default:
      return "WindowsWorkerFailed";
  }
}

/** Exposed for tests: the pure Windows-side path conversion used above. */
export function windowsPathFor(linuxPath) {
  return linuxPathToWindows(linuxPath);
}

/** Exposed for tests: round-trip helper. */
export function linuxPathFor(windowsPath) {
  return windowsPathToLinuxPure(windowsPath);
}
