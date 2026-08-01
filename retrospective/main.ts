import { runCli } from './cli.js';

try {
  await runCli(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`retrospective: ${message}\n`);
  process.exitCode = 1;
}
