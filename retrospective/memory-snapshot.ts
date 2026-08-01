import type { MemoryDetail } from '../src/store/memory-schema.js';
import { memorySnapshotSha256 } from '../src/store/memory-snapshot.js';

export interface TargetMemorySnapshot {
  memoryId: string;
  sha256: string;
}

export function targetMemorySnapshot(memory: MemoryDetail): TargetMemorySnapshot {
  return {
    memoryId: memory.id,
    sha256: memorySnapshotSha256(memory, memory.body),
  };
}
