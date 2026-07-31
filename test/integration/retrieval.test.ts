// Retrieval acceptance. A labeled corpus spanning the representative memory kinds
// — cross-project relationships, vendor quirks, product rationale, debugging
// patterns, decisions, and similar-but-distinguishable topics — is written to disk
// as canonical markdown, rebuilt into the index, and queried through the real
// `search_memories` path.
//
// Acceptance: the expected memory appears in the top 3 for at least 80% of
// queries, and an archived memory never ranks above its active replacement.
//
// This is the test that watches the V2 retrieval trade: `entities` and `tags` are
// gone as filters and as ranking inputs, and `description` is the field that has
// to carry their weight.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { serializeFrontmatter } from '../../src/store/frontmatter.js';
import { memoryFilename } from '../../src/store/id.js';
import { orderMemoryMetadata } from '../../src/store/memory-fields.js';
import { searchMemories } from '../../src/store/memory-search.js';
import type { MemoryRecord } from '../../src/store/memory-schema.js';
import { rebuildIndex } from '../../src/store/rebuild.js';
import { MemoryIndex } from '../../src/store/search-index.js';
import { memoryRecord, PROJECT_A, PROJECT_B, seedProjects } from '../helpers/memories.js';

const BOTH = { kind: 'projects' as const, project_ids: [PROJECT_A, PROJECT_B] };
const BILLING = { kind: 'projects' as const, project_ids: [PROJECT_A] };
const PORTAL = { kind: 'projects' as const, project_ids: [PROJECT_B] };

interface Fixture {
  record: MemoryRecord;
  body: string;
}

function fixture(overrides: Partial<MemoryRecord>, body: string): Fixture {
  return { record: memoryRecord({ scope: BILLING, ...overrides }), body };
}

const CORPUS: Fixture[] = [
  fixture(
    {
      id: 'mem_c01',
      title: 'Billing service and customer portal integration',
      description: 'Billing resolves entitlements through the customer portal before invoicing.',
      type: 'cross_project_context',
      scope: BOTH,
    },
    'The billing service calls the customer portal over gRPC to resolve entitlements before rendering invoices.',
  ),
  fixture(
    {
      id: 'mem_c02',
      title: 'ExampleEmailVendor deliverability caveat',
      description:
        'The email vendor delays webhooks at peak volume, so retry timing assumptions break.',
      type: 'environment_workflow_quirk',
      scope: BOTH,
    },
    'Webhook delivery can be delayed at peak volume, so retry policies that assume prompt delivery from the email vendor fail.',
  ),
  fixture(
    {
      id: 'mem_c03',
      title: 'Stripe webhook retry behaviour',
      description: 'Stripe retries webhooks with exponential backoff; handlers must be idempotent.',
      type: 'environment_workflow_quirk',
      scope: BOTH,
    },
    'Stripe retries failed webhooks with exponential backoff; handlers must be idempotent to avoid double processing.',
  ),
  fixture(
    {
      id: 'mem_c04',
      title: 'Why the legacy sync service still exists',
      description:
        'The legacy sync bridges the old CRM until migration completes; it looks unused.',
      type: 'product_rationale',
    },
    'The legacy sync service bridges the old CRM until the migration completes; do not delete it despite appearing unused.',
  ),
  fixture(
    {
      id: 'mem_c05',
      title: 'Idempotent webhook processing incident lesson',
      description: 'Duplicate charges came from processing webhook events without deduplication.',
      type: 'debugging_pattern',
      scope: BOTH,
    },
    'A prior incident caused duplicate charges; deduplicate by event id when processing webhooks to stay idempotent.',
  ),
  fixture(
    {
      id: 'mem_c06',
      title: 'Regression test pattern for flaky timers',
      description: 'Time-dependent tests flake unless the clock is faked.',
      type: 'debugging_pattern',
      scope: PORTAL,
    },
    'Use fake timers to make time-dependent tests deterministic and remove flakiness from timer-based code.',
  ),
  fixture(
    {
      id: 'mem_c07',
      title: 'Payments provider migration decision',
      description: 'Stripe was chosen over Adyen for coverage and simpler webhook tooling.',
      type: 'decision_history',
      scope: BOTH,
    },
    'We chose Stripe over Adyen as the payment provider for broader coverage and simpler webhook tooling.',
  ),
  fixture(
    {
      id: 'mem_c08',
      title: 'Old auth approach using server sessions',
      description: 'Retired: authentication used server-side session cookies.',
      type: 'decision_history',
      status: 'archived',
      archive_reason: 'Replaced by the JWT access-token approach in mem_c09.',
    },
    'Authentication previously relied on server-side session cookies. This approach has been replaced.',
  ),
  fixture(
    {
      id: 'mem_c09',
      title: 'Current auth approach using JWT access tokens',
      description:
        'Authentication uses short-lived JWT access tokens with rotating refresh tokens.',
      type: 'decision_history',
      provenance: { source: 'user_stated', verification: 'user_confirmed' },
    },
    'Authentication now uses short-lived JWT access tokens with refresh tokens rotated on use.',
  ),
  fixture(
    {
      id: 'mem_c10',
      title: 'Customer portal caching strategy',
      description: 'The portal caches entitlement lookups for five minutes.',
      type: 'decision_history',
      scope: PORTAL,
    },
    'The customer portal caches entitlement lookups for five minutes to reduce billing service load.',
  ),
  fixture(
    {
      id: 'mem_c11',
      title: 'Billing service caching strategy',
      description:
        'Billing caches invoice documents for sixty seconds behind an invalidation hook.',
      type: 'decision_history',
    },
    'The billing service caches invoice documents for sixty seconds behind an explicit invalidation hook.',
  ),
  fixture(
    {
      id: 'mem_c12',
      title: 'Rate limiting for the public API',
      description: 'The public API uses a per-key token bucket with a burst allowance.',
      type: 'decision_history',
      scope: BOTH,
    },
    'The public API enforces a token bucket rate limit per API key with burst allowance.',
  ),
  fixture(
    {
      id: 'mem_c13',
      title: 'On-call triage runbook for delivery lag',
      description: 'What to check when the on-call alarm for email webhook lag fires.',
      type: 'debugging_pattern',
      scope: BOTH,
    },
    'Runbook steps to follow when the on-call alarm for email webhook lag fires during an incident.',
  ),
  fixture(
    {
      id: 'mem_c14',
      title: 'Preferred error format across services',
      description: 'Every service returns a code, a message, and optional details.',
      type: 'preference',
      scope: BOTH,
    },
    'All services return errors as a code, message, and optional details object for a consistent contract.',
  ),
  fixture(
    {
      id: 'mem_c15',
      title: 'Deprecated reporting pipeline',
      description: 'Retired: the old reporting pipeline went away with the warehouse migration.',
      type: 'product_rationale',
      status: 'archived',
      archive_reason: 'The pipeline was removed after the warehouse migration.',
    },
    'The old reporting pipeline was removed after the warehouse migration and should not be reintroduced.',
  ),
  fixture(
    {
      id: 'mem_c16',
      title: 'Testing strategy for idempotent webhook processing',
      description:
        'Property tests replay duplicate webhook events to prove handlers stay idempotent.',
      type: 'decision_history',
      scope: BOTH,
    },
    'Property tests replay duplicate webhook events to prove handlers stay idempotent under redelivery.',
  ),
  // Global, so a projects-scoped search must not surface it: scope never widens.
  fixture(
    {
      id: 'mem_c17',
      title: 'Conventional commits with minimal bodies',
      description: 'The user wants conventional commit subjects and short bodies.',
      type: 'preference',
      scope: { kind: 'global' },
      provenance: { source: 'user_stated', verification: 'user_confirmed' },
    },
    'Commit subjects follow conventional commits; bodies stay short unless the change is large.',
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
  let home: string;
  let memoriesDir: string;
  let projectsDir: string;
  let index: MemoryIndex;

  function options() {
    return { index, projectsDir, defaultLimit: 5, maxLimit: 10 };
  }

  async function topIds(query: string, limit = 3, extra: Record<string, unknown> = {}) {
    const result = await searchMemories({ query, scope: BOTH, limit, ...extra }, options());
    return result.results.map((item) => item.id);
  }

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'memento-corpus-'));
    memoriesDir = join(home, 'memories');
    projectsDir = join(home, 'projects');
    mkdirSync(memoriesDir, { recursive: true });
    await seedProjects(projectsDir);

    for (const { record, body } of CORPUS) {
      const file = memoryFilename(record.id, record.title);
      writeFileSync(
        join(memoriesDir, file),
        serializeFrontmatter(orderMemoryMetadata(record), body),
      );
    }

    index = new MemoryIndex();
    const result = await rebuildIndex(index, memoriesDir);
    expect(result.skipped).toEqual([]);
    expect(result.indexed).toBe(CORPUS.length);
  });

  afterAll(() => {
    index.close();
    rmSync(home, { recursive: true, force: true });
  });

  test('expected memory is in the top 3 for at least 80% of queries', async () => {
    const misses: string[] = [];
    for (const { query, expect: expectedId } of QUERIES) {
      const ids = await topIds(query);
      if (!ids.includes(expectedId)) {
        misses.push(`${expectedId} not in top-3 for "${query}" (got ${ids.join(', ')})`);
      }
    }
    const passRate = (QUERIES.length - misses.length) / QUERIES.length;
    expect(passRate, misses.join('\n')).toBeGreaterThanOrEqual(0.8);
  });

  test('an archived memory does not rank above its active replacement', async () => {
    const ids = await topIds('authentication approach', 10, { status: ['active', 'archived'] });
    expect(ids).toContain('mem_c09');
    expect(ids.indexOf('mem_c09')).toBeLessThan(
      ids.indexOf('mem_c08') === -1 ? Number.MAX_SAFE_INTEGER : ids.indexOf('mem_c08'),
    );
  });

  test('archived memories stay out of default results', async () => {
    expect(await topIds('reporting pipeline warehouse', 5)).not.toContain('mem_c15');
  });

  test('a projects search never surfaces a global memory', async () => {
    expect(await topIds('conventional commits', 5)).not.toContain('mem_c17');

    const global = await searchMemories(
      { query: 'conventional commits', scope: { kind: 'global' } },
      options(),
    );
    expect(global.results.map((item) => item.id)).toEqual(['mem_c17']);
  });

  test('results carry enough context to decide whether to read', async () => {
    const result = await searchMemories(
      { query: 'billing service customer portal', scope: BOTH },
      options(),
    );
    const [top] = result.results;
    expect(top!.title.length).toBeGreaterThan(0);
    expect(top!.description.length).toBeGreaterThan(0);
    expect(top!.score).toBeGreaterThan(0);
  });
});
