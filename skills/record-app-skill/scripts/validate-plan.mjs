#!/usr/bin/env node
/**
 * Validate a workflow plan without touching a browser.
 *
 * Usage:
 *   node validate-plan.mjs --plan workflow.json [--json] [--show-normalized]
 *
 * Exit codes: 0 valid · 2 invalid plan
 */

import path from "node:path";
import { EXIT, validatePlan, readJsonFile, redactSecrets, describeSelector } from "./lib.mjs";

function parseArgs(argv) {
  const args = { plan: null, json: false, showNormalized: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--plan": args.plan = argv[++i]; break;
      case "--json": args.json = true; break;
      case "--show-normalized": args.showNormalized = true; break;
      case "-h":
      case "--help":
        args.help = true;
        break;
      default:
        throw new Error(`unknown option: ${argv[i]}`);
    }
  }
  return args;
}

const HELP = `Validate a workflow plan.

  node validate-plan.mjs --plan <workflow.json> [--json] [--show-normalized]

  --plan <file>        workflow plan to validate
  --json               machine-readable result
  --show-normalized    print the plan with defaults applied

Exit codes: 0 valid · 2 invalid plan
`;

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n\n${HELP}`);
    process.exit(EXIT.INVALID_PLAN);
  }
  if (args.help) {
    process.stdout.write(HELP);
    process.exit(EXIT.OK);
  }
  if (!args.plan) {
    process.stderr.write(`--plan is required\n\n${HELP}`);
    process.exit(EXIT.INVALID_PLAN);
  }

  let input;
  try {
    input = readJsonFile(path.resolve(args.plan));
  } catch (err) {
    const message = `could not read plan: ${err.message}`;
    if (args.json) process.stdout.write(JSON.stringify({ ok: false, errors: [message], warnings: [] }, null, 2) + "\n");
    else process.stderr.write(`${message}\n`);
    process.exit(EXIT.INVALID_PLAN);
  }

  const { errors, warnings, plan, steps } = validatePlan(input);
  const ok = errors.length === 0;

  const report = {
    ok,
    plan: args.plan,
    title: plan?.title ?? null,
    baseUrl: plan?.baseUrl ?? null,
    backend: plan?.browser?.backend ?? null,
    stepCount: steps.length,
    stepActions: steps.map((s) => s.action),
    // The resolved id and selector for each step make the plan reviewable
    // without re-reading the source file. Fill values are deliberately omitted:
    // the report is safe to paste into a conversation.
    steps: steps.map((s) => ({
      id: s.id,
      action: s.action,
      target: s.target ? describeSelector(s.target) : null,
      assertOn: s.assertOn ? describeSelector(s.assertOn) : null,
      optional: s.optional === true || undefined,
      consequential: s.consequential === true || undefined,
    })),
    errors: errors.map(redactSecrets),
    warnings: warnings.map(redactSecrets),
  };
  if (args.showNormalized && plan) report.normalized = plan;

  if (args.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    for (const w of report.warnings) process.stderr.write(`warning: ${w}\n`);
    if (!ok) {
      process.stderr.write(`\n${errors.length} validation error(s) in ${args.plan}:\n`);
      for (const e of report.errors) process.stderr.write(`  - ${e}\n`);
    } else {
      process.stdout.write(
        `Plan is valid: "${report.title}" — ${report.stepCount} step(s), backend ${report.backend}, base ${report.baseUrl}\n`
      );
      for (const s of report.steps) {
        process.stdout.write(`  ${s.id.padEnd(18)} ${s.action.padEnd(10)} ${s.target ?? ""}\n`);
      }
      if (args.showNormalized) process.stdout.write(JSON.stringify(plan, null, 2) + "\n");
    }
  }

  process.exit(ok ? EXIT.OK : EXIT.INVALID_PLAN);
}

main().catch((err) => {
  process.stderr.write(`internal error: ${redactSecrets(err?.stack ?? String(err))}\n`);
  process.exit(EXIT.INTERNAL);
});
