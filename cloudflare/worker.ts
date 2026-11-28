/// <reference types="@cloudflare/workers-types" />

import { DurableObject } from 'cloudflare:workers';
import { createHttpApplication, handleMcp, unauthorizedMcp } from '../src/http.js';
import {
  readAccountDocuments,
  replaceEmptyAccountDocuments,
  withAccountStore,
} from './account-store.js';
import { createWorkerAuthService } from './auth-service.js';
import { importAuthSnapshot, markAuthIngressStarted } from './import-auth.js';
import { validateAccountSnapshot } from './snapshot.js';

export interface Env {
  MEMENTO_AUTH: DurableObjectNamespace<AuthObject>;
  MEMENTO_ACCOUNTS: DurableObjectNamespace<AccountObject>;
  MEMENTO_PUBLIC_ORIGIN: string;
  AUTH_ALLOWED_EMAILS: string;
  BETTER_AUTH_SECRET: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
}

function publicOrigin(env: Env): string {
  const origin = env.MEMENTO_PUBLIC_ORIGIN?.trim();
  const url = new URL(origin);
  if (url.origin !== origin || url.protocol !== 'https:') throw new Error('Invalid public origin');
  return origin;
}

function authObject(env: Env) {
  return env.MEMENTO_AUTH.get(env.MEMENTO_AUTH.idFromName('auth-v1'));
}

export class AuthObject extends DurableObject<Env> {
  readonly #service;
  #ingressStarted = false;
  #importing = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#service = ctx.blockConcurrencyWhile(() =>
      createWorkerAuthService(
        {
          origin: publicOrigin(env),
          allowedEmails: env.AUTH_ALLOWED_EMAILS.split(','),
          secret: env.BETTER_AUTH_SECRET.trim(),
          googleClientId: env.GOOGLE_CLIENT_ID?.trim() || undefined,
          googleClientSecret: env.GOOGLE_CLIENT_SECRET?.trim() || undefined,
          githubClientId: env.GITHUB_CLIENT_ID?.trim() || undefined,
          githubClientSecret: env.GITHUB_CLIENT_SECRET?.trim() || undefined,
        },
        ctx.storage,
      ),
    );
  }

  async #beginIngress() {
    const service = await this.#service;
    if (this.#importing) throw new Error('Auth import in progress');
    if (!this.#ingressStarted) {
      markAuthIngressStarted(this.ctx.storage);
      this.#ingressStarted = true;
    }
    return service;
  }

  async ready(): Promise<void> {
    await this.#beginIngress();
  }

  async handle(request: Request): Promise<Response> {
    return (await this.#beginIngress()).handle(request);
  }

  async verify(authorization: string | null): Promise<{ accountId: string } | null> {
    if (!authorization) return null;
    const service = await this.#beginIngress();
    const identity = await service.authenticate(
      new Request(`${publicOrigin(this.env)}/mcp`, { headers: { authorization } }),
    );
    return identity ? { accountId: identity.accountId } : null;
  }

  async importSnapshot(snapshot: unknown): Promise<true> {
    await this.#service;
    if (this.#importing || this.#ingressStarted) throw new Error('Auth import unavailable');
    this.#importing = true;
    try {
      return await importAuthSnapshot(this.ctx.storage, snapshot, publicOrigin(this.env));
    } finally {
      this.#importing = false;
    }
  }
}

const ACCOUNT_REQUEST_LIMIT = 16;

export class AccountObject extends DurableObject<Env> {
  #queue: Promise<unknown> = Promise.resolve();
  #pending = 0;

  async #serialize<T>(operation: () => Promise<T>): Promise<T> {
    this.#pending++;
    const next = this.#queue.then(operation);
    this.#queue = next.catch(() => undefined);
    try {
      return await next;
    } finally {
      this.#pending--;
    }
  }

  async mcp(request: Request): Promise<Response> {
    if (this.#pending >= ACCOUNT_REQUEST_LIMIT) {
      return Response.json({ error: 'busy' }, { status: 429, headers: { 'Retry-After': '1' } });
    }
    return this.#serialize(async () => {
      const origin = publicOrigin(this.env);
      const auth = authObject(this.env);
      const authorize = () => auth.verify(request.headers.get('authorization'));
      const identity = await authorize();
      if (
        !identity ||
        !this.ctx.id.equals(this.env.MEMENTO_ACCOUNTS.idFromName(identity.accountId))
      )
        return unauthorizedMcp(origin);
      return withAccountStore(this.ctx.storage, (store) =>
        handleMcp(request, store, authorize, identity.accountId),
      );
    });
  }

  async importDocuments(documents: unknown): Promise<true> {
    return this.#serialize<true>(async () => {
      const expected = validateAccountSnapshot(documents);
      await replaceEmptyAccountDocuments(this.ctx.storage, expected);
      const actual = readAccountDocuments(this.ctx.storage);
      const byPath = new Map(expected.map(({ path, contents }) => [path, contents]));
      if (
        actual.length !== expected.length ||
        actual.some(({ path, contents }) => byPath.get(path) !== contents)
      ) {
        throw new Error('Account import verification failed');
      }
      return true;
    });
  }
}

function createWorkerApplication(env: Env) {
  const origin = publicOrigin(env);
  return createHttpApplication({
    origin,
    auth: {
      handle: (request) => authObject(env).handle(request),
      authenticate: (request) => authObject(env).verify(request.headers.get('authorization')),
    },
    ready: () => authObject(env).ready(),
    dispatch: (accountId, request) =>
      env.MEMENTO_ACCOUNTS.get(env.MEMENTO_ACCOUNTS.idFromName(accountId)).mcp(request),
  });
}

const applications = new WeakMap<Env, ReturnType<typeof createWorkerApplication>>();

export default {
  async fetch(request, env) {
    try {
      let app = applications.get(env);
      if (!app) {
        app = createWorkerApplication(env);
        applications.set(env, app);
      }
      return await app.fetch(request);
    } catch {
      return Response.json(
        { error: 'temporarily_unavailable' },
        {
          status: 503,
          headers: {
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy': 'no-referrer',
          },
        },
      );
    }
  },
} satisfies ExportedHandler<Env>;
