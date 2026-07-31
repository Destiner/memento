// Shared fixtures for the V2 memory tests.
//
// Two things every memory test needs: a registered project (the operations
// existence-check `scope.project_ids`) and a valid record or create input. Keeping
// them here means a schema change lands in one place rather than in ten files.

import type { MemoryRecord } from '../../src/store/memory-schema.js';
import { createProject } from '../../src/store/project-create.js';

export const PROJECT_A = 'prj_TESTPROJECT0A';
export const PROJECT_B = 'prj_TESTPROJECT0B';

// Names deliberately unalike, so seeding both never trips create_project's
// near-duplicate gate.
const PROJECT_NAMES: Record<string, string> = { [PROJECT_A]: 'Alpha', [PROJECT_B]: 'Beta' };

/** Register the given project ids so memories may be scoped to them. */
export async function seedProjects(
  projectsDir: string,
  ids: readonly string[] = [PROJECT_A, PROJECT_B],
): Promise<void> {
  for (const id of ids) {
    const name = PROJECT_NAMES[id] ?? id;
    await createProject(
      { name, description: `Test project ${name}.` },
      { projectsDir, makeId: () => id },
    );
  }
}

/** A complete, valid persisted record — for driving the index directly. */
export function memoryRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: 'mem_TEST0000',
    title: 'Webhook retries duplicate sends under load',
    description: 'The provider delays webhooks at peak volume, so retries look like duplicates.',
    scope: { kind: 'projects', project_ids: [PROJECT_A] },
    type: 'debugging_pattern',
    provenance: { source: 'agent_observed', verification: 'observed_once' },
    status: 'active',
    created_at: '2026-06-01T00:00:00Z',
    updated_at: '2026-06-01T00:00:00Z',
    ...overrides,
  };
}

/** A valid `create_memory` input. */
export function createInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: 'Webhook retries duplicate sends under load',
    description: 'The provider delays webhooks at peak volume, so retries look like duplicates.',
    scope: { kind: 'projects', project_ids: [PROJECT_A] },
    type: 'debugging_pattern',
    body: 'Preserve idempotency keys; webhook arrival time is not a freshness signal.',
    provenance: { source: 'agent_observed' },
    ...overrides,
  };
}
