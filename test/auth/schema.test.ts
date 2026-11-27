import { DatabaseSync } from 'node:sqlite';
import { getMigrations } from 'better-auth/db/migration';
import { expect, it } from 'vitest';
import { authMigrations } from '../../cloudflare/auth-schema.js';
import { createAuthServiceWithBackend } from '../../src/auth/core.js';

it('keeps the Worker auth migrations aligned with the Node Better Auth schema', async () => {
  const db = new DatabaseSync(':memory:');
  const service = await createAuthServiceWithBackend(
    {
      origin: 'https://memory.example',
      allowedEmails: ['owner@example.test'],
      secret: 'synthetic-migration-test-only-0123456789',
      githubClientId: 'synthetic',
      githubClientSecret: 'synthetic',
    },
    async () => ({
      database: db,
      migrate: async (config) => {
        for (const sql of authMigrations) db.exec(sql);
        const migrations = await getMigrations(config);
        expect(migrations.schemaProblems).toEqual([]);
        expect(migrations.toBeCreated).toEqual([]);
        expect(migrations.toBeAdded).toEqual([]);
        expect(migrations.toBeAddedIndexes).toEqual([]);
      },
      write: () => {
        throw new Error('Unexpected auth write');
      },
      count: () => {
        throw new Error('Unexpected auth count');
      },
      atomic: () => {
        throw new Error('Unexpected auth transaction');
      },
      close: () => db.close(),
    }),
  );
  await service.close();
});
