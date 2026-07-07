#!/usr/bin/env bun
// Report CLI over results.jsonl (harness-spec §8.2, §11.5).
//
//   bun run harness:report [-- <options>]
//     --results <path>       results log (default: results/results.jsonl)
//     --baseline <name>      config to pair guardrails against (default: baseline-0)
//     --lambda-read <n>      read-side FP weight (default: 0.33)
//     --lambda-write <n>     write-side FP weight (default: 1.0)
//     --no-color             disable dimming (also honored via NO_COLOR / non-TTY)
//
// Scores are recomputed from the log every run (§8.2), so passing a different λ
// re-scores all history without rerunning anything. This file is only I/O and
// argument plumbing; the scoring and rendering live in report.ts.

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  aggregate,
  buildClassMap,
  parseResults,
  renderReport,
  DEFAULT_OPTIONS,
  type ScoreOptions,
} from './report.js';

const HARNESS_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

interface CliArgs {
  results?: string;
  options: ScoreOptions;
  noColor: boolean;
}

function main(argv: string[]): void {
  const args = parseArgs(argv);
  const resultsPath = args.results ?? join(HARNESS_ROOT, 'results', 'results.jsonl');
  if (!existsSync(resultsPath)) {
    console.error(`No results log at ${resultsPath}. Run a manifest first.`);
    return;
  }

  const { records, malformed } = parseResults(readFileSync(resultsPath, 'utf8'));
  if (malformed > 0) console.error(`Skipped ${malformed} malformed line(s) in ${resultsPath}.`);
  if (records.length === 0) {
    console.error(`No records in ${resultsPath}.`);
    return;
  }

  const classMap = buildClassMap(
    HARNESS_ROOT,
    records.map((r) => r.scenario),
  );
  const groups = aggregate(records, classMap, args.options);
  const color = process.stdout.isTTY === true && !args.noColor && !process.env.NO_COLOR;
  process.stdout.write(renderReport(groups, args.options, { color }) + '\n');
}

function parseArgs(argv: string[]): CliArgs {
  const options: ScoreOptions = { ...DEFAULT_OPTIONS };
  const args: CliArgs = { options, noColor: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case '--results':
        args.results = expectValue(argv, ++i, flag);
        break;
      case '--baseline':
        options.baseline = expectValue(argv, ++i, flag);
        break;
      case '--lambda-read':
        options.lambdaRead = expectNumber(argv, ++i, flag);
        break;
      case '--lambda-write':
        options.lambdaWrite = expectNumber(argv, ++i, flag);
        break;
      case '--no-color':
        args.noColor = true;
        break;
      default:
        console.error(`Unknown argument: ${flag ?? ''}`);
        process.exit(1);
    }
  }
  return args;
}

function expectValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined) {
    console.error(`${flag} requires a value.`);
    process.exit(1);
  }
  return value;
}

function expectNumber(argv: string[], index: number, flag: string): number {
  const value = Number(expectValue(argv, index, flag));
  if (Number.isNaN(value)) {
    console.error(`${flag} requires a number.`);
    process.exit(1);
  }
  return value;
}

main(process.argv.slice(2));
