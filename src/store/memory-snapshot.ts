import { createHash } from 'node:crypto';

import { orderMemoryMetadata } from './memory-fields.js';
import type { MemoryRecord } from './memory-schema.js';

export function memorySnapshotSha256(record: MemoryRecord, body: string): string {
  return createHash('sha256')
    .update(stableJson({ metadata: orderMemoryMetadata(record), body }))
    .digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}
