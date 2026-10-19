/**
 * Tests for the production build and preview server.
 *
 * The behaviour these cover is what makes a demo smooth: the application is
 * built the way it ships, the built output is served, and the recording only
 * starts once that server actually answers.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  detectPackageManager,
  listScripts,
  portOf,
  resolveAppConfig,
  runProductionBuild,
  serveInvocationFor,
  startPreviewServer,
} from "../scripts/app-server.mjs";
import { probeUrl } from "../scripts/browser-env.mjs";
import { tmpDir } from "./helpers.mjs";

/** Write a package.json with the given scripts. */
function writeApp(dir, scripts, extra = {}) {
  fs.writeFileSync(
    path.join(dir, "package.json"),
    `${JSON.stringify({ name: "demo-app", version: "1.0.0", scripts, ...extra }, null, 2)}\n`
  );
  return dir;
}

test("an app without a build request is left alone", () => {
  const dir = tmpDir("app-idle");
  const config = resolveAppConfig({ plan: { baseUrl: "http://127.0.0.1:4319" }, planDir: dir });
  assert.equal(config.enabled, false);
  assert.equal(config.mode, "existing");
  assert.equal(config.build, null);
  assert.equal(config.serve, null);
});

test("production mode finds the build and preview scripts", () => {
  const dir = writeApp(tmpDir("app-auto"), {
    build: "vite build",
    preview: "vite preview",
    dev: "vite",
  });
  const config = resolveAppConfig({
    plan: { baseUrl: "http://127.0.0.1:4173" },
    planDir: dir,
    cli: { production: true },
  });
  assert.equal(config.enabled, true);
  assert.equal(config.mode, "production");
  assert.equal(config.build.command, "npm run build");
  assert.equal(config.serve.command, "npm run preview -- --port 4173 --strictPort --host 127.0.0.1");
  assert.equal(config.serve.url, "http://127.0.0.1:4173");
});

test("a plan may name the scripts, and a typo is a clear error", () => {
  const dir = writeApp(tmpDir("app-named"), { build: "vite build", preview: "vite preview" });
  const config = resolveAppConfig({
    plan: { baseUrl: "http://127.0.0.1:4173", app: { mode: "production", build: "build", serve: "preview" } },
    planDir: dir,
  });
  assert.equal(config.error, undefined);
  assert.equal(config.build.command, "npm run build");
  assert.equal(config.serve.command, "npm run preview -- --port 4173 --strictPort --host 127.0.0.1");

  const wrong = resolveAppConfig({
    plan: { baseUrl: "http://127.0.0.1:4173", app: { mode: "production", build: "buld" } },
    planDir: dir,
  });
  assert.match(wrong.error, /no npm script named "buld"/);
  assert.match(wrong.error, /available scripts: build, preview/);
});

test("the command line may carry a shell command, but a plan may not", () => {
  const dir = writeApp(tmpDir("app-shell"), { build: "vite build" });
  const config = resolveAppConfig({
    plan: { baseUrl: "http://127.0.0.1:4173" },
    planDir: dir,
    cli: { build: "sh:npx vite build --mode production", serve: "sh:npx vite preview --port 4173" },
  });
  assert.equal(config.error, undefined);
  assert.equal(config.build.command, "npx vite build --mode production");
  assert.equal(config.serve.command, "npx vite preview --port 4173");
});

test("the package manager and the scripts come from the project", () => {
  const dir = writeApp(tmpDir("app-pnpm"), { build: "next build", start: "next start" });
  fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  assert.equal(detectPackageManager(dir), "pnpm");
  assert.deepEqual(Object.keys(listScripts(dir)), ["build", "start"]);
});

test("each known server is pointed at the recorded port", () => {
  assert.deepEqual(serveInvocationFor("vite preview", 4173).args, [
    "--port",
    "4173",
    "--strictPort",
    "--host",
    "127.0.0.1",
  ]);
  assert.deepEqual(serveInvocationFor("next start", 3000).args, ["-p", "3000"]);
  assert.deepEqual(serveInvocationFor("serve -s build", 8080).args, ["-l", "8080"]);
  assert.deepEqual(serveInvocationFor("http-server dist -p 9000", 9000).args, ["--port", "9000"]);
  assert.deepEqual(serveInvocationFor("react-scripts start", 4000).env, { PORT: "4000" });
  // An unknown server gets nothing rather than the wrong flags.
  assert.deepEqual(serveInvocationFor("my-own-server", 4000).args, []);
  assert.deepEqual(serveInvocationFor("my-own-server", 4000).adapter, null);
});

test("the port is read from the URL the recording uses", () => {
  assert.equal(portOf("http://127.0.0.1:4173"), 4173);
  assert.equal(portOf("http://127.0.0.1"), null);
  assert.equal(portOf("not a url"), null);
});

test("a failing build is reported with its output, not swallowed", async () => {
  const dir = tmpDir("app-build-fails");
  const config = resolveAppConfig({
    plan: { baseUrl: "http://127.0.0.1:4173" },
    planDir: dir,
    cli: { build: "sh:echo 'type error: cannot build' && exit 2", serve: "sh:echo served" },
  });
  const build = await runProductionBuild(config);
  assert.equal(build.ok, false);
  assert.match(build.error, /failed with exit code 2/);
  assert.ok(build.output.join("\n").includes("cannot build"));
});

test("a server that never answers fails the run instead of hanging", async () => {
  const dir = tmpDir("app-server-dead");
  const config = resolveAppConfig({
    plan: { baseUrl: "http://127.0.0.1:9" },
    planDir: dir,
    cli: {
      build: "sh:true",
      serve: "sh:echo 'starting' && sleep 30",
      serveUrl: "http://127.0.0.1:9",
    },
  });
  config.serve.timeoutMs = 1500;
  const server = await startPreviewServer(config);
  try {
    assert.equal(server.ok, false);
    assert.match(server.error, /did not answer within/);
  } finally {
    await server.stop?.();
  }
});

test("a server that answers is reported with the URL that worked", async () => {
  const dir = tmpDir("app-server-up");
  const config = resolveAppConfig({
    plan: { baseUrl: "http://127.0.0.1:4173" },
    planDir: dir,
    cli: { build: "sh:true", serve: "sh:node -e \"require('http').createServer((q,s)=>s.end('ok')).listen(4188,'127.0.0.1')\"", serveUrl: "http://127.0.0.1:4188" },
  });
  config.serve.timeoutMs = 15000;
  const server = await startPreviewServer(config);
  try {
    assert.equal(server.ok, true, server.error);
    // The probe may answer on 127.0.0.1 or on localhost — it tries both,
    // because Chromium and the host may disagree about which one answers.
    // What matters is that the reported URL is the one that really answers.
    assert.equal(new URL(server.url).port, "4188");
    const probe = await probeUrl(server.url);
    assert.equal(probe.ok, true, `the reported URL must answer: ${server.url}`);
  } finally {
    // Always stop the server: a failed assertion must not leave a process
    // behind that makes the next run fail for the wrong reason.
    await server.stop?.();
  }
});

test("a port that is already taken is refused, not recorded against", async () => {
  const http = await import("node:http");
  // Something else already answers on this port.
  const squatter = http.createServer((req, res) => res.end("someone else"));
  await new Promise((resolve) => squatter.listen(4190, "127.0.0.1", resolve));

  try {
    const dir = tmpDir("app-server-taken");
    const config = resolveAppConfig({
      plan: { baseUrl: "http://127.0.0.1:4190" },
      planDir: dir,
      cli: {
        build: "sh:true",
        serve: "sh:node -e \"require('http').createServer((q,s)=>s.end('ok')).listen(4190,'127.0.0.1')\"",
        serveUrl: "http://127.0.0.1:4190",
      },
    });
    config.serve.timeoutMs = 10000;
    const server = await startPreviewServer(config);
    assert.equal(server.ok, false, "the run must not record against somebody else's server");
    assert.match(server.error, /another process is probably using that port|the server exited/);
    await server.stop?.();
  } finally {
    // The probe keeps a connection alive, so it has to be closed explicitly.
    squatter.closeAllConnections?.();
    await new Promise((resolve) => squatter.close(resolve));
  }
});
