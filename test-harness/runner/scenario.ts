// Scenario definition schema + loader (harness-spec §4.5). One scenario.yaml per
// directory declares the fixture, task, seeded corpus, an optional overlay, and
// checks. The loader parses and validates both shape and class-consistency, so a
// malformed or mis-calibrated scenario (e.g. a should-retrieve with no planted
// fact) fails loudly before a run spends budget on it. Path fields are relative
// to the test-harness root; resolving and existence-checking them is the runner's
// job.

import { readFileSync } from 'node:fs';

import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

export const SCENARIO_CLASSES = [
  'should-retrieve',
  'should-not-retrieve',
  'should-capture',
  'should-not-capture',
] as const;

const nonEmpty = z.string().trim().min(1);

const checksSchema = z
  .object({
    utility_regex: nonEmpty.optional(),
    utility_anti_regex: nonEmpty.optional(),
    task_success: nonEmpty.optional(),
  })
  .strict();

export const scenarioSchema = z
  .object({
    id: z.string().regex(/^[a-z-]+\/[a-z0-9-]+$/, 'id must look like "<group>/<name>"'),
    version: z.number().int().min(1),
    class: z.enum(SCENARIO_CLASSES),
    fixture: nonEmpty,
    overlay: nonEmpty.optional(), // dir copied on top of the fixture to stage this scenario (§4.3)
    task: nonEmpty,
    corpus: nonEmpty,
    seeded_memory: nonEmpty.optional(),
    checks: checksSchema,
    capture_rubric: z.unknown().nullable().optional(),
  })
  .strict()
  .superRefine((s, ctx) => {
    if (s.class === 'should-retrieve') {
      if (!s.seeded_memory)
        ctx.addIssue({
          code: 'custom',
          message: 'should-retrieve requires seeded_memory',
          path: ['seeded_memory'],
        });
      if (!s.checks.utility_regex)
        ctx.addIssue({
          code: 'custom',
          message: 'should-retrieve requires checks.utility_regex',
          path: ['checks', 'utility_regex'],
        });
    }
    if (s.class === 'should-not-retrieve' && s.seeded_memory)
      ctx.addIssue({
        code: 'custom',
        message: 'should-not-retrieve must not seed a memory',
        path: ['seeded_memory'],
      });
    if (s.class === 'should-capture' && s.capture_rubric == null)
      ctx.addIssue({
        code: 'custom',
        message: 'should-capture requires a capture_rubric',
        path: ['capture_rubric'],
      });
    if (s.class === 'should-not-capture' && s.capture_rubric != null)
      ctx.addIssue({
        code: 'custom',
        message: 'should-not-capture must not define a capture_rubric',
        path: ['capture_rubric'],
      });
  });

export type Scenario = z.infer<typeof scenarioSchema>;

/** Parse and validate a scenario.yaml, throwing a per-field error on failure. */
export function loadScenario(path: string): Scenario {
  const parsed = parseYaml(readFileSync(path, 'utf8')) as unknown;
  const result = scenarioSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid scenario at ${path}:\n${issues}`);
  }
  return result.data;
}
