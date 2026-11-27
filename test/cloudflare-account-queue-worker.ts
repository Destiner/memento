import { DurableObject } from 'cloudflare:workers';

import { AccountObject, type Env } from '../cloudflare/worker.js';

export { AccountObject };

export class TestAuth extends DurableObject {
  #checks = 0;
  #released = false;

  async verify(authorization: string | null) {
    if (authorization === 'Bearer held-queue-fixture' && ++this.#checks === 2) {
      while (!this.#released) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    if (authorization === 'Bearer other-queue-fixture') return { accountId: 'other' };
    return { accountId: 'queue' };
  }

  status() {
    return this.#checks;
  }

  release() {
    this.#released = true;
  }
}

export default {
  async fetch(
    request: Request,
    env: Omit<Env, 'MEMENTO_AUTH'> & {
      MEMENTO_AUTH: DurableObjectNamespace<TestAuth>;
    },
  ) {
    const { pathname } = new URL(request.url);
    const auth = env.MEMENTO_AUTH.get(env.MEMENTO_AUTH.idFromName('auth-v1'));
    if (pathname === '/status') return Response.json(await auth.status());
    if (pathname === '/release') {
      await auth.release();
      return Response.json(true);
    }
    const name = pathname === '/other' ? 'other' : 'queue';
    // Use fresh stubs so the callers do not share an RPC delivery queue.
    const account = env.MEMENTO_ACCOUNTS.get(env.MEMENTO_ACCOUNTS.idFromName(name));
    if (pathname === '/import') {
      try {
        return Response.json(await account.importDocuments(await request.json()));
      } catch {
        return Response.json(false, { status: 409 });
      }
    }
    return account.mcp(request);
  },
};
