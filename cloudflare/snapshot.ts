import { Buffer } from 'node:buffer';
import { z } from 'zod';
import { DEFAULT_CONFIG, MAX_MEMORY_RETENTION_DAYS } from '../src/config.js';
import { parseFrontmatter } from '../src/store/frontmatter.js';
import { MAX_BODY_LENGTH, validateMemoryFrontmatter } from '../src/store/memory-schema.js';
import { validateProjectFrontmatter } from '../src/store/project-schema.js';
import { ACCOUNT_DOCUMENT_LIMITS, type AccountDocument } from './account-store.js';
import { exactKeys, record, validateAuthSnapshot, type AuthSnapshot } from './snapshot-auth.js';
import { MAX_RPC_ESTIMATE_BYTES, MAX_SNAPSHOT_BYTES } from './snapshot-limits.js';

export { MAX_SNAPSHOT_BYTES } from './snapshot-limits.js';
export const MAX_SNAPSHOT_ACCOUNTS = 128;

export type MigrationSnapshot = {
  version: 1;
  origin: string;
  auth: AuthSnapshot;
  accounts: { id: string; documents: AccountDocument[] }[];
};

const positive = z.number().int().positive();
const retention = positive.max(MAX_MEMORY_RETENTION_DAYS);
const configSchema = z.strictObject({
  schema_version: z.literal(1).optional(),
  search_backend: z.literal('fts5').optional(),
  default_result_limit: positive.optional(),
  max_result_limit: positive.optional(),
  logging_enabled: z.boolean().optional(),
  memory_archive_after_days: retention.optional(),
  memory_delete_after_days: retention.optional(),
});

export function validateAccountSnapshot(value: unknown): AccountDocument[] {
  try {
    const { maxDocuments, maxDocumentBytes, maxAccountBytes } = ACCOUNT_DOCUMENT_LIMITS;
    if (!Array.isArray(value) || value.length > maxDocuments) throw new Error();
    let bytes = 0;
    let rpcBytes = 256;
    const paths = new Set<string>();
    const projects = new Set<string>();
    const memories = new Set<string>();
    const references = new Set<string>();
    for (const entry of value as unknown[]) {
      if (!record(entry) || !exactKeys(entry, ['path', 'contents'])) throw new Error();
      const { path, contents } = entry;
      if (
        typeof path !== 'string' ||
        path.length > 265 ||
        paths.has(path) ||
        typeof contents !== 'string' ||
        contents.length > maxDocumentBytes
      )
        throw new Error();
      const size = Buffer.byteLength(contents);
      if (
        size > maxDocumentBytes ||
        (bytes += size) > maxAccountBytes ||
        (rpcBytes += 2 * (path.length + contents.length) + 128) > MAX_RPC_ESTIMATE_BYTES ||
        Buffer.from(contents).toString() !== contents ||
        contents.includes('\0')
      )
        throw new Error();
      paths.add(path);
      if (path === 'config.json') {
        const effective = { ...DEFAULT_CONFIG, ...configSchema.parse(JSON.parse(contents)) };
        if (effective.default_result_limit > effective.max_result_limit) throw new Error();
        continue;
      }
      const [dir, file, extra] = path.split('/');
      if (
        (dir !== 'projects' && dir !== 'memories') ||
        extra !== undefined ||
        !file?.endsWith('.md') ||
        file.startsWith('..') ||
        file.includes('\\') ||
        Array.from(file, (char) => char.charCodeAt(0)).some((code) => code < 32 || code === 127) ||
        Buffer.byteLength(file) > 255 ||
        Buffer.from(file).toString() !== file
      )
        throw new Error();
      const { metadata, body } = parseFrontmatter(contents);
      if (dir === 'projects') {
        const { id } = validateProjectFrontmatter(metadata);
        if (projects.has(id)) throw new Error();
        projects.add(id);
      } else {
        const { id, scope } = validateMemoryFrontmatter(metadata);
        if (memories.has(id) || !body || body.length > MAX_BODY_LENGTH) throw new Error();
        memories.add(id);
        if (scope.kind === 'projects') {
          if (new Set(scope.project_ids).size !== scope.project_ids.length) throw new Error();
          for (const id of scope.project_ids) references.add(id);
        }
      }
    }
    for (const id of references) if (!projects.has(id)) throw new Error();
    return value as AccountDocument[];
  } catch {
    throw new Error('Invalid account snapshot documents.');
  }
}

export function validateMigrationSnapshot(value: unknown, origin: string): MigrationSnapshot {
  if (
    !record(value) ||
    !exactKeys(value, ['version', 'origin', 'auth', 'accounts']) ||
    value.version !== 1 ||
    value.origin !== origin ||
    !Array.isArray(value.accounts) ||
    value.accounts.length > MAX_SNAPSHOT_ACCOUNTS
  )
    throw new Error('Invalid migration envelope.');
  const auth = validateAuthSnapshot(value.auth, origin);
  const users = new Set(auth.user.map(({ id }) => id));
  let bytes = Buffer.byteLength(JSON.stringify({ version: 1, origin, auth, accounts: [] }));
  bytes += Math.max(0, value.accounts.length - 1);
  for (const account of value.accounts as unknown[]) {
    if (
      !record(account) ||
      !exactKeys(account, ['id', 'documents']) ||
      typeof account.id !== 'string' ||
      !users.delete(account.id)
    ) {
      throw new Error('Invalid snapshot account membership.');
    }
    const documents = validateAccountSnapshot(account.documents);
    bytes += Buffer.byteLength(JSON.stringify({ id: account.id, documents: [] }));
    bytes += Math.max(0, documents.length - 1);
    for (const document of documents) {
      bytes += Buffer.byteLength(JSON.stringify(document));
      if (bytes > MAX_SNAPSHOT_BYTES) throw new Error('Migration snapshot exceeds capacity.');
    }
    if (bytes > MAX_SNAPSHOT_BYTES) throw new Error('Migration snapshot exceeds capacity.');
  }
  if (users.size) throw new Error('Missing snapshot accounts.');
  return value as MigrationSnapshot;
}
