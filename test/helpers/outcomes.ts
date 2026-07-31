// Narrowing helpers for the operations that return an outcome union.
//
// `create_project` and `create_memory` can answer "here are the neighbours I
// found instead" (v2.md §5), so their results are discriminated unions. A test
// that means to assert on a successful write says so once, here, rather than
// carrying an `if (result.outcome !== 'created') return` that would silently pass
// if the gate ever fired unexpectedly.

import type { CreateMemoryResult } from '../../src/store/memory-create.js';
import type { CreateProjectResult } from '../../src/store/project-create.js';

type Created<T extends { outcome: string }> = Extract<T, { outcome: 'created' }>;
type Gated<T extends { outcome: string }> = Extract<T, { outcome: 'duplicate_candidates' }>;

export function createdProject(result: CreateProjectResult): Created<CreateProjectResult> {
  if (result.outcome !== 'created') {
    throw new Error(
      `expected a created project, got ${result.outcome} with ${result.candidates.length} candidate(s)`,
    );
  }
  return result;
}

export function gatedProject(result: CreateProjectResult): Gated<CreateProjectResult> {
  if (result.outcome !== 'duplicate_candidates') {
    throw new Error(`expected the duplicate gate to fire, got ${result.outcome}`);
  }
  return result;
}

export function createdMemory(result: CreateMemoryResult): Created<CreateMemoryResult> {
  if (result.outcome !== 'created') {
    throw new Error(
      `expected a created memory, got ${result.outcome} with ${result.candidates.length} candidate(s)`,
    );
  }
  return result;
}

export function gatedMemory(result: CreateMemoryResult): Gated<CreateMemoryResult> {
  if (result.outcome !== 'duplicate_candidates') {
    throw new Error(`expected the duplicate gate to fire, got ${result.outcome}`);
  }
  return result;
}
