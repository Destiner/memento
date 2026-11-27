import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serialize } from 'node:v8';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { afterEach, beforeAll, expect, test } from 'vitest';
import { serializeFrontmatter } from '../../src/store/frontmatter.js';
import { AUTH_COLUMNS, AUTH_TABLES, MAX_AUTH_BYTES, MAX_AUTH_ROWS } from '../snapshot-auth.js';
import { MAX_SNAPSHOT_ACCOUNTS } from '../snapshot.js';
import { MAX_PLAINTEXT_BYTES, MIN_ENVELOPE_BYTES, seal, sha256 } from './envelope.js';
import { parseSnapshot } from './snapshot.js';

const origin = 'https://migration.example.com';
const key = 'migration/0123456789abcdef0123456789abcdef/snapshot.aead';
const prefix = key.slice(0, -'snapshot.aead'.length);
const secret = '0a'.repeat(32);
const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
const documents = [{ path: 'config.json', contents: '{"logging_enabled":false}\n' }];
const now = '2026-01-01T00:00:00.000Z';

function row(table: (typeof AUTH_TABLES)[number], values: Record<string, unknown>) {
  return { ...Object.fromEntries(AUTH_COLUMNS[table].map((column) => [column, null])), ...values };
}

function synthetic() {
  return {
    version: 1,
    origin,
    auth: {
      ...Object.fromEntries(AUTH_TABLES.map((table) => [table, []])),
      user: ids.map((id, i) =>
        row('user', {
          id,
          name: `Synthetic ${i}`,
          email: `fixture${i}@example.com`,
          emailVerified: { integer: '1' },
          createdAt: now,
          updatedAt: now,
        }),
      ),
      oauthResource: [
        row('oauthResource', {
          id: 'synthetic-resource',
          identifier: `${origin}/mcp`,
          name: `${origin}/mcp`,
          dpopBoundAccessTokensRequired: { integer: '0' },
          disabled: { integer: '0' },
          policyVersion: { integer: '1' },
          createdAt: now,
          updatedAt: now,
        }),
      ],
    },
    accounts: ids.map((id) => ({ id, documents })),
  };
}

let operator: string;
let main: string;
let runtime: Miniflare | undefined;

async function bundle(path: string) {
  return (
    await build({
      entryPoints: [fileURLToPath(new URL(path, import.meta.url))],
      bundle: true,
      format: 'esm',
      platform: 'neutral',
      mainFields: ['browser', 'module', 'main'],
      external: ['node:*', 'cloudflare:workers'],
      write: false,
    })
  ).outputFiles[0]!.text;
}

beforeAll(async () => {
  [operator, main] = await Promise.all([bundle('./worker.ts'), bundle('../worker.ts')]);
}, 30_000);
afterEach(async () => {
  await runtime?.dispose();
  runtime = undefined;
});

async function sealFixtureWithCli() {
  const dir = await mkdtemp(join(tmpdir(), 'memento-seal-fixture-'));
  try {
    const source = join(dir, 'snapshot.json');
    const ciphertext = join(dir, 'snapshot.aead');
    const keyFile = join(dir, 'migration.key');
    await writeFile(source, JSON.stringify(synthetic()), { mode: 0o600 });
    const result = execFileSync(
      process.execPath,
      [
        '--import',
        'tsx',
        fileURLToPath(new URL('./seal.ts', import.meta.url)),
        origin,
        key,
        source,
        ciphertext,
        keyFile,
      ],
      { encoding: 'utf8' },
    );
    const envelope = await readFile(ciphertext);
    expect(JSON.parse(result)).toEqual({
      sha256: await sha256(envelope),
      accountsVerified: 2,
      documentsVerified: 2,
    });
    for (const file of [ciphertext, keyFile]) expect((await stat(file)).mode & 0o777).toBe(0o600);
    return { envelope, secret: await readFile(keyFile, 'utf8') };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function start(
  options: {
    artifact?: Awaited<ReturnType<typeof sealFixtureWithCli>>;
    payload?: unknown;
    hash?: string;
    secret?: string;
    sealedKey?: string;
    uploadKey?: string;
    mainOrigin?: string;
    old?: boolean;
  } = {},
) {
  const envelope =
    options.artifact?.envelope ??
    (await seal(new TextEncoder().encode(JSON.stringify(options.payload ?? synthetic())), secret, {
      key: options.sealedKey ?? key,
      origin,
    }));
  const hash = options.hash ?? (await sha256(envelope));
  const when = new Date(Math.floor(Date.now() / 60_000) * 60_000 - (options.old ? 30 * 60_000 : 0));
  const cron = `${when.getUTCMinutes()} ${when.getUTCHours()} ${when.getUTCDate()} ${when.getUTCMonth() + 1} *`;
  const compat = { compatibilityDate: '2026-11-23', compatibilityFlags: ['nodejs_compat'] };
  const manifest = (contents: string) => ({
    mainModule: 'worker.mjs',
    modules: { 'worker.mjs': { type: 'esm' as const, contents } },
  });
  const text = (value: string) => ({ type: 'text' as const, value });
  const binding = (exportName: string) => ({
    type: 'durable-object' as const,
    worker: 'target',
    exportName,
  });
  const shared = {
    MEMENTO_AUTH: binding('AuthObject'),
    MEMENTO_ACCOUNTS: binding('AccountObject'),
  };
  const mf = (runtime = new Miniflare({
    telemetry: { enabled: false },
    unsafeTriggerHandlers: true,
    workers: [
      {
        config: {
          name: 'operator',
          ...compat,
          manifest: manifest(operator),
          env: {
            ...shared,
            STAGING: { type: 'r2', name: 'synthetic-staging' },
            STAGING_KEY: text(key),
            EXPECTED_SHA256: text(hash),
            EXPECTED_ORIGIN: text(origin),
            MIGRATION_KEY: text(options.secret ?? options.artifact?.secret ?? secret),
            SCHEDULED_AT: text(when.toISOString()),
          },
        },
      },
      {
        config: {
          name: 'target',
          ...compat,
          manifest: manifest(main),
          exports: {
            AuthObject: { type: 'durable-object', storage: 'sqlite' },
            AccountObject: { type: 'durable-object', storage: 'sqlite' },
          },
          env: {
            ...shared,
            MEMENTO_PUBLIC_ORIGIN: text(options.mainOrigin ?? origin),
            AUTH_ALLOWED_EMAILS: text('fixture0@example.com,fixture1@example.com'),
            BETTER_AUTH_SECRET: text('synthetic-fixture-secret-for-workerd'),
            GITHUB_CLIENT_ID: text('synthetic-client-id'),
            GITHUB_CLIENT_SECRET: text('synthetic-client-secret'),
          },
        },
      },
    ],
  }));
  const bucket = await mf.getR2Bucket('STAGING', 'operator');
  await bucket.put(options.uploadKey ?? key, envelope);
  const schedule = (time = when.getTime(), expression = cron) =>
    mf.dispatchFetch(
      `http://localhost/cdn-cgi/local/scheduled?${new URLSearchParams({ time: String(time), cron: expression, format: 'json' })}`,
      { headers: { 'MF-Route-Override': 'operator' } },
    );
  const account = async (id: string) => {
    const ns = await mf.getDurableObjectNamespace('MEMENTO_ACCOUNTS', 'operator');
    return ns.get(ns.idFromName(id)) as unknown as {
      importDocuments(input: typeof documents): Promise<true>;
    };
  };
  return {
    mf,
    bucket,
    schedule,
    account,
    auth: async () => {
      const ns = await mf.getDurableObjectNamespace('MEMENTO_AUTH', 'operator');
      return ns.get(ns.idFromName('auth-v1')) as unknown as {
        importSnapshot(input: unknown): Promise<true>;
      };
    },
    when,
    hash,
    claim: () => bucket.head(`${prefix}claim.json`),
    receipt: async () => (await bucket.get(`${prefix}receipt.json`))?.json(),
  };
}

test('scheduled workerd event imports via the real private DOs once, even for concurrent delivery', async () => {
  const { mf, schedule, account, claim, receipt, when, hash } = await start({
    artifact: await sealFixtureWithCli(),
  });
  expect((await schedule(when.getTime() + 60_000)).status).toBe(200);
  expect((await schedule(when.getTime(), '* * * * *')).status).toBe(200);
  expect(await claim()).toBeNull();
  const responses = await Promise.all([schedule(), schedule()]);
  expect(responses.map(({ status }) => status)).toEqual([200, 200]);
  expect(await claim()).not.toBeNull();
  const expected = {
    version: 1,
    sha256: hash,
    scheduledAt: when.toISOString(),
    status: 'verified',
    authVerified: true,
    accountsVerified: 2,
    documentsVerified: 2,
  };
  expect(await receipt()).toMatchObject(expected);
  await schedule();
  expect(await receipt()).toMatchObject(expected);
  for (const id of ids) await expect((await account(id)).importDocuments([])).rejects.toThrow();
  const response = await mf.dispatchFetch('http://localhost/import', { method: 'POST' });
  expect(response.status).toBeGreaterThanOrEqual(400);
}, 30_000);

test('validates raw plaintext capacity and UTF-8 before accepting parsed JSON', () => {
  const bytes = new Uint8Array(MAX_PLAINTEXT_BYTES + 1).fill(32);
  const compact = new TextEncoder().encode(JSON.stringify(synthetic()));
  bytes.set(compact);
  expect(parseSnapshot(bytes.subarray(0, -1), origin)).toEqual(synthetic());
  expect(() => parseSnapshot(bytes, origin)).toThrow('byte capacity');
  expect(() => parseSnapshot(new Uint8Array([0xff]), origin)).toThrow('encoding');
});

test('imports maximum account bytes and a near-limit auth row through the real RPCs', async () => {
  const payload = synthetic();
  const client = row('oauthClient', {
    id: 'synthetic-client',
    clientId: 'synthetic-client',
    redirectUris: '[]',
  }) as Record<string, unknown>;
  const auth = { ...payload.auth, oauthClient: [client] };
  const padded = 'a'.repeat(256 * 1024 - 2) + 'Ā';
  for (const column of AUTH_COLUMNS.oauthClient
    .filter((column) => client[column] === null && column !== 'userId')
    .slice(0, 15)) {
    client[column] = padded;
  }
  const authBytes = Buffer.byteLength(JSON.stringify(auth));
  expect(authBytes).toBeGreaterThan(MAX_AUTH_BYTES - 256 * 1024);
  expect(authBytes).toBeLessThanOrEqual(MAX_AUTH_BYTES);
  const large = Array.from({ length: 32 }, (_, i) => {
    const header = serializeFrontmatter(
      {
        id: `prj_Bound${i}`,
        name: 'Synthetic project',
        description: 'A boundary fixture.',
        created_at: now,
        updated_at: now,
        status: 'active',
      },
      '',
    );
    return { path: `projects/bound${i}.md`, contents: header + padded.slice(header.length) };
  });
  expect(large.reduce((n, { contents }) => n + Buffer.byteLength(contents), 0)).toBe(
    8 * 1024 * 1024,
  );
  expect(serialize([large]).byteLength).toBeLessThan(32 * 1024 * 1024);
  expect(serialize([auth]).byteLength).toBeLessThan(32 * 1024 * 1024);
  payload.accounts[0]!.documents = large;
  const candidate = { ...payload, auth };
  parseSnapshot(new TextEncoder().encode(JSON.stringify(candidate)), origin);
  const { claim, receipt, schedule } = await start({ payload: candidate });
  const response = await schedule();
  expect(await claim(), await response.text()).not.toBeNull();
  expect(await receipt()).toMatchObject({
    status: 'verified',
    accountsVerified: 2,
    documentsVerified: 33,
  });
  expect(response.status).toBe(200);
}, 30_000);

test('accepts 128 accounts and 8,192 auth rows in one synthetic scheduled run', async () => {
  const payload = synthetic();
  const ids = Array.from(
    { length: MAX_SNAPSHOT_ACCOUNTS },
    (_, i) => `aaaaaaaa-aaaa-4aaa-aaaa-${i.toString().padStart(12, '0')}`,
  );
  payload.auth.user = ids.map((id, i) => ({
    ...payload.auth.user[0],
    id,
    email: `boundary${i}@example.com`,
  }));
  payload.accounts = ids.map((id) => ({ id, documents: [] }));
  const assertions = Array.from({ length: MAX_AUTH_ROWS - ids.length - 1 }, (_, i) =>
    row('oauthClientAssertion', { id: `synthetic-assertion-${i}`, expiresAt: now }),
  );
  const { schedule, receipt } = await start({
    payload: { ...payload, auth: { ...payload.auth, oauthClientAssertion: assertions } },
  });
  expect((await schedule()).status).toBe(200);
  expect(await receipt()).toMatchObject({
    status: 'verified',
    accountsVerified: MAX_SNAPSHOT_ACCOUNTS,
    documentsVerified: 0,
  });
}, 30_000);

test.each([
  ['wrong digest', { hash: 'f'.repeat(64) }],
  ['wrong decryption key', { secret: 'b'.repeat(64) }],
  ['wrong AAD key', { sealedKey: key.replace('0123', '1234') }],
  ['not at the exact staging key', { uploadKey: `${key}.other` }],
  ['outside the approved UTC window', { old: true }],
  ['wrong origin', { payload: { ...synthetic(), origin: 'https://other.example.com' } }],
  ['unexpected envelope key', { payload: { ...synthetic(), extra: true } }],
  [
    'too many auth rows',
    {
      payload: {
        ...synthetic(),
        auth: {
          ...synthetic().auth,
          oauthClientAssertion: Array(MAX_AUTH_ROWS + 1).fill(null),
        },
      },
    },
  ],
  [
    'too many accounts',
    { payload: { ...synthetic(), accounts: Array(MAX_SNAPSHOT_ACCOUNTS + 1).fill(null) } },
  ],
  [
    'duplicate unique auth key',
    {
      payload: {
        ...synthetic(),
        auth: {
          ...synthetic().auth,
          user: synthetic().auth.user.map((user) => ({ ...user, email: 'same@example.com' })),
        },
      },
    },
  ],
  [
    'dangling auth reference',
    {
      payload: {
        ...synthetic(),
        auth: {
          ...synthetic().auth,
          session: [
            row('session', {
              id: 'session',
              expiresAt: now,
              token: 'fixture-token',
              createdAt: now,
              updatedAt: now,
              userId: 'missing',
            }),
          ],
        },
      },
    },
  ],
  [
    'auth cell changed by affinity',
    {
      payload: {
        ...synthetic(),
        auth: {
          ...synthetic().auth,
          user: synthetic().auth.user.map((user) => ({ ...user, emailVerified: '1' })),
        },
      },
    },
  ],
  ['missing account', { payload: { ...synthetic(), accounts: synthetic().accounts.slice(1) } }],
  [
    'duplicate account',
    { payload: { ...synthetic(), accounts: Array(2).fill(synthetic().accounts[0]) } },
  ],
  [
    'bad document',
    {
      payload: {
        ...synthetic(),
        accounts: ids.map((id) => ({
          id,
          documents: [{ path: 'memories/../../bad.md', contents: '' }],
        })),
      },
    },
  ],
] as const)(
  'rejects %s before claiming or writing',
  async (_label, options) => {
    const { schedule, account, auth, claim, receipt } = await start(options);
    expect((await schedule()).status).toBe('old' in options ? 200 : 500);
    expect(await claim()).toBeNull();
    expect(await receipt()).toBeUndefined();
    await expect((await auth()).importSnapshot(synthetic().auth)).resolves.toBe(true);
    await expect((await account(ids[0]!)).importDocuments([])).resolves.toBe(true);
  },
  30_000,
);

test('rejects a short staged object before claiming', async () => {
  const { bucket, schedule, claim, receipt, auth } = await start();
  await bucket.put(key, new Uint8Array(MIN_ENVELOPE_BYTES - 1));
  expect((await schedule()).status).toBe(500);
  expect(await claim()).toBeNull();
  expect(await receipt()).toBeUndefined();
  await expect((await auth()).importSnapshot(synthetic().auth)).resolves.toBe(true);
}, 30_000);

test('durable claim blocks retry after partial progress', async () => {
  const { schedule, account, claim, receipt } = await start();
  await (await account(ids[1]!)).importDocuments([]);
  expect((await schedule()).status).toBe(500);
  const failed = {
    status: 'failed',
    phase: 'accounts',
    authVerified: true,
    accountsVerified: 1,
    documentsVerified: 1,
  };
  expect(await claim()).not.toBeNull();
  expect(await receipt()).toMatchObject(failed);
  expect((await schedule()).status).toBe(200);
  expect(await receipt()).toMatchObject(failed);
}, 30_000);

test('claim without a receipt is an ambiguous commit and cannot be resumed', async () => {
  const { bucket, schedule, account, receipt } = await start();
  await bucket.put(`${prefix}claim.json`, '{}');
  expect((await schedule()).status).toBe(200);
  expect(await receipt()).toBeUndefined();
  await expect((await account(ids[0]!)).importDocuments([])).resolves.toBe(true);
}, 30_000);

test('destination origin mismatch blocks account writes and cannot be released', async () => {
  const { schedule, account, claim, receipt } = await start({
    mainOrigin: 'https://other.example.com',
  });
  expect((await schedule()).status).toBe(500);
  expect(await claim()).not.toBeNull();
  expect(await receipt()).toMatchObject({
    status: 'failed',
    phase: 'auth',
    authVerified: false,
    accountsVerified: 0,
  });
  await expect((await account(ids[0]!)).importDocuments([])).resolves.toBe(true);
}, 30_000);
