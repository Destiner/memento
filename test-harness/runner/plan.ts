// Run planning (harness-spec §8.1 → §7.2). Turns a validated manifest into the
// concrete list of (config × scenario × rep) cells the runner executes: resolves
// each config name to its dir, expands the scenario globs against the scenarios/
// tree, and enumerates reps. Resolution fails loud — an unknown config or a glob
// that matches nothing throws rather than silently shrinking the run, which is
// the kind of quiet invalidation §7.2 warns about.
//
// Config and scenario file paths stay relative to their own locations; the
// lifecycle derives each config dir (configs/<name>) and scenario dir
// (scenarios/<id>) from the name/id, both of which the loaders pin to the
// directory, so a resolved Config/Scenario is enough to locate its artifacts.

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { loadConfig, type Config } from './config.js';
import { type Manifest } from './manifest.js';
import { loadScenario, type Scenario } from './scenario.js';

/** One unit of work: a config run against a scenario for a given rep (1-indexed). */
export interface Cell {
  config: Config;
  scenario: Scenario;
  rep: number;
}

export interface RunPlan {
  configs: Config[];
  scenarios: Scenario[];
  cells: Cell[];
}

// Segment-wise glob: "*" matches a whole path segment. Supports "read/*" and
// exact ids ("read/email-provider"); deliberately not partial ("read/em*"), so a
// glob can't broaden by accident.
function globMatches(glob: string, id: string): boolean {
  const g = glob.split('/');
  const i = id.split('/');
  if (g.length !== i.length) return false;
  return g.every((seg, k) => seg === '*' || seg === i[k]);
}

/** Discover every scenario id (<group>/<name>) that has a scenario.yaml. */
function discoverScenarioIds(scenariosDir: string): string[] {
  const ids: string[] = [];
  for (const group of readdirSync(scenariosDir, { withFileTypes: true })) {
    if (!group.isDirectory()) continue;
    const groupDir = join(scenariosDir, group.name);
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(groupDir, entry.name, 'scenario.yaml'))) {
        ids.push(`${group.name}/${entry.name}`);
      }
    }
  }
  return ids.sort();
}

/** Resolve config names (dedup, preserve first occurrence) to loaded configs. */
export function resolveConfigs(harnessRoot: string, names: string[]): Config[] {
  const configsDir = join(harnessRoot, 'configs');
  const seen = new Set<string>();
  const configs: Config[] = [];
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    const dir = join(configsDir, name);
    if (!existsSync(join(dir, 'meta.yaml'))) {
      throw new Error(`Manifest config "${name}" has no configs/${name}/meta.yaml.`);
    }
    configs.push(loadConfig(dir));
  }
  return configs;
}

/** Expand scenario globs into loaded scenarios, deduped and sorted by id. */
export function resolveScenarios(harnessRoot: string, globs: string[]): Scenario[] {
  const scenariosDir = join(harnessRoot, 'scenarios');
  const available = discoverScenarioIds(scenariosDir);
  const selected = new Map<string, Scenario>();
  for (const glob of globs) {
    const matches = available.filter((id) => globMatches(glob, id));
    if (matches.length === 0) {
      throw new Error(`Manifest scenario glob "${glob}" matched no scenarios under scenarios/.`);
    }
    for (const id of matches) {
      if (selected.has(id)) continue;
      const scenario = loadScenario(join(scenariosDir, id, 'scenario.yaml'));
      // The scenario's declared id must equal its directory path, mirroring the
      // config name/dir guard — otherwise a glob and a record would disagree.
      if (scenario.id !== id) {
        throw new Error(
          `Scenario at scenarios/${id}/scenario.yaml declares id "${scenario.id}"; expected "${id}".`,
        );
      }
      selected.set(id, scenario);
    }
  }
  return [...selected.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Resolve a manifest's configs and scenarios and enumerate the run's cells.
 * Enumeration order is config-major, then scenario, then rep; the scheduler may
 * reorder for concurrency but the set of cells is fixed here.
 */
export function planRun(harnessRoot: string, manifest: Manifest): RunPlan {
  const configs = resolveConfigs(harnessRoot, manifest.configs);
  // Portability gate (§3.2): non-claude-code harnesses have no hooks, skills, or
  // settings fragments. Fail at plan time, before any paid session.
  if (manifest.harness !== 'claude-code') {
    for (const config of configs) {
      if (config.install?.hooks?.length || config.install?.skill || config.install?.settings) {
        throw new Error(
          `Config "${config.name}" installs hooks/skill/settings, which "${manifest.harness}" ` +
            'does not support — drop it from this manifest or run it under claude-code.',
        );
      }
    }
  }
  const scenarios = resolveScenarios(harnessRoot, manifest.scenarios);
  const cells: Cell[] = [];
  for (const config of configs) {
    for (const scenario of scenarios) {
      for (let rep = 1; rep <= manifest.reps; rep++) {
        cells.push({ config, scenario, rep });
      }
    }
  }
  return { configs, scenarios, cells };
}
