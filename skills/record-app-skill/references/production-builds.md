# Production builds

A demo recorded against a development server is a demo of the development
server. Hot-reload machinery, unminified bundles, source maps, dev-only
warnings and a debugger connection all run while the browser is on screen, and
every one of them shows up in the video as lag, jank and a UI that does not
match what the user gets.

So the skill can record against the application **the way it ships**: build
it, serve the built output, and only start capturing once that server
answers.

```bash
node scripts/run-demo.mjs --plan plan.json --production
```

## What `--production` does

1. Finds the application (the plan's directory, or `--app-root`).
2. Runs its production build script.
3. Starts the script that serves the built output.
4. Waits until that server answers on the URL.
5. Records against it, then stops the server.

The recording never starts against a half-started server, and the server is
always stopped again — including when the recording fails.

## Which scripts are used

| Purpose | Looked for, in order | Falls back to |
| --- | --- | --- |
| build | `build`, `build:prod`, `build:production`, `compile` | — (a build is required) |
| serve | `preview`, `serve`, `start` | — (a server is required) |

The project's own package manager is used (`npm`, `pnpm`, `yarn` or `bun`),
decided by the lockfile, so the tree that is built is the tree the developer
ships.

A plan may name the scripts explicitly, which is better when the project has
several:

```json
{
  "app": {
    "mode": "production",
    "root": "/home/ada/projects/storefront",
    "build": "build",
    "serve": "preview",
    "url": "http://127.0.0.1:4173"
  }
}
```

A plan may only *name* scripts that exist in the application's `package.json`.
A typo is an error that lists the available scripts, not a mystery build
failure. Shell commands are not allowed in a plan — a plan is data, and data
does not become a shell. A command line may carry one, behind an explicit
prefix:

```bash
--build "sh:npx vite build --mode production" --serve "sh:npx vite preview --port 4173"
```

## The port

The recording uses `--serve-url` (default: the plan's `baseUrl`). The port in
that URL is passed to the server when the framework is one the skill knows how
to configure:

| Server script | Passed |
| --- | --- |
| `vite preview` | `--port <n> --strictPort --host 127.0.0.1` |
| `next start` | `-p <n>` |
| `ng serve` | `--port <n>` |
| `serve` | `-l <n>` |
| `http-server` | `--port <n>` |
| `react-scripts start` | `PORT=<n>` in the environment |

An unrecognised server gets no arguments rather than the wrong ones. When the
server then listens somewhere else, the readiness probe says so and the run
fails with the server's own output — it never records the wrong address.

## Recording against a running application

`--production` is optional. Without it the skill records against whatever is
already serving `baseUrl`, which is right for a staging environment or an
application someone else started.

The difference is recorded in the manifest (`app.mode`) and printed in the
handoff block, so a viewer of the evidence can tell which one produced a
video.

## Windows and WSL

The build and the server run on the side where the source lives — inside WSL
for a project in WSL. The Windows browser reaches the server over the WSL
loopback, exactly as it reaches a development server today. If Windows cannot
reach it, the Windows worker says so before recording instead of capturing a
connection error.

## When it fails

| Message | Meaning | Do |
| --- | --- | --- |
| `no production build script was found` | the project has no `build` script | name the script in the plan, or pass `--build` |
| `the production build failed` | the build itself failed | read `build.log` in the run directory |
| `the production server did not start` | the server exited or never answered | read `server.log` in the run directory |
| `did not answer within 60s` | the server is on another port or host | pass `--serve-url` with the address it really uses |

`build.log` and `server.log` are written into the run directory next to the
recording, so a failure is diagnosable without re-running anything.
