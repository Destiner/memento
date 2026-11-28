/// <reference types="@cloudflare/workers-types" />
import { DurableObject } from 'cloudflare:workers';
import { readAccountDocuments, replaceEmptyAccountDocuments } from '../cloudflare/account-store.js';
import { createWorkerAuthService } from '../cloudflare/auth-service.js';
import { importAuthSnapshot, markAuthIngressStarted } from '../cloudflare/import-auth.js';
import { AUTH_TABLES, readAuthTable } from '../cloudflare/snapshot-auth.js';
import { validateMigrationSnapshot } from '../cloudflare/snapshot.js';

interface Env {
  STORE: DurableObjectNamespace<SnapshotFixture>;
  OPTIONS: Parameters<typeof createWorkerAuthService>[0];
}

export class SnapshotFixture extends DurableObject<Env> {
  override async fetch(request: Request): Promise<Response> {
    const storage = this.ctx.storage;
    const { pathname } = new URL(request.url);
    const options = this.env.OPTIONS;
    try {
      if (pathname === '/seed') {
        await (await createWorkerAuthService(options, storage)).close();
        return new Response(null, { status: 204 });
      }
      if (pathname === '/seal-empty') {
        await (await createWorkerAuthService(options, storage)).close();
        markAuthIngressStarted(storage);
        return new Response(null, { status: 204 });
      }
      if (pathname === '/import') {
        const snapshot = validateMigrationSnapshot(await request.json(), options.origin);
        const verified = await importAuthSnapshot(storage, snapshot.auth, options.origin);
        for (const account of snapshot.accounts) {
          const target = this.env.STORE.getByName(`account:${account.id}`);
          if (!(await target.putDocuments(account.documents))) throw new Error();
        }
        return Response.json(verified);
      }
      if (pathname === '/auth-readback') {
        return Response.json(
          Object.fromEntries(
            AUTH_TABLES.map((table) => [
              table,
              readAuthTable((query) => storage.sql.exec(query), table),
            ]),
          ),
        );
      }
      if (pathname === '/mcp') {
        const service = await createWorkerAuthService(options, storage);
        try {
          const identity = await service.authenticate(request);
          const docs = identity
            ? await this.env.STORE.getByName(`account:${identity.accountId}`).documents()
            : null;
          return Response.json({ identity, docs }, { status: identity ? 200 : 401 });
        } finally {
          await service.close();
        }
      }
      const service = await createWorkerAuthService(options, storage);
      try {
        return await service.handle(request);
      } finally {
        await service.close();
      }
    } catch {
      return new Response(null, { status: 400 });
    }
  }

  async putDocuments(documents: ReturnType<typeof readAccountDocuments>): Promise<true> {
    await replaceEmptyAccountDocuments(this.ctx.storage, documents);
    if (JSON.stringify(readAccountDocuments(this.ctx.storage)) !== JSON.stringify(documents))
      throw new Error();
    return true;
  }

  documents() {
    return readAccountDocuments(this.ctx.storage);
  }
}

export default {
  fetch(request, env) {
    return env.STORE.getByName(new URL(request.url).searchParams.get('fixture') ?? 'auth').fetch(
      request,
    );
  },
} satisfies ExportedHandler<Env>;
