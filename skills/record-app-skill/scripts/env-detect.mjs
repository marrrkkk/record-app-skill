#!/usr/bin/env node
/**
 * Report the recording environment in one short, structured pass.
 *
 * The point of this script is to stop the agent from discovering the same
 * facts over and over through free-form shell commands. One call answers:
 *
 *   - which operating system will actually draw the frames (not the one the
 *     shell happens to run on),
 *   - which browser is the user's default on that host,
 *   - which backend can be used, and what is missing if none can.
 *
 * Usage:
 *   node env-detect.mjs [--backend auto|native|local-playwright|windows-native] [--json]
 *
 * Exit codes: 0 a backend is available · 4 no backend can be used as requested
 */

import { resolveBackend, detectHostEnvironment, hostLabel } from "./browser-env.mjs";
import { browserName } from "./host-env.mjs";
import { EXIT } from "./lib.mjs";

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

const HELP = `Report the recording environment: the rendering host, the default browser and the backend.

  node env-detect.mjs [--backend auto|native|local-playwright|windows-native] [--json]

Exit codes: 0 a backend is available · 4 none is
`;

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    process.exit(EXIT.OK);
  }

  const host = detectHostEnvironment();
  const backend = resolveBackend(args.backend);

  const report = {
    skill: "record-app-skill",
    checkedAt: new Date().toISOString(),
    host: {
      kind: host.kind,
      label: hostLabel(host),
      // Where the agent runs, and where the pixels come from. Inside WSL these
      // differ, and confusing them is how a demo ends up rendered on the wrong
      // operating system.
      shellPlatform: host.shellPlatform,
      renderPlatform: host.renderPlatform,
      wsl: host.wsl,
      distro: host.distro,
      networking: host.networking,
      desktopSession: host.desktopSession,
    },
    browser: {
      id: backend.browser?.id ?? null,
      name: backend.browser?.name ?? null,
      source: backend.browser?.source ?? null,
      version: backend.browser?.version ?? null,
    },
    defaultBrowser: backend.defaultBrowser?.id ?? null,
    installed: (backend.installed ?? []).map((b) => b.id),
    backend: {
      requested: backend.requested,
      resolved: backend.backend,
      strategy: backend.strategy,
      channel: backend.channel,
      reason: backend.reason,
      available: !backend.unavailable,
    },
    warnings: backend.warnings ?? [],
    requirements: backend.requirements ?? [],
    alternatives: backend.alternatives ?? [],
  };

  if (args.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    const mark = report.backend.available ? "ok  " : "MISS";
    process.stdout.write(`\nrecord-app-skill environment\n`);
    process.stdout.write(`  host        : ${report.host.label}\n`);
    process.stdout.write(
      `  rendering   : ${report.host.renderPlatform}` +
        `${report.host.shellPlatform !== report.host.renderPlatform ? ` (agent runs on ${report.host.shellPlatform})` : ""}\n`
    );
    if (report.host.networking) process.stdout.write(`  networking  : ${report.host.networking}\n`);
    process.stdout.write(
      `  browser     : ${report.browser.name ?? "none detected"}` +
        `${report.browser.source ? ` [${report.browser.source}]` : ""}` +
        `${report.browser.version ? ` ${report.browser.version}` : ""}\n`
    );
    process.stdout.write(`  installed   : ${report.installed.length ? report.installed.join(", ") : "none"}\n`);
    process.stdout.write(`  [${mark}] backend   : ${report.backend.resolved} — ${report.backend.reason}\n`);
    for (const warning of report.warnings) process.stdout.write(`         → ${warning}\n`);
    for (const requirement of report.requirements) process.stdout.write(`         → needs: ${requirement}\n`);
    for (const alternative of report.alternatives) process.stdout.write(`         → or: ${alternative}\n`);
    process.stdout.write(
      report.backend.available
        ? `\nRecord with: node scripts/run-demo.mjs --plan plan.json --backend ${report.backend.resolved}\n`
        : `\nNo backend is available as requested. Fix the items above, or pick an alternative.\n`
    );
  }

  process.exit(report.backend.available ? EXIT.OK : EXIT.MISSING_DEPENDENCY);
}

try {
  main();
} catch (err) {
  process.stderr.write(`${err?.message ?? err}\n`);
  process.exit(EXIT.INTERNAL);
}
