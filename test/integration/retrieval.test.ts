// Retrieval acceptance (§14). A labeled corpus spanning the representative
// memory kinds — cross-repo relationships, vendor/integration context, product
// rationale, incident lessons, testing strategies, stale/superseded items, and
// similar-but-distinguishable topics — is written to disk as canonical markdown,
// rebuilt into the index, and queried through the real search_memory path.
//
// Acceptance: the expected memory appears in the top 3 for at least 80% of
// queries, and superseded memories never rank above their active replacement.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { serializeFrontmatter } from '../../src/store/frontmatter.js';
import { memoryFilename } from '../../src/store/id.js';
import { rebuildIndex } from '../../src/store/rebuild.js';
import { MemoryIndex } from '../../src/store/search-index.js';
import { searchMemory } from '../../src/store/search.js';
import type { MemoryMetadata } from '../../src/store/schema.js';

interface Fixture {
  meta: Omit<MemoryMetadata, 'created_at' | 'updated_at'> & Partial<MemoryMetadata>;
  body: string;
}

function fixture(meta: Fixture['meta'], body: string): Fixture {
  return {
    meta: {
      created_at: '2026-05-01T00:00:00Z',
      updated_at: '2026-05-01T00:00:00Z',
      ...meta,
    },
    body,
  };
}

const CORPUS: Fixture[] = [
  fixture(
    {
      id: 'mem_c01',
      title: 'Billing service and customer portal integration',
      type: 'relationship',
      scope: 'cross_project',
      status: 'active',
      projects: ['billing', 'customer-portal'],
      entities: ['billing-service', 'customer-portal'],
    },
    'The billing service calls the customer portal over gRPC to resolve entitlements before rendering invoices.',
  ),
  fixture(
    {
      id: 'mem_c02',
      title: 'ExampleEmailVendor deliverability caveat',
      type: 'integration',
      scope: 'external_tooling',
      status: 'active',
      entities: ['ExampleEmailVendor'],
      tags: ['deliverability', 'webhooks'],
    },
    'Webhook delivery can be delayed at peak volume, so retry policies that assume prompt delivery from the email vendor fail.',
  ),
  fixture(
    {
      id: 'mem_c03',
      title: 'Stripe webhook retry behaviour',
      type: 'integration',
      scope: 'cross_project',
      status: 'active',
      entities: ['Stripe'],
      tags: ['webhooks', 'retry'],
    },
    'Stripe retries failed webhooks with exponential backoff; handlers must be idempotent to avoid double processing.',
  ),
  fixture(
    {
      id: 'mem_c04',
      title: 'Why the legacy sync service still exists',
      type: 'product_context',
      scope: 'product',
      status: 'active',
      entities: ['legacy-sync'],
    },
    'The legacy sync service bridges the old CRM until the migration completes; do not delete it despite appearing unused.',
  ),
  fixture(
    {
      id: 'mem_c05',
      title: 'Idempotent webhook processing incident lesson',
      type: 'incident_learning',
      scope: 'cross_project',
      status: 'active',
      tags: ['idempotency', 'webhooks'],
    },
    'A prior incident caused duplicate charges; deduplicate by event id when processing webhooks to stay idempotent.',
  ),
  fixture(
    {
      id: 'mem_c06',
      title: 'Regression test pattern for flaky timers',
      type: 'testing',
      scope: 'workflow',
      status: 'active',
      tags: ['testing', 'flaky'],
    },
    'Use fake timers to make time-dependent tests deterministic and remove flakiness from timer-based code.',
  ),
  fixture(
    {
      id: 'mem_c07',
      title: 'Payments provider migration decision',
      type: 'decision',
      scope: 'cross_project',
      status: 'active',
      entities: ['Stripe', 'Adyen'],
    },
    'We chose Stripe over Adyen as the payment provider for broader coverage and simpler webhook tooling.',
  ),
  fixture(
    {
      id: 'mem_c08',
      title: 'Old auth approach using server sessions',
      type: 'decision',
      scope: 'project',
      status: 'superseded',
      entities: ['auth'],
    },
    'Authentication previously relied on server-side session cookies. This approach has been replaced.',
  ),
  fixture(
    {
      id: 'mem_c09',
      title: 'Current auth approach using JWT access tokens',
      type: 'decision',
      scope: 'project',
      status: 'active',
      entities: ['auth'],
      supersedes: ['mem_c08'],
      importance: 'high',
    },
    'Authentication now uses short-lived JWT access tokens with refresh tokens rotated on use.',
  ),
  fixture(
    {
      id: 'mem_c10',
      title: 'Customer portal caching strategy',
      type: 'pattern',
      scope: 'project',
      status: 'active',
      entities: ['customer-portal'],
      tags: ['cache'],
    },
    'The customer portal caches entitlement lookups for five minutes to reduce billing service load.',
  ),
  fixture(
    {
      id: 'mem_c11',
      title: 'Billing service caching strategy',
      type: 'pattern',
      scope: 'project',
      status: 'active',
      entities: ['billing-service'],
      tags: ['cache'],
    },
    'The billing service caches invoice documents for sixty seconds behind an explicit invalidation hook.',
  ),
  fixture(
    {
      id: 'mem_c12',
      title: 'Rate limiting for the public API',
      type: 'pattern',
      scope: 'cross_project',
      status: 'active',
      tags: ['rate-limit'],
    },
    'The public API enforces a token bucket rate limit per API key with burst allowance.',
  ),
  fixture(
    {
      id: 'mem_c13',
      title: 'On-call triage runbook for delivery lag',
      type: 'triage',
      scope: 'workflow',
      status: 'active',
      entities: ['ExampleEmailVendor'],
      tags: ['oncall'],
    },
    'Runbook steps to follow when the on-call alarm for email webhook lag fires during an incident.',
  ),
  fixture(
    {
      id: 'mem_c14',
      title: 'Preferred error format across services',
      type: 'working_agreement',
      scope: 'cross_project',
      status: 'active',
      tags: ['errors'],
    },
    'All services return errors as a code, message, and optional details object for a consistent contract.',
  ),
  fixture(
    {
      id: 'mem_c15',
      title: 'Deprecated reporting pipeline',
      type: 'product_context',
      scope: 'product',
      status: 'archived',
      entities: ['reporting'],
    },
    'The old reporting pipeline was removed after the warehouse migration and should not be reintroduced.',
  ),
  fixture(
    {
      id: 'mem_c16',
      title: 'Testing strategy for idempotent webhook processing',
      type: 'testing',
      scope: 'cross_project',
      status: 'active',
      tags: ['testing', 'idempotency', 'webhooks'],
    },
    'Property tests replay duplicate webhook events to prove handlers stay idempotent under redelivery.',
  ),
];

const QUERIES: { query: string; expect: string }[] = [
  { query: 'How do the billing service and customer portal interact?', expect: 'mem_c01' },
  { query: 'What do we know about retry behavior for the email vendor?', expect: 'mem_c02' },
  { query: 'Stripe webhook retries and backoff', expect: 'mem_c03' },
  { query: 'Why does the legacy sync service still exist?', expect: 'mem_c04' },
  { query: 'How should we handle idempotency for webhooks?', expect: 'mem_c05' },
  { query: 'current authentication approach', expect: 'mem_c09' },
  { query: 'customer portal caching strategy', expect: 'mem_c10' },
  { query: 'public API rate limiting', expect: 'mem_c12' },
  { query: 'error format convention across services', expect: 'mem_c14' },
  { query: 'on-call runbook for email delivery lag alerts', expect: 'mem_c13' },
  { query: 'which payment provider did we choose', expect: 'mem_c07' },
  { query: 'testing strategy for idempotent webhook processing', expect: 'mem_c16' },
];

describe('retrieval acceptance', () => {
  let dir: string;
  let index: MemoryIndex;

  const topIds = (query: string, limit = 3): string[] =>
    searchMemory({ query, limit }, { index, defaultLimit: 5, maxLimit: 10 }).results.map(
      (r) => r.id,
    );

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'memento-corpus-'));
    for (const { meta, body } of CORPUS) {
      const file = memoryFilename(meta.id, meta.title);
      writeFileSync(join(dir, file), serializeFrontmatter(meta, body));
    }
    index = new MemoryIndex();
    const result = await rebuildIndex(index, dir);
    expect(result.indexed).toBe(CORPUS.length);
    expect(result.skipped).toEqual([]);
  });

  afterAll(() => {
    index.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('expected memory is in the top 3 for at least 80% of queries', () => {
    const misses: string[] = [];
    for (const { query, expect: expectedId } of QUERIES) {
      if (!topIds(query).includes(expectedId)) {
        misses.push(`${expectedId} not in top-3 for "${query}" (got ${topIds(query).join(', ')})`);
      }
    }
    const passRate = (QUERIES.length - misses.length) / QUERIES.length;
    expect(passRate, misses.join('\n')).toBeGreaterThanOrEqual(0.8);
  });

  test('a superseded memory does not rank above its active replacement', () => {
    const ids = topIds('authentication approach', 10);
    expect(ids.indexOf('mem_c09')).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf('mem_c09')).toBeLessThan(
      ids.indexOf('mem_c08') === -1 ? Number.MAX_SAFE_INTEGER : ids.indexOf('mem_c08'),
    );
  });

  test('archived memories stay out of default results for unrelated queries', () => {
    expect(topIds('rate limiting', 5)).not.toContain('mem_c15');
  });

  test('results carry enough context to decide whether to read', () => {
    const [top] = searchMemory(
      { query: 'billing service customer portal' },
      { index, defaultLimit: 5, maxLimit: 10 },
    ).results;
    expect(top!.why_relevant.length).toBeGreaterThan(0);
    expect(top!.excerpt).toBeTruthy();
  });
});
