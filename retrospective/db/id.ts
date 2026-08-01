import { createHash } from 'node:crypto';

import type { JsonValue } from '../model.js';

export function stableJson(value: JsonValue): string {
  return JSON.stringify(sortValue(value));
}

export function stableId(prefix: string, ...parts: JsonValue[]): string {
  const hash = createHash('sha256');
  for (const part of parts) {
    hash.update(stableJson(part));
    hash.update('\0');
  }
  return `${prefix}_${hash.digest('hex').slice(0, 24)}`;
}

function sortValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortValue(entry)]),
    );
  }
  return value;
}
