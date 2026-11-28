import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { AUTH_TABLES, readAuthTable } from '../cloudflare/snapshot-auth.js';
import { validateMigrationSnapshot, validateAccountSnapshot } from '../cloudflare/snapshot.js';
import { exportSnapshot } from '../scripts/cloudflare-export.js';
import { createAuthService } from '../src/auth/index.js';
import { acquireServiceLock } from '../src/service-lock.js';
import { serializeFrontmatter } from '../src/store/frontmatter.js';

const options = {
  origin: 'https://memento.destiner.io',
  secret: 'synthetic-offline-test-secret-only-32094320',
  allowedEmails: ['mock-owner@example.test'],
  githubClientId: 'synthetic',
  githubClientSecret: 'synthetic',
};
const { origin } = options;
const id = '831dcab9-12e4-4d34-aa34-2c1a535c8655';
const emptyId = '4c2ac535-142e-42c1-ba3d-56a43432f414';
const refresh = 'synthetic-refresh-token-1234567890';
const access = 'synthetic-access-token-1234567890';
const projectId = 'prj_Mock77';
const now = new Date().toISOString();
const expires = new Date(Date.now() + 3600_000).toISOString();
const hash = (token: string) => createHash('sha256').update(token).digest('base64url');
const scopes = JSON.stringify(['mcp', 'offline_access']);
const resources = JSON.stringify([`${origin}/mcp`]);
let root: string;
let home: string;
let source: string;
let client: { client_id: string; client_secret: string };

function memory(project = projectId) {
  return serializeFrontmatter(
    {
      id: 'mem_Synthetic',
      title: 'Synthetic fixture',
      description: 'An offline migration test.',
      type: 'other',
      scope: { kind: 'projects', project_ids: [project] },
      provenance: { source: 'agent_observed', verification: 'observed_once' },
      status: 'active',
      created_at: now,
      updated_at: now,
    },
    'Synthetic body.\n',
  );
}

function sql(fn: (db: DatabaseSync) => void) {
  const db = new DatabaseSync(join(source, 'auth.sqlite'));
  try {
    fn(db);
  } finally {
    db.close();
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(await realpath(tmpdir()), 'memento-synthetic-snapshot-'));
  source = join(root, 'data');
  const service = await createAuthService({ ...options, dataDir: source });
  try {
    const response = await service.handle(
      new Request(`${origin}/api/auth/oauth2/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Synthetic confidential client',
          redirect_uris: ['https://client.example/callback'],
          token_endpoint_auth_method: 'client_secret_post',
          application_type: 'web',
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
        }),
      }),
    );
    expect(response.status).toBe(201);
    client = (await response.json()) as typeof client;
    expect(typeof client.client_secret).toBe('string');
  } finally {
    await service.close();
  }
  sql((db) => {
    db.prepare('INSERT INTO user VALUES (?, ?, ?, 1, NULL, ?, ?)').run(
      id,
      'Mock Owner',
      options.allowedEmails[0]!,
      now,
      now,
    );
    db.prepare('INSERT INTO user VALUES (?, ?, ?, 1, NULL, ?, ?)').run(
      emptyId,
      'Mock Other',
      'mock-other@example.test',
      now,
      now,
    );
    db.prepare(
      `INSERT INTO account (id, accountId, providerId, userId, createdAt, updatedAt)
      VALUES ('mock-link', 'mock-subject', 'github', ?, ?, ?)`,
    ).run(id, now, now);
    db.prepare(
      `INSERT INTO session (id, token, userId, createdAt, updatedAt, expiresAt)
      VALUES ('mock-session', 'synthetic-session', ?, ?, ?, ?)`,
    ).run(id, now, now, expires);
    db.prepare(
      `INSERT INTO verification (id, identifier, value, createdAt, updatedAt, expiresAt) VALUES
      ('mock-transient', 'synthetic-transient', X'00FF11', 1.5, 9223372036854775807, ?),
      ('mock-text', 'synthetic-text', CAST(X'610062' AS TEXT), ?, ?, ?)`,
    ).run(expires, now, now, expires);
    db.prepare(
      `INSERT INTO oauthConsent (id, clientId, userId, scopes, resources, createdAt, updatedAt)
      VALUES ('mock-consent', ?, ?, ?, ?, ?, ?)`,
    ).run(client.client_id, id, scopes, resources, now, now);
    db.prepare(
      `INSERT INTO oauthRefreshToken
      (id, token, clientId, userId, scopes, resources, createdAt, expiresAt, authorizationCodeId)
      VALUES ('mock-refresh', ?, ?, ?, ?, ?, ?, ?, 'mock-authorization')`,
    ).run(hash(refresh), client.client_id, id, scopes, resources, now, expires);
    db.prepare(
      `INSERT INTO oauthAccessToken
      (id, token, clientId, userId, scopes, resources, createdAt, expiresAt, refreshId, sessionId)
      VALUES ('mock-access', ?, ?, ?, ?, ?, ?, ?, 'mock-refresh', 'mock-session')`,
    ).run(hash(access), client.client_id, id, scopes, resources, now, expires);
  });
  home = join(source, 'accounts', id);
  await mkdir(join(home, 'memories'), { recursive: true });
  await mkdir(join(home, 'projects'));
  await mkdir(join(home, 'logs'));
  await writeFile(join(home, 'logs', 'synthetic.jsonl'), 'not included');
  await writeFile(join(home, 'memories', 'renamed note.md'), memory());
  await writeFile(
    join(home, 'projects', 'renamed project.md'),
    serializeFrontmatter(
      {
        id: projectId,
        name: 'Synthetic project',
        description: 'A fixture project.',
        created_at: now,
        updated_at: now,
        status: 'active',
      },
      '',
    ),
  );
  await writeFile(join(home, 'config.json'), '{"logging_enabled":false}\n');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

it('exports private deterministic bytes and never overwrites or writes to implicit stdout', async () => {
  const output = join(root, 'snapshot');
  const run = (args: string[] = [], file: string | undefined = output) =>
    spawnSync(
      process.execPath,
      [
        '--disable-warning=ExperimentalWarning',
        '--import',
        'tsx',
        'scripts/cloudflare-export.ts',
        ...args,
      ],
      {
        env: {
          ...process.env,
          MEMENTO_DATA_DIR: source,
          MEMENTO_PUBLIC_ORIGIN: origin,
          MEMENTO_SNAPSHOT_FILE: file ?? '',
        },
      },
    );
  const written = run();
  expect([written.status, written.stdout.length, written.stderr.length]).toEqual([0, 0, 0]);
  expect((await stat(output)).mode & 0o777).toBe(0o600);
  const bytes = await readFile(output);
  expect(run(['--stdout'], '').stdout.equals(bytes)).toBe(true);
  expect(run([], '').stdout.length).toBe(0);
  expect(run().status).toBe(1);
  expect(await readFile(output)).toEqual(bytes);
  const link = join(root, 'linked-snapshot');
  await symlink(output, link);
  expect(run([], link).status).toBe(1);
  expect(await readFile(output)).toEqual(bytes);
  expect(run([], join(source, 'forbidden')).status).toBe(1);
  const parsed = validateMigrationSnapshot(JSON.parse(bytes.toString()), origin);
  expect(parsed.accounts.find((row) => row.id === emptyId)?.documents).toEqual([]);
  expect(parsed.accounts.find((row) => row.id === id)?.documents.map(({ path }) => path)).toEqual([
    'config.json',
    'memories/renamed note.md',
    'projects/renamed project.md',
  ]);
  expect(parsed.auth.oauthClient[0]!.clientSecret).not.toBe(client.client_secret);
  expect(parsed.auth.oauthRefreshToken[0]!.token).toBe(hash(refresh));
  expect(parsed.auth.verification).toContainEqual(
    expect.objectContaining({
      value: { blob: 'AP8R' },
      createdAt: 1.5,
      updatedAt: { integer: '9223372036854775807' },
    }),
  );
  expect(parsed.auth.verification).toContainEqual(expect.objectContaining({ value: 'a\0b' }));
});

it('refuses unlocked inconsistencies, unknown accounts, links, dangling and duplicate documents', async () => {
  const unlock = await acquireServiceLock(source);
  try {
    await expect(exportSnapshot(source, origin)).rejects.toThrow(/service lock/);
  } finally {
    unlock();
  }
  await expect(exportSnapshot(source, 'https://wrong.example')).rejects.toThrow();
  const orphan = join(source, 'accounts', 'synthetic-orphan');
  await mkdir(orphan);
  await expect(exportSnapshot(source, origin)).rejects.toThrow(/matching auth user/);
  await rm(orphan, { recursive: true });
  const link = join(home, 'logs', 'link');
  await symlink(join(home, 'config.json'), link);
  await expect(exportSnapshot(source, origin)).rejects.toThrow(/derived/);
  await rm(link);
  const linkedRoot = join(root, 'linked-root');
  await symlink(source, linkedRoot);
  await expect(exportSnapshot(linkedRoot, origin)).rejects.toThrow(/real directory/);
  const doc = join(home, 'memories', 'extra.md');
  await writeFile(doc, 'x'.repeat(256 * 1024 + 1));
  await expect(exportSnapshot(source, origin)).rejects.toThrow(/oversized/);
  await writeFile(doc, memory('prj_Missing'));
  const original = join(home, 'memories', 'renamed note.md');
  await rm(original);
  await expect(exportSnapshot(source, origin)).rejects.toThrow();
  await writeFile(doc, memory());
  await writeFile(original, memory());
  await expect(exportSnapshot(source, origin)).rejects.toThrow();
  await rm(doc);
  await writeFile(join(source, 'auth.sqlite-wal'), 'uncheckpointed');
  await expect(exportSnapshot(source, origin)).rejects.toThrow(/uncheckpointed/);
  await rm(join(source, 'auth.sqlite-wal'));
  await chmod(join(source, 'auth.sqlite'), 0o400);
  const snapshot = await exportSnapshot(source, origin);
  await chmod(join(source, 'auth.sqlite'), 0o600);
  expect(() =>
    validateMigrationSnapshot({ ...snapshot, accounts: snapshot.accounts.slice(1) }, origin),
  ).toThrow();
  expect(() => validateAccountSnapshot(Array.from({ length: 1025 }, () => ({})))).toThrow();
  sql((db) => {
    db.exec('PRAGMA foreign_keys = OFF');
    db.prepare('UPDATE account SET userId = ?').run('unknown-user');
  });
  await expect(exportSnapshot(source, origin)).rejects.toThrow();
});

it('restores both resources in offline workerd but only accepts the canonical bearer after restart', async () => {
  const historicalOrigin = 'https://memento-o9bz.onrender.com';
  const historicalResource = `${historicalOrigin}/mcp`;
  const historicalResources = JSON.stringify([historicalResource]);
  const historicalAccess = 'synthetic-historical-access-token-1234567890';
  const historicalRefresh = 'synthetic-historical-refresh-token-1234567890';
  const identity = { email: options.allowedEmails[0], accountId: id };
  const historicalService = await createAuthService({
    ...options,
    origin: historicalOrigin,
    dataDir: source,
  });
  try {
    sql((db) => {
      db.prepare(
        `INSERT INTO oauthClientResource (id, clientId, resourceId, metadata, createdAt)
        VALUES ('mock-historical-link', ?, ?, '{"synthetic":true}', ?)`,
      ).run(client.client_id, historicalResource, now);
      db.prepare(
        `INSERT INTO oauthRefreshToken
        (id, token, clientId, userId, scopes, resources, createdAt, expiresAt, authorizationCodeId)
        VALUES ('mock-historical-refresh', ?, ?, ?, ?, ?, ?, ?, 'mock-historical-authorization')`,
      ).run(
        hash(historicalRefresh),
        client.client_id,
        id,
        scopes,
        historicalResources,
        now,
        expires,
      );
      db.prepare(
        `INSERT INTO oauthAccessToken
        (id, token, clientId, userId, scopes, resources, createdAt, expiresAt, refreshId, sessionId)
        VALUES ('mock-historical-access', ?, ?, ?, ?, ?, ?, ?, 'mock-historical-refresh', 'mock-session')`,
      ).run(
        hash(historicalAccess),
        client.client_id,
        id,
        scopes,
        historicalResources,
        now,
        expires,
      );
    });
    expect(
      await historicalService.authenticate(
        new Request(historicalResource, {
          headers: { authorization: `Bearer ${historicalAccess}` },
        }),
      ),
    ).toEqual(identity);
  } finally {
    await historicalService.close();
  }
  const snapshot = await exportSnapshot(source, origin);
  expect(snapshot.auth.oauthResource.map(({ identifier }) => identifier).sort()).toEqual(
    [`${origin}/mcp`, historicalResource].sort(),
  );
  sql((db) => {
    for (const table of AUTH_TABLES) {
      expect(snapshot.auth[table]).toEqual(
        readAuthTable((query) => db.prepare(query).all(), table),
      );
    }
  });
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('./cloudflare-snapshot-worker.ts', import.meta.url))],
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'esm',
    conditions: ['workerd', 'worker'],
    external: ['cloudflare:*', 'node:*'],
  });
  const boot = () =>
    new Miniflare({
      host: '127.0.0.1',
      cf: false,
      telemetry: { enabled: false },
      resourcePersistencePath: join(root, 'do'),
      workers: [
        {
          config: {
            name: 'snapshot-fixture',
            compatibilityDate: '2026-11-23',
            compatibilityFlags: ['nodejs_compat'],
            manifest: {
              mainModule: 'fixture.mjs',
              modules: { 'fixture.mjs': { type: 'esm', contents: bundle.outputFiles[0]!.text } },
            },
            env: {
              STORE: {
                type: 'durable-object',
                worker: 'snapshot-fixture',
                exportName: 'SnapshotFixture',
              },
              OPTIONS: { type: 'json', value: options },
            },
            exports: { SnapshotFixture: { type: 'durable-object', storage: 'sqlite' } },
          },
        },
      ],
    });
  let worker = boot();
  const get = (path: string) => worker.dispatchFetch(`${origin}${path}`);
  const put = (body: unknown, query = '') =>
    worker.dispatchFetch(`${origin}/import${query}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const who = (token: string) =>
    worker.dispatchFetch(`${origin}/mcp`, { headers: { authorization: `Bearer ${token}` } });
  try {
    expect((await get('/seal-empty?fixture=sealed')).status).toBe(204);
    expect((await put(snapshot, '?fixture=sealed')).status).toBe(400);
    expect((await get('/seed')).status).toBe(204);
    const invalid = structuredClone(snapshot);
    invalid.auth.oauthResource = invalid.auth.oauthResource.filter(
      ({ identifier }) => identifier !== `${origin}/mcp`,
    );
    expect((await put(invalid)).status).toBe(400);
    const dangling = structuredClone(snapshot);
    dangling.auth.oauthAccessToken[0]!.refreshId = 'dangling-grant';
    expect((await put(dangling)).status).toBe(400);
    const restored = await put(snapshot);
    expect(restored.status).toBe(200);
    expect(await restored.json()).toBe(true);
    expect((await put(snapshot)).status).toBe(400);
    await worker.dispose();
    worker = boot();
    expect(await (await get('/auth-readback')).json()).toEqual(snapshot.auth);
    const docs = snapshot.accounts.find((record) => record.id === id)!.documents;
    expect((await who(historicalAccess)).status).toBe(401);
    expect(await (await who(access)).json()).toEqual({ identity, docs });
    const response = await worker.dispatchFetch(`${origin}/api/auth/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: client.client_id,
        client_secret: client.client_secret,
        grant_type: 'refresh_token',
        refresh_token: refresh,
        resource: `${origin}/mcp`,
      }),
    });
    expect(response.status).toBe(200);
    const tokens = (await response.json()) as { access_token: string; refresh_token: string };
    expect(tokens.refresh_token).not.toBe(refresh);
    expect(await (await who(tokens.access_token)).json()).toEqual({ identity, docs });
  } finally {
    await worker.dispose();
  }
}, 30_000);
