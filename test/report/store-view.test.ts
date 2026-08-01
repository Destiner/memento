import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { LoggedEvent } from '../../src/logging/events.js';
import { computeMetrics } from '../../src/report/metrics.js';
import { loadStoreView, STALE_AFTER_DAYS } from '../../src/report/store-view.js';
import { serializeFrontmatter } from '../../src/store/frontmatter.js';
import { orderMemoryMetadata } from '../../src/store/memory-fields.js';
import { memoryRecord, PROJECT_A, seedProjects } from '../helpers/memories.js';

const NOW = Date.UTC(2026, 6, 4);
const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (days: number): string => new Date(NOW - days * DAY_MS).toISOString();

const tempDirs: string[] = [];

async function makeStore(): Promise<{ memoriesDir: string; projectsDir: string }> {
  const home = await mkdtemp(join(tmpdir(), 'memento-store-view-'));
  tempDirs.push(home);
  const memoriesDir = join(home, 'memories');
  const projectsDir = join(home, 'projects');
  await mkdir(memoriesDir, { recursive: true });
  await seedProjects(projectsDir, [PROJECT_A]);
  return { memoriesDir, projectsDir };
}

async function writeMemory(
  memoriesDir: string,
  overrides: Parameters<typeof memoryRecord>[0],
): Promise<void> {
  const record = memoryRecord(overrides);
  const raw = serializeFrontmatter(orderMemoryMetadata(record), 'Body text.');
  await writeFile(join(memoriesDir, `${record.id}-fixture.md`), raw, 'utf8');
}

// A get_memory event for `id`, which is what makes a memory count as retrieved.
function readEvent(id: string): LoggedEvent {
  return {
    event_id: `evt_${id}`,
    timestamp: '2026-07-03T10:00:00Z',
    session_id: 'ses_X',
    tool: 'get_memory',
    outcome: 'success',
    latency_ms: 4,
    memory_id: id,
    server_version: '0.3.2',
    policy_version: '2.1.0',
    variant: 'shipped-v2',
    log_schema_version: 2,
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('loadStoreView', () => {
  it('resolves opaque project ids to names for the dashboard', async () => {
    const store = await makeStore();
    const view = await loadStoreView(computeMetrics([]), { ...store, now: NOW });
    expect(view.projectNames[PROJECT_A]).toBe('Alpha');
  });

  it('counts active and archived memories separately', async () => {
    const store = await makeStore();
    await writeMemory(store.memoriesDir, { id: 'mem_ACTIVE01' });
    await writeMemory(store.memoriesDir, {
      id: 'mem_ARCHIVE1',
      status: 'archived',
      archive_reason: 'Superseded by the retry-budget decision.',
    });

    const view = await loadStoreView(computeMetrics([]), { ...store, now: NOW });
    expect(view.totalMemories).toBe(2);
    expect(view.activeMemories).toBe(1);
    expect(view.archivedMemories).toBe(1);
    expect(view.archivedRate).toBe(0.5);
  });

  it('joins against the full read set, not just the top ten', async () => {
    const store = await makeStore();
    const ids = Array.from({ length: 12 }, (_, i) => `mem_READ${String(i).padStart(6, '0')}`);
    for (const id of ids) await writeMemory(store.memoriesDir, { id });

    // Every memory read once: topRetrieved caps at ten, so a store view built
    // from that list alone would call the last two "never retrieved".
    const metrics = computeMetrics(ids.map(readEvent));
    expect(metrics.reuse.topRetrieved).toHaveLength(10);

    const view = await loadStoreView(metrics, { ...store, now: NOW });
    expect(view.neverRetrieved).toBe(0);
    expect(view.neverRetrievedRate).toBe(0);
  });

  it('flags an old, unread memory as stale but spares one that was read', async () => {
    const store = await makeStore();
    await writeMemory(store.memoriesDir, {
      id: 'mem_OLDUNREAD',
      title: 'Nobody has opened this',
      updated_at: daysAgo(STALE_AFTER_DAYS + 5),
    });
    await writeMemory(store.memoriesDir, {
      id: 'mem_OLDBUTREAD',
      title: 'Old but still consulted',
      updated_at: daysAgo(STALE_AFTER_DAYS + 5),
    });
    await writeMemory(store.memoriesDir, {
      id: 'mem_RECENT001',
      title: 'Written last week',
      updated_at: daysAgo(7),
    });

    const view = await loadStoreView(computeMetrics([readEvent('mem_OLDBUTREAD')]), {
      ...store,
      now: NOW,
    });
    expect(view.staleMemories.map((m) => m.id)).toEqual(['mem_OLDUNREAD']);
    expect(view.neverRetrieved).toBe(2);
  });

  it('never lets an archived memory count as stale', async () => {
    const store = await makeStore();
    await writeMemory(store.memoriesDir, {
      id: 'mem_ARCHOLD1',
      status: 'archived',
      archive_reason: 'Wrong: the retry budget was never raised.',
      updated_at: daysAgo(STALE_AFTER_DAYS * 2),
    });

    const view = await loadStoreView(computeMetrics([]), { ...store, now: NOW });
    expect(view.staleMemories).toEqual([]);
    expect(view.neverRetrieved).toBe(0);
  });

  it('skips an unreadable file instead of failing the whole report', async () => {
    const store = await makeStore();
    await writeMemory(store.memoriesDir, { id: 'mem_GOOD0001' });
    await writeFile(join(store.memoriesDir, 'broken.md'), 'not front matter at all', 'utf8');

    const view = await loadStoreView(computeMetrics([]), { ...store, now: NOW });
    expect(view.totalMemories).toBe(1);
    expect(view.unreadableFiles).toEqual(['broken.md']);
  });

  it('reports an empty store rather than throwing', async () => {
    const home = await mkdtemp(join(tmpdir(), 'memento-store-view-empty-'));
    tempDirs.push(home);
    const view = await loadStoreView(computeMetrics([]), {
      memoriesDir: join(home, 'memories'),
      projectsDir: join(home, 'projects'),
      now: NOW,
    });
    expect(view.totalMemories).toBe(0);
    expect(view.archivedRate).toBe(0);
    expect(view.neverRetrievedRate).toBe(0);
    expect(view.projectNames).toEqual({});
  });
});
