import { validateMigrationSnapshot, type MigrationSnapshot } from '../snapshot.js';
import { approvedOrigin, MAX_PLAINTEXT_BYTES } from './envelope.js';

export type Snapshot = MigrationSnapshot;

export function parseSnapshot(bytes: Uint8Array<ArrayBuffer>, origin: string): Snapshot {
  approvedOrigin(origin);
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_PLAINTEXT_BYTES) {
    throw new Error('Migration snapshot exceeds byte capacity.');
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    throw new Error('Invalid migration snapshot encoding.');
  }
  return validateMigrationSnapshot(value, origin);
}
