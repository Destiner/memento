/// <reference types="@cloudflare/workers-types" />

import { DurableObject } from 'cloudflare:workers';
import { createWorkerAuthService } from '../../cloudflare/auth-service.js';

interface Env {
  AUTH: DurableObjectNamespace<AuthFixture>;
  AUTH_OPTIONS: Parameters<typeof createWorkerAuthService>[0];
}

export class AuthFixture extends DurableObject<Env> {
  private readonly service;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.service = ctx.blockConcurrencyWhile(async () => {
      const service = await createWorkerAuthService(env.AUTH_OPTIONS, ctx.storage);
      // Fail after the user insert to verify that Better Auth's async transaction rolls back.
      ctx.storage.sql.exec(`CREATE TRIGGER IF NOT EXISTS testRejectAccount
        BEFORE INSERT ON account WHEN NEW.accountId = 'mock-aborted-google-subject'
        BEGIN SELECT RAISE(ABORT, 'synthetic account insertion failure'); END`);
      ctx.storage.sql.exec(`CREATE TRIGGER IF NOT EXISTS testRejectClientResource
        BEFORE INSERT ON oauthClientResource WHEN EXISTS (
          SELECT 1 FROM oauthClient WHERE clientId = NEW.clientId AND name = 'Aborted registration'
        ) BEGIN SELECT RAISE(ABORT, 'synthetic client resource insertion failure'); END`);
      return service;
    });
  }

  override async fetch(request: Request): Promise<Response> {
    const service = await this.service;
    const path = new URL(request.url).pathname;
    const storage = this.ctx.storage;
    const sql = storage.sql;
    if (path === '/test/sql-transaction') {
      sql.exec('CREATE TABLE IF NOT EXISTS testTransaction (value TEXT PRIMARY KEY)');
      if (request.method === 'POST') {
        const abort = new Error('synthetic rollback');
        for (const outcome of ['commit', 'rollback']) {
          try {
            await storage.transaction(async () => {
              sql.exec('INSERT INTO testTransaction VALUES (?)', `${outcome}-before`);
              await new Promise((resolve) => setTimeout(resolve, 5));
              sql.exec('INSERT INTO testTransaction VALUES (?)', `${outcome}-after`);
              if (outcome === 'rollback') throw abort;
            });
          } catch (error) {
            if (error !== abort) throw error;
          }
        }
      }
      return Response.json(sql.exec('SELECT value FROM testTransaction ORDER BY value').toArray());
    }
    if (path === '/test/registrations') {
      if (request.method === 'POST') {
        const old = Date.now() - 7200_000;
        sql.exec(
          `UPDATE oauthClient SET createdAt = ? WHERE name IN ('Stale unused', 'Workerd test client')`,
          new Date(old).toISOString(),
        );
        sql.exec(`UPDATE oauthClient SET createdAt = ? WHERE name = 'Stale numeric'`, old);
      }
      return Response.json(sql.exec('SELECT name FROM oauthClient ORDER BY name').toArray());
    }
    if (path === '/mcp') return Response.json(await service.authenticate(request));
    return service.handle(request);
  }
}

export default {
  fetch(request, env) {
    return env.AUTH.getByName('auth').fetch(request);
  },
} satisfies ExportedHandler<Env>;
