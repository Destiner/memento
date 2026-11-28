import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, URL } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { expect, test } from 'vitest';

test('production account RPCs serialize across requests and recover after a rejected import', async () => {
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL('./cloudflare-account-queue-worker.ts', import.meta.url))],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    mainFields: ['browser', 'module', 'main'],
    external: ['cloudflare:workers', 'node:*'],
    write: false,
  });
  const name = 'synthetic-account-queue';
  const runtime = new Miniflare({
    host: '127.0.0.1',
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name,
          compatibilityDate: '2026-11-23',
          compatibilityFlags: ['nodejs_compat'],
          manifest: {
            mainModule: 'worker.mjs',
            modules: { 'worker.mjs': { type: 'esm', contents: outputFiles[0]!.text } },
          },
          env: {
            MEMENTO_PUBLIC_ORIGIN: { type: 'json', value: 'https://queue.example.test' },
            MEMENTO_ACCOUNTS: { type: 'durable-object', worker: name, exportName: 'AccountObject' },
            MEMENTO_AUTH: { type: 'durable-object', worker: name, exportName: 'TestAuth' },
          },
          exports: {
            AccountObject: { type: 'durable-object', storage: 'sqlite' },
            TestAuth: { type: 'durable-object', storage: 'sqlite' },
          },
        },
      },
    ],
  });
  const dispatch = (path: string, init?: Parameters<Miniflare['dispatchFetch']>[1]) =>
    runtime.dispatchFetch(`http://localhost${path}`, init);
  const call = (path: string, token: string, name: string, args: object) =>
    dispatch(path, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    });
  const create = (token: string, subject: string) =>
    call('/queue', token, 'create_memory', {
      title: `Synthetic ${subject}`,
      description: `Synthetic notes on ${subject}.`,
      body: `Synthetic kinematics fixture about ${subject}.`,
      type: 'other',
      scope: { kind: 'global' },
      provenance: { source: 'user_stated' },
      force_create: true,
      force_create_reason: 'Distinct synthetic queue record.',
    });
  const search = (path: string, token: string) =>
    call(path, token, 'search_memories', { query: 'kinematics', scope: { kind: 'global' } });
  try {
    const first = create('held-queue-fixture', 'lattice');
    // Drain this promise even if an assertion aborts the test before the gate opens.
    void first.catch(() => {});
    for (let i = 0; i < 50; i++) {
      if ((await (await dispatch('/status')).json()) === 2) break;
      await delay(10);
    }
    expect(await (await dispatch('/status')).json()).toBe(2);

    // The first call has hydrated its scratch and paused in the dispatch auth check.
    // The busy reply proves other RPCs reached this DO while the first was still active.
    const queued = Array.from({ length: 17 }, (_, i) => create('queue-fixture', `topic ${i}`));
    const arrivals = queued.map(async (pending, index) => ({ reply: await pending, index }));
    const firstOverflow = await Promise.race(arrivals);
    const secondOverflow = await Promise.race(
      arrivals.filter((_, index) => index !== firstOverflow.index),
    );
    for (const { reply } of [firstOverflow, secondOverflow]) {
      expect(reply.status).toBe(429);
      expect(reply.headers.get('retry-after')).toBe('1');
    }
    expect(await (await search('/other', 'other-queue-fixture')).json()).toMatchObject({
      result: { structuredContent: { result_count: 0 } },
    });
    const rejectedImport = dispatch('/import', { method: 'POST', body: '[]' });
    await dispatch('/release');

    const replies = await Promise.all([first, ...queued]);
    expect(replies.filter(({ status }) => status === 429)).toHaveLength(2);
    const ids = [];
    for (const reply of replies.filter(({ status }) => status === 200)) {
      const body = (await reply.json()) as { result: { structuredContent: { id: string } } };
      expect(body).toMatchObject({ result: { structuredContent: { id: expect.any(String) } } });
      ids.push(body.result.structuredContent.id);
    }
    expect(new Set(ids).size).toBe(16);
    expect((await rejectedImport).status).toBe(409);
    for (const id of ids) {
      expect(
        await (await call('/queue', 'queue-fixture', 'get_memory', { id })).json(),
      ).toMatchObject({
        result: { structuredContent: { id } },
      });
    }
  } finally {
    await runtime.dispose();
  }
}, 15_000);
