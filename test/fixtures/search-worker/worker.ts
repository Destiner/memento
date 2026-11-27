/// <reference types="@cloudflare/workers-types" />
import { DurableObject } from 'cloudflare:workers';

import type { MemoryRecord } from '../../../src/store/memory-schema.js';
import {
  MemoryIndex,
  type DedupeOptions,
  type SearchOptions,
} from '../../../src/store/search-index.js';

export type Operation =
  | { op: 'upsert'; entries: [MemoryRecord, string][] }
  | { op: 'search'; query: string; options: SearchOptions }
  | { op: 'candidates'; options: DedupeOptions }
  | { op: 'remove' | 'status'; id: string }
  | { op: 'clear' | 'count' | 'reopen' | 'scratchCount' };

export class SearchObject extends DurableObject {
  private index = MemoryIndex.fromDurableStorage(this.ctx.storage);

  async fetch(request: Request): Promise<Response> {
    const operations = await request.json<Operation[]>();
    return Response.json(
      operations.map((operation) => {
        try {
          return this.run(operation) ?? null;
        } catch (error) {
          return { error: String(error) };
        }
      }),
    );
  }

  private run(operation: Operation) {
    switch (operation.op) {
      case 'upsert':
        for (const entry of operation.entries) this.index.upsert(...entry);
        return;
      case 'search':
        return this.index.search(operation.query, operation.options);
      case 'candidates':
        return this.index.candidates(operation.options);
      case 'remove':
        return this.index.remove(operation.id);
      case 'status':
        return this.index.statusOf(operation.id);
      case 'clear':
        return this.index.clear();
      case 'count':
        return this.index.count();
      case 'reopen':
        this.index.close();
        this.index = MemoryIndex.fromDurableStorage(this.ctx.storage);
        return this.index.count();
      case 'scratchCount':
        return this.ctx.storage.sql
          .exec<{ n: number }>('SELECT COUNT(*) AS n FROM search_tokens')
          .one().n;
    }
  }
}

export default {
  fetch(request: Request, env: { SEARCH: DurableObjectNamespace }) {
    return env.SEARCH.getByName(new URL(request.url).pathname).fetch(request);
  },
};
