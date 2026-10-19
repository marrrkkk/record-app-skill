/**
 * Shared helpers for the skill's test suite.
 *
 * Everything here is deterministic and uses no network beyond loopback. Tests
 * that need a real browser or a real encoder skip with an explicit reason when
 * the dependency is absent, so a missing prerequisite is never reported as a
 * passing test.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SCRIPTS = path.join(SKILL_DIR, "scripts");
export const FIXTURE_SERVER = path.join(SKILL_DIR, "evals", "fixture-app", "server.mjs");

/* ------------------------------------------------------------------ */
/* Temporary directories                                               */
/* ------------------------------------------------------------------ */const TMP_BASE =
  process.env.RECORD_APP_SKILL_TEST_TMP || path.join(os.tmpdir(), "record-app-skill-tests");
const created = [];

/** Create a fresh temporary directory that is removed on process exit. */
export function tmpDir(label = "case") {
  fs.mkdirSync(TMP_BASE, { recursive: true });
  const dir = fs.mkdtempSync(path.join(TMP_BASE, `${label}-`));
  created.push(dir);
  return dir;
}

process.on("exit", () => {
  for (const dir of created) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort cleanup */
    }
  }
});

/* ------------------------------------------------------------------ */
/* CLI invocation                                                      */
/* ------------------------------------------------------------------ */

/**
 * Run a skill script with Node and capture its output.
 *
 * @returns {{code:number, stdout:string, stderr:string, json:any|null}}
 */
export function runScript(script, args = [], { env = {}, timeout = 180000, cwd = SKILL_DIR } = {}) {
  const result = spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], {
    encoding: "utf8",
    timeout,
    cwd,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, ...env },
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  let json = null;
  const trimmed = stdout.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      json = JSON.parse(trimmed);
    } catch {
      json = null;
    }
  }
  return { code: result.status ?? -1, stdout, stderr, json, signal: result.signal ?? null };
}

/* ------------------------------------------------------------------ */
/* Dependency probes                                                   */
/* ------------------------------------------------------------------ */

/** True when the system FFmpeg+FFprobe pair is available. */
export function hasSystemFfmpeg() {
  const { checkFfmpegSync } = probeCache;
  if (checkFfmpegSync !== undefined) return checkFfmpegSync;
  return false;
}

const probeCache = {};

export async function loadFfmpegInfo() {
  if (probeCache.info !== undefined) return probeCache.info;
  const { checkFfmpeg } = await import(path.join(SCRIPTS, "ffmpeg.mjs"));
  const info = checkFfmpeg({ requireMp4: true });
  probeCache.info = info;
  probeCache.checkFfmpegSync = Boolean(info.ok);
  probeCache.ffmpeg = info.ffmpeg ?? null;
  probeCache.ffprobe = info.ffprobe ?? null;
  return info;
}

/** Playwright's bundled encoder, which is the only encoder available offline. */
export async function playwrightFfmpegPath() {
  const { findLocalPlaywrightFfmpeg } = await import(path.join(SCRIPTS, "browser-env.mjs"));
  return findLocalPlaywrightFfmpeg();
}

export async function loadPlaywright() {
  const { resolvePlaywright } = await import(path.join(SCRIPTS, "browser-env.mjs"));
  return resolvePlaywright({ required: false });
}

/* ------------------------------------------------------------------ */
/* Fixture application                                                 */
/* ------------------------------------------------------------------ */

/**
 * Start the bundled fixture app on an ephemeral port.
 *
 * The fixture is a real HTTP server with routes, a modal, client-side
 * validation, a protected route and a deliberately failing route — it is the
 * same app the eval scenarios run against.
 */
export async function startFixture() {
  const child = spawn(process.execPath, [FIXTURE_SERVER, "--port", "0"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });
  const baseUrl = await new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("fixture app did not start within 15s")), 15000);
    child.stdout.on("data", (chunk) => {
      buffer += String(chunk);
      const match = /listening on (http:\/\/[^\s]+)/.exec(buffer);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`fixture app exited early with code ${code}`));
    });
  });

  let stderrBuffer = "";
  child.stderr.on("data", (chunk) => {
    stderrBuffer += String(chunk);
  });

  // A failing fetch is almost always the fixture process dying; say so, with
  // whatever it printed, instead of leaving a bare "fetch failed".
  const withContext = async (label, fn) => {
    try {
      return await fn();
    } catch (err) {
      const detail = stderrBuffer.trim();
      throw new Error(
        `fixture ${label} failed: ${err?.cause?.message ?? err?.message ?? String(err)}` +
          `${detail ? `\n--- fixture stderr ---\n${detail}` : ""}`,
        { cause: err }
      );
    }
  };

  /**
   * Every request opens its own connection.
   *
   * The tests call `spawnSync` between requests, which blocks the event loop.
   * A pooled keep-alive socket that the fixture closes in the meantime (Node's
   * server times idle connections out after 5s) would then be reused blindly,
   * and the next request would fail with "other side closed". Closing every
   * connection removes that coupling entirely.
   */
  const noKeepAlive = { connection: "close" };

  return {
    baseUrl,
    port: Number(new URL(baseUrl).port),
    stderr: () => stderrBuffer,
    async reset() {
      await withContext("reset", async () => {
        const res = await fetch(new URL("/__reset", baseUrl), { method: "POST", headers: noKeepAlive });
        await res.text();
      });
    },
    async state() {
      return withContext("state", async () => {
        const res = await fetch(new URL("/__state", baseUrl), { headers: noKeepAlive });
        return res.json();
      });
    },
    /** Create a project through the app's own form endpoint. */
    async createProject({ name, owner = "Ada Lovelace", priority = "High", description = "" }) {
      return withContext("createProject", async () => {
        const res = await fetch(new URL("/projects", baseUrl), {
          method: "POST",
          body: new URLSearchParams({ name, owner, priority, description }),
          redirect: "manual",
          headers: { "content-type": "application/x-www-form-urlencoded", ...noKeepAlive },
        });
        const location = res.headers.get("location") ?? "";
        // `redirect: "manual"` means nothing read this body yet; draining it
        // keeps the connection reusable.
        await res.text();
        const id = location.split("/").filter(Boolean).pop();
        if (!id) throw new Error(`fixture did not create a project (status ${res.status})`);
        return { id, location };
      });
    },
    async stop() {
      await new Promise((resolve) => {
        child.once("exit", resolve);
        child.kill("SIGTERM");
        setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 3000).unref();
      });
    },
  };
}

/* ------------------------------------------------------------------ */
/* Plans                                                              */
/* ------------------------------------------------------------------ */

/**
 * A minimal valid plan. Tests override only the parts they exercise, so a
 * change to the defaults shows up once rather than in every test.
 */
export function basePlan(baseUrl, overrides = {}) {
  return {
    schemaVersion: 1,
    title: "Test workflow",
    baseUrl,
    startRoute: "/",
    steps: [{ id: "look", action: "waitFor", target: { strategy: "css", selector: "body" } }],
    ...overrides,
  };
}

export function writePlan(dir, plan, name = "plan.json") {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `${JSON.stringify(plan, null, 2)}\n`);
  return file;
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function exists(file) {
  return fs.existsSync(file);
}

/** Total size in bytes of the files in a directory (non-recursive). */
export function dirSize(dir) {
  return fs
    .readdirSync(dir)
    .map((name) => {
      const stat = fs.statSync(path.join(dir, name));
      return stat.isFile() ? stat.size : 0;
    })
    .reduce((a, b) => a + b, 0);
}

/** `page.screencast` needs Playwright's own ffmpeg build to mux the file. */
export async function screencastAvailable() {
  return Boolean(await playwrightFfmpegPath());
}

/**
 * A loopback port that is guaranteed not to be listening.
 *
 * Used by the "missing application" scenario: binding and releasing a port
 * proves nobody is on it, which a hard-coded port number cannot.
 */
export async function closedPort() {
  const net = await import("node:net");
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}
