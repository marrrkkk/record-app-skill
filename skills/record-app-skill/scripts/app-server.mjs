/**
 * Production builds and preview servers for recordings.
 *
 * A demo is only as good as the build it was recorded against. A development
 * server ships hot-reload machinery, unminified bundles, source maps and
 * dev-only warnings, and every one of those shows up in a recording as lag,
 * jank and console noise. This module builds the application the way it ships,
 * serves the built output, and hands the recorder a URL that is guaranteed to
 * answer before the first frame is captured.
 *
 * Two properties are deliberate:
 *
 *  - A plan may only *name* npm scripts that exist in the application's own
 *    package.json. Arbitrary commands are accepted from the command line only,
 *    and only behind an explicit `sh:` prefix, so a plan stays data instead of
 *    becoming a shell to execute.
 *  - A server started here is always stopped again, including when the
 *    recording fails, so a failed demo never leaves a process behind.
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { probeUrl } from "./browser-env.mjs";

export const APP_MODES = ["existing", "production"];

const DEFAULT_BUILD_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_READY_TIMEOUT_MS = 60 * 1000;
const OUTPUT_TAIL_LINES = 60;

/* ------------------------------------------------------------------ */
/* The application under the lens                                      */
/* ------------------------------------------------------------------ */

/** Read the application's package.json, if there is one. */
export function readPackageJson(root) {
  const file = path.join(root, "package.json");
  if (!fs.existsSync(file)) return { ok: false, file, error: `no package.json in ${root}` };
  try {
    return { ok: true, file, pkg: JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch (err) {
    return { ok: false, file, error: `${file} is not valid JSON (${err.message})` };
  }
}

/** The scripts an application defines, as { name: body }. */
export function listScripts(root) {
  const read = readPackageJson(root);
  if (!read.ok) return {};
  const scripts = read.pkg?.scripts;
  return scripts && typeof scripts === "object" ? scripts : {};
}

/**
 * Which package manager this project uses. The lockfile decides, because
 * running `npm install` in a pnpm project produces a tree that does not match
 * the one the developer ships.
 */
export function detectPackageManager(root) {
  if (fs.existsSync(path.join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(root, "yarn.lock"))) return "yarn";
  if (fs.existsSync(path.join(root, "bun.lockb"))) return "bun";
  return "npm";
}

/** The command that runs one npm script. */
export function scriptCommand(manager, script, extraArgs = []) {
  const base = manager === "npm" ? `npm run ${script}` : `${manager} run ${script}`;
  return extraArgs.length ? `${base} -- ${extraArgs.join(" ")}` : base;
}

/* ------------------------------------------------------------------ */
/* Serving the built output                                            */
/* ------------------------------------------------------------------ */

/**
 * How to point a known server at a specific port.
 *
 * The port has to match the URL the recorder will use, and each framework
 * spells that differently. The match is deliberately narrow: an unrecognised
 * script gets no arguments rather than the wrong ones.
 */
const SERVE_ADAPTERS = [
  { id: "vite", match: /\bvite\s+preview\b/, args: (port) => ["--port", String(port), "--strictPort", "--host", "127.0.0.1"] },
  { id: "next", match: /\bnext\s+start\b/, args: (port) => ["-p", String(port)] },
  { id: "ng", match: /\bng\s+serve\b/, args: (port) => ["--port", String(port)] },
  { id: "http-server", match: /\bhttp-server\b/, args: (port) => ["--port", String(port)] },
  { id: "serve", match: /(^|\s)serve(\s|$)/, args: (port) => ["-l", String(port)] },
  { id: "react-scripts", match: /\breact-scripts\s+start\b/, args: () => [], env: (port) => ({ PORT: String(port) }) },
];

/**
 * Arguments and environment for a serve script, so it listens where the
 * recorder expects. Returns `{ args, env, adapter }`; an unknown framework
 * gets neither, and the readiness probe then reports the real problem.
 */
export function serveInvocationFor(scriptBody, port) {
  if (!scriptBody || !Number.isInteger(port)) return { args: [], env: {}, adapter: null };
  for (const adapter of SERVE_ADAPTERS) {
    if (!adapter.match.test(scriptBody)) continue;
    return {
      args: adapter.args(port),
      env: adapter.env ? adapter.env(port) : {},
      adapter: adapter.id,
    };
  }
  return { args: [], env: {}, adapter: null };
}

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

/**
 * Turn a plan's `app` section and the command line into one resolved config.
 *
 * Precedence is command line over plan, and the plan over auto-detection. The
 * returned config is plain data: it names the commands to run and the URL to
 * record against, and nothing else.
 */
export function resolveAppConfig({ plan = {}, cli = {}, planDir = process.cwd() } = {}) {
  const appPlan = plan.app ?? {};
  // A relative root belongs to the plan, so it is resolved against the plan's
  // own directory rather than the working directory.
  const declaredRoot = cli.appRoot ?? appPlan.root ?? null;
  const root = declaredRoot
    ? path.resolve(path.isAbsolute(declaredRoot) ? declaredRoot : path.join(planDir, declaredRoot))
    : path.resolve(planDir);
  const notes = [];

  const buildSpec = cli.build ?? appPlan.build ?? null;
  const serveSpec = cli.serve ?? appPlan.serve ?? null;
  const production =
    cli.production === true || appPlan.mode === "production" || Boolean(buildSpec) || Boolean(serveSpec);

  if (!production) {
    return { enabled: false, mode: "existing", root, build: null, serve: null, notes, manager: detectPackageManager(root) };
  }

  const manager = detectPackageManager(root);
  const scripts = listScripts(root);
  const scriptNames = Object.keys(scripts);

  const pickScript = (candidates) => candidates.find((name) => scriptNames.includes(name)) ?? null;

  // ---- build -----------------------------------------------------------
  let build = null;
  if (buildSpec) {
    const resolved = resolveCommandSpec(buildSpec, scripts, "build", manager);
    if (resolved.error) return { error: resolved.error, root, notes };
    build = { ...resolved, timeoutMs: appPlan.buildTimeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS };
  } else {
    const name = pickScript(["build", "build:prod", "build:production", "compile"]);
    if (!name) {
      return {
        error:
          `no production build script was found in ${root}` +
          (scriptNames.length
            ? `; available scripts: ${scriptNames.join(", ")}`
            : "; the directory has no package.json scripts") +
          ". Name the build script in the plan's \"app.build\" field or pass --build <script>.",
        root,
        notes,
      };
    }
    build = {
      kind: "npm-script",
      value: name,
      command: scriptCommand(manager, name),
      timeoutMs: appPlan.buildTimeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS,
    };
    notes.push(`build: ${build.command}`);
  }

  // ---- serve -----------------------------------------------------------
  const serveUrl = cli.serveUrl ?? appPlan.url ?? plan.baseUrl ?? null;
  let serve = null;
  if (serveSpec) {
    const resolved = resolveCommandSpec(serveSpec, scripts, "serve", manager);
    if (resolved.error) return { error: resolved.error, root, notes };
    serve = { ...resolved, url: serveUrl, timeoutMs: appPlan.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS };
  } else {
    const name = pickScript(["preview", "serve", "start"]);
    if (!name) {
      return {
        error:
          `no script was found to serve the built application in ${root}` +
          (scriptNames.length
            ? `; available scripts: ${scriptNames.join(", ")}`
            : "; the directory has no package.json scripts") +
          '. Name it in the plan\'s "app.serve" field or pass --serve <script>.',
        root,
        notes,
      };
    }
    serve = {
      kind: "npm-script",
      value: name,
      command: scriptCommand(manager, name),
      url: serveUrl,
      timeoutMs: appPlan.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
    };
    notes.push(`serve: ${serve.command}`);
  }

  // Point the server at the port the recorder will use, when the framework is
  // one we know how to configure.
  const port = portOf(serveUrl);
  if (serve.kind === "npm-script" && port) {
    const body = scripts[serve.value] ?? "";
    const invocation = serveInvocationFor(body, port);
    if (invocation.args.length) {
      serve.command = scriptCommand(manager, serve.value, invocation.args);
      notes.push(`serve: bound to port ${port} via ${invocation.adapter}`);
    }
    if (Object.keys(invocation.env).length) {
      serve.env = { ...(serve.env ?? {}), ...invocation.env };
      notes.push(`serve: set ${Object.keys(invocation.env).join(", ")} for ${invocation.adapter}`);
    }
  }

  return { enabled: true, mode: "production", root, build, serve, notes, manager };
}

/**
 * Resolve one command specification.
 *
 * `sh:<command>` is a shell command and is only accepted from the command
 * line. Anything else names an npm script, which must exist — a typo becomes
 * a clear error instead of a mysterious build failure.
 */
function resolveCommandSpec(spec, scripts, label, manager = "npm") {
  const value = String(spec).trim();
  if (value.startsWith("sh:")) {
    const command = value.slice(3).trim();
    if (!command) return { error: `the ${label} command is empty` };
    return { kind: "command", value: command, command };
  }
  if (!scripts[value]) {
    const available = Object.keys(scripts);
    return {
      error:
        `no npm script named "${value}" exists in the application` +
        (available.length ? `; available scripts: ${available.join(", ")}` : "; the application defines no scripts"),
    };
  }
  return { kind: "npm-script", value, command: scriptCommand(manager, value) };
}

/** The port in a URL, or null when the URL has none. */
export function portOf(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (!parsed.port) return null;
    const port = Number(parsed.port);
    return Number.isInteger(port) ? port : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Running things                                                      */
/* ------------------------------------------------------------------ */

/** Run a command to completion, capturing a bounded tail of its output. */
export function runCommand(command, { cwd, timeoutMs = DEFAULT_BUILD_TIMEOUT_MS, env = {} } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, {
      cwd,
      shell: true,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const lines = [];
    const collect = (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (line.trim()) lines.push(line);
      }
      while (lines.length > 400) lines.shift();
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child, "SIGTERM");
      setTimeout(() => killGroup(child, "SIGKILL"), 2000).unref?.();
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, code: null, error: err.message, command, durationMs: Date.now() - started, output: lines.slice(-OUTPUT_TAIL_LINES) });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        ok: !timedOut && code === 0,
        code,
        signal,
        timedOut,
        command,
        durationMs: Date.now() - started,
        output: lines.slice(-OUTPUT_TAIL_LINES),
      });
    });
  });
}

/** Kill a detached child's whole process group, so no orphan survives. */
function killGroup(child, signal) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

/**
 * Build the application the way it ships.
 *
 * @returns {Promise<{ok:boolean, command:string, durationMs:number, output:string[], error?:string}>}
 */
export async function runProductionBuild(config, { log = () => {} } = {}) {
  if (!config?.build) return { ok: true, command: null, durationMs: 0, output: [], skipped: true };
  const { command, timeoutMs, env } = config.build;
  log(`Building the production bundle: ${command}`);
  const result = await runCommand(command, { cwd: config.root, timeoutMs, env });
  if (!result.ok) {
    return {
      ok: false,
      command,
      durationMs: result.durationMs,
      output: result.output,
      error: result.timedOut
        ? `the production build timed out after ${Math.round(timeoutMs / 1000)}s`
        : result.error ?? `the production build failed with exit code ${result.code}`,
    };
  }
  log(`Production build finished in ${(result.durationMs / 1000).toFixed(1)}s`);
  return { ok: true, command, durationMs: result.durationMs, output: result.output };
}

/** Poll a URL until it answers, the server dies, or the deadline passes. */
async function waitForServer(url, { timeoutMs, isAlive, log }) {
  const deadline = Date.now() + timeoutMs;
  const attempts = [];
  while (Date.now() < deadline) {
    if (isAlive && !isAlive()) {
      return { ok: false, error: "the server exited before it became reachable", attempts };
    }
    const probe = await probeUrl(url, { timeoutMs: 3000 });
    attempts.push(...probe.attempts);
    if (probe.ok) {
      // A URL that answers is not proof that *this* server is answering it:
      // an older server on the same port would answer just as well. Give the
      // process a moment to fail (a port clash takes a moment to surface) and
      // then require it to still be alive for the answer to be ours.
      await new Promise((resolve) => setTimeout(resolve, 600));
      if (isAlive && !isAlive()) {
        return {
          ok: false,
          error: `the server exited, although ${url} answers — another process is probably using that port`,
          attempts,
        };
      }
      return { ok: true, url: probe.resolvedUrl ?? url, attempts };
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return {
    ok: false,
    error: `${url} did not answer within ${Math.round(timeoutMs / 1000)}s`,
    attempts,
  };
}

/**
 * Start the server that hosts the built application and wait until it
 * answers.
 *
 * @returns {Promise<{ok:boolean, url?:string, command?:string, stop?:() => Promise<void>, output:string[], error?:string}>}
 */
export async function startPreviewServer(config, { log = () => {} } = {}) {
  if (!config?.serve) return { ok: true, output: [], skipped: true };
  const { command, url, timeoutMs, env } = config.serve;
  if (!url) {
    return { ok: false, output: [], error: "no URL to serve the application at; pass --serve-url or set baseUrl" };
  }
  log(`Starting the production server: ${command}`);
  const child = spawn(command, {
    cwd: config.root,
    shell: true,
    env: { ...process.env, ...(env ?? {}) },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const lines = [];
  const collect = (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (line.trim()) lines.push(line);
    }
    while (lines.length > 400) lines.shift();
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);

  let exited = null;
  child.on("exit", (code, signal) => {
    exited = { code, signal };
  });
  child.on("error", (err) => {
    exited = { code: null, signal: null, error: err.message };
  });

  const stop = async () => {
    if (!child.pid) return;
    killGroup(child, "SIGTERM");
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && exited === null) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (exited === null) killGroup(child, "SIGKILL");
  };

  const ready = await waitForServer(url, {
    timeoutMs,
    isAlive: () => exited === null,
    log,
  });
  if (!ready.ok) {
    await stop();
    const tail = lines.slice(-OUTPUT_TAIL_LINES);
    const hint = tail.length ? `\nServer output: ${tail.slice(-3).join(" | ")}` : "";
    return {
      ok: false,
      command,
      output: tail,
      error: `${ready.error}${hint}`,
      attempts: ready.attempts,
    };
  }
  log(`The production server is answering at ${ready.url}`);
  return {
    ok: true,
    url: ready.url,
    command,
    pid: child.pid,
    stop,
    output: lines.slice(-OUTPUT_TAIL_LINES),
  };
}
