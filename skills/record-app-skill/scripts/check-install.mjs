#!/usr/bin/env node
/**
 * Check that this directory is a complete, self-contained installation of the
 * `record-app-skill` skill.
 *
 * The skill is distributed as a directory: SKILL.md, the scripts it drives,
 * the references it links to, the assets it starts from, and the runtime
 * manifest that installs Playwright. A copy that lost one of those still
 * "loads" in an agent — and then fails halfway through a recording. This
 * script answers the question before the browser is opened:
 *
 *   Is this copy complete, correctly named, and free of paths that only
 *   existed on the machine it was built on?
 *
 * Usage:
 *   node scripts/check-install.mjs            # human-readable report
 *   node scripts/check-install.mjs --json     # machine-readable
 *
 * Exit codes: 0 everything is present and consistent, 1 something is missing.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SKILL_NAME = "record-app-skill";

/** Files the skill cannot work without. */
const REQUIRED_FILES = [
  "SKILL.md",
  "package.json",
  "package-lock.json",
  "assets/templates/workflow.example.json",
  "assets/cursor/cursor-style.json",
  "scripts/lib.mjs",
  "scripts/runner.mjs",
  "scripts/capture.mjs",
  "scripts/browser-env.mjs",
  "scripts/host-env.mjs",
  "scripts/app-server.mjs",
  "scripts/win-exec.mjs",
  "scripts/win/worker.mjs",
  "scripts/win/setup-runtime.mjs",
  "scripts/media-probe.mjs",
  "scripts/ffmpeg.mjs",
  "scripts/output.mjs",
  "scripts/render-video.mjs",
  "scripts/build-contact-sheet.mjs",
  "scripts/validate-video.mjs",
  "scripts/validate-plan.mjs",
  "scripts/record-workflow.mjs",
  "scripts/run-demo.mjs",
  "scripts/setup-check.mjs",
  "scripts/env-detect.mjs",
  "references/workflow-plans.md",
  "references/browser-backends.md",
  "references/production-builds.md",
  "references/video-quality.md",
  "references/authentication-and-safety.md",
  "references/output-artifacts.md",
  "references/context-discipline.md",
];

/** Directories that must travel with the skill. */
const REQUIRED_DIRS = ["scripts", "references", "assets"];

/**
 * Path prefixes that only ever exist on a developer's machine. A packaged
 * copy that mentions one of them is broken on every other computer.
 */
const MACHINE_PATH_PATTERNS = [
  { pattern: /\/home\/[^\s"'`)]+\/node_modules/, hint: "a Linux home directory" },
  { pattern: /\/Users\/[^\s"'`)]+\/node_modules/, hint: "a macOS home directory" },
  { pattern: /C:\\Users\\[^\s"'`)]+\\node_modules/, hint: "a Windows home directory" },
  { pattern: /\/tmp\/opencode\//, hint: "a local scratch directory" },
];

/** Read a file as UTF-8, or return null when it cannot be read. */
function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** Every file under a directory, relative to the skill, as forward-slash paths. */
function walk(dir, base = SKILL_DIR, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      walk(full, base, out);
    } else if (entry.isFile()) {
      out.push(path.relative(base, full).split(path.sep).join("/"));
    }
  }
  return out;
}

/** The YAML frontmatter of SKILL.md, as raw text. */
function frontmatter(skillMd) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skillMd);
  return match ? match[1] : "";
}

/** Paths referenced by SKILL.md: markdown links and inline script paths. */
function referencedPaths(skillMd) {
  const refs = new Set();
  for (const m of skillMd.matchAll(/\]\(([^)]+)\)/g)) {
    const target = m[1].split("#")[0].trim();
    if (!target || /^[a-z]+:\/\//i.test(target)) continue;
    refs.add(target);
  }
  for (const m of skillMd.matchAll(/\b((?:scripts|references|assets|evals)\/[A-Za-z0-9._\/-]+)/g)) {
    refs.add(m[1]);
  }
  return [...refs].sort();
}

/**
 * Run every check.
 *
 * @returns {{ok: boolean, problems: string[], notes: string[], files: number}}
 */
export function checkInstall({ dir = SKILL_DIR } = {}) {
  const problems = [];
  const notes = [];

  const skillMdPath = path.join(dir, "SKILL.md");
  const skillMd = readText(skillMdPath);
  if (skillMd === null) {
    problems.push("SKILL.md is missing — this directory is not an installed skill.");
    return { ok: false, problems, notes, files: 0 };
  }

  // 1. The frontmatter the specification requires, and a name that matches
  //    the directory the skill was installed into.
  const fm = frontmatter(skillMd);
  const name = /^name:\s*(.+?)\s*$/m.exec(fm)?.[1] ?? "";
  const description = /^description:\s*(.+)$/m.exec(fm)?.[1] ?? "";
  const dirName = path.basename(dir);
  if (name !== SKILL_NAME) {
    problems.push(`the frontmatter name is "${name || "(missing)"}" but it must be "${SKILL_NAME}".`);
  }
  if (dirName !== SKILL_NAME) {
    problems.push(`the directory is called "${dirName}" but the skill is "${SKILL_NAME}".`);
  }
  if (!description) problems.push("the frontmatter has no description.");
  else if (description.length > 1024) {
    problems.push(`the description is ${description.length} characters; the specification allows 1024.`);
  }
  if (!/^---\r?\n/.test(skillMd)) problems.push("SKILL.md does not start with YAML frontmatter.");

  // 2. Every required file and directory.
  for (const rel of REQUIRED_FILES) {
    if (!fs.existsSync(path.join(dir, rel))) {
      problems.push(`missing ${rel} — reinstall the skill; the copy is incomplete.`);
    }
  }
  for (const rel of REQUIRED_DIRS) {
    if (!fs.existsSync(path.join(dir, rel))) {
      problems.push(`missing directory ${rel}/ — reinstall the skill; the copy is incomplete.`);
    }
  }

  // 3. Everything SKILL.md points at has to be there.
  for (const ref of referencedPaths(skillMd)) {
    if (!fs.existsSync(path.join(dir, ref))) {
      problems.push(`SKILL.md links to "${ref}", which is not in this installation.`);
    }
  }

  // 4. Nothing may depend on a path that only existed on the build machine.
  const files = walk(dir);
  for (const rel of files) {
    if (!/\.(mjs|js|json|md|txt|yml|yaml)$/i.test(rel)) continue;
    const text = readText(path.join(dir, rel));
    if (text === null) continue;
    for (const { pattern, hint } of MACHINE_PATH_PATTERNS) {
      if (pattern.test(text)) {
        problems.push(`${rel} contains ${hint} — an absolute path from another machine.`);
      }
    }
  }

  // 5. The runtime manifest must be installable on its own.
  const pkg = readText(path.join(dir, "package.json"));
  if (pkg !== null) {
    try {
      const parsed = JSON.parse(pkg);
      if (!parsed.dependencies?.playwright) {
        problems.push("package.json does not declare the playwright dependency.");
      }
    } catch (err) {
      problems.push(`package.json is not valid JSON: ${err.message}`);
    }
  }

  if (!fs.existsSync(path.join(dir, "node_modules", "playwright"))) {
    notes.push(
      "Playwright is not installed here yet — run `npm install` in this directory, " +
        "then `npx playwright install chromium`, then `node scripts/setup-check.mjs`."
    );
  }

  return { ok: problems.length === 0, problems, notes, files: files.length };
}

/* ------------------------------------------------------------------ */
/* Command line                                                        */
/* ------------------------------------------------------------------ */

function main(argv) {
  const asJson = argv.includes("--json");
  const result = checkInstall();

  if (asJson) {
    process.stdout.write(`${JSON.stringify({ ok: result.ok, problems: result.problems, notes: result.notes }, null, 2)}\n`);
    return result.ok ? 0 : 1;
  }

  if (result.ok) {
    process.stdout.write(
      `${SKILL_NAME} installation looks complete (${result.files} files).\n`
    );
  } else {
    process.stdout.write(`${SKILL_NAME} installation is incomplete:\n`);
    for (const problem of result.problems) process.stdout.write(`  - ${problem}\n`);
  }
  for (const note of result.notes) process.stdout.write(`  note: ${note}\n`);
  if (!result.ok) {
    process.stdout.write(
      `Reinstall with: npx skills add marrrkkk/record-app-skill --skill ${SKILL_NAME}\n`
    );
  }
  return result.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}
