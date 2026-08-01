// Config schema + loader (harness-spec §7.1, §10). One meta.yaml per config dir
// (configs/<name>/meta.yaml) declares a concrete, installable combination of knob
// variants: which MEMENTO_VARIANT the server runs and which user-side artifacts
// (CLAUDE.md fragment, settings fragment, hooks, skill dir) the runner installs
// into the hermetic sandbox (§7.2). Baselines are configs too: baseline-0 pins
// MEMENTO_VARIANT=plain with no artifacts (§10); baseline-no-memento leaves
// Memento unregistered (memento_variant: null).
//
// Like the scenario loader, this validates both shape and cross-field consistency
// so a malformed config fails loudly before a run spends budget. Artifact paths
// are relative to the config dir; resolving and existence-checking them is the
// runner's job. The MEMENTO_VARIANT value is validated by the server at startup
// (it throws on an unknown name), so the harness stays decoupled from the variant
// registry.

import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

// Which propensity side a knob acts on (§5.1: read and write scores never merge).
export const CONFIG_SIDES = ['read', 'write', 'both'] as const;
// Portability across harnesses (§6 tie-break; V2 Codex). `partial` = e.g. AGENTS.md.
export const PORTABILITY = ['portable', 'partial', 'non-portable'] as const;

const nonEmpty = z.string().trim().min(1);
const slug = z.string().regex(/^[a-z0-9-]+$/, 'must be a kebab-case slug');

// User-side artifacts installed into the sandbox (§7.2 step 2). All optional: a
// product-shipped knob installs nothing (it rides on memento_variant alone).
const installSchema = z
  .object({
    claude_md: nonEmpty.optional(), // project CLAUDE.md fragment
    agent_instructions: z.literal('memento').optional(), // canonical `memento instructions`
    settings: nonEmpty.optional(), // settings.json fragment (merged into the base)
    hooks: z.array(nonEmpty).optional(), // hook script files
    skill: nonEmpty.optional(), // skill directory
  })
  .strict()
  .superRefine((install, ctx) => {
    if (install.claude_md && install.agent_instructions) {
      ctx.addIssue({
        code: 'custom',
        message: 'claude_md and agent_instructions are mutually exclusive.',
        path: ['agent_instructions'],
      });
    }
  });

export const configSchema = z
  .object({
    name: slug,
    description: nonEmpty.optional(),
    knob: slug, // knob id, or 'none' for baselines
    variant: slug, // knob arm label (off/weak/strong), or 'none' for baselines
    side: z.enum(CONFIG_SIDES),
    portability: z.enum(PORTABILITY),
    // MEMENTO_VARIANT the server runs; null means Memento is not registered at
    // all (baseline-no-memento). The runner passes this through as the env var.
    memento_variant: nonEmpty.nullable(),
    install: installSchema.optional(),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.memento_variant === null) {
      if (c.knob !== 'none')
        ctx.addIssue({
          code: 'custom',
          message: 'a knob config requires Memento registered (set memento_variant)',
          path: ['memento_variant'],
        });
      if (c.install)
        ctx.addIssue({
          code: 'custom',
          message: 'nothing can be installed when Memento is unregistered',
          path: ['install'],
        });
    }
  });

export type Config = z.infer<typeof configSchema>;

/** Parse and validate configs/<name>/meta.yaml, throwing a per-field error on failure. */
export function loadConfig(dir: string): Config {
  const path = join(dir, 'meta.yaml');
  const parsed = parseYaml(readFileSync(path, 'utf8')) as unknown;
  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid config at ${path}:\n${issues}`);
  }
  // The dir name is the config's identity in manifests and the config_hash (§8);
  // a mismatch means a copied dir whose meta wasn't updated — fail rather than
  // silently run the wrong knob.
  const expected = basename(dir);
  if (result.data.name !== expected) {
    throw new Error(
      `Config name "${result.data.name}" does not match its directory "${expected}" (${path}).`,
    );
  }
  return result.data;
}
