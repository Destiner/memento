// A read-only pass over the memory store, joined with the event log at render
// time (v2.md §8).
//
// metrics.ts is deliberately pure over events and stays that way. Three things
// the report needs are simply not in the log, by design: what a project is
// *called* (the log carries opaque ids), what a retrieved memory is *about*, and
// which memories nobody ever read. The last one is the only way to see the
// failure the log cannot show — memory that accumulates and never comes back.
//
// Read-only and tolerant: a file that fails validation is skipped and counted,
// never fatal. This is an operator dashboard, not the store's consistency check.

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { parseFrontmatter } from '../store/frontmatter.js';
import { validateMemoryFrontmatter, type MemoryRecord } from '../store/memory-schema.js';
import { loadProjectRegistry } from '../store/project-registry.js';
import type { Metrics } from './metrics.js';

// A memory counts as stale when nothing has touched it for this long and no
// logged get_memory has read it in the window. Long enough that a genuinely
// durable memory is not nagged about, short enough that a wrong one surfaces
// within a release cycle or two. Tunable on evidence, pinned by a test.
export const STALE_AFTER_DAYS = 180;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface StaleMemory {
  id: string;
  title: string;
  type: string;
  updated_at: string;
}

export interface StoreView {
  // Opaque prj_ id → human name, so the dashboard can render project activity.
  projectNames: Record<string, string>;
  // Opaque mem_ id → title, for the top-retrieved list.
  memoryTitles: Record<string, string>;
  totalMemories: number;
  activeMemories: number;
  archivedMemories: number;
  archivedRate: number;
  // Active memories no logged get_memory ever returned. The honest denominator
  // is `activeMemories`, and the honest caveat is that it only counts reads
  // inside the log window.
  neverRetrieved: number;
  neverRetrievedRate: number;
  staleMemories: StaleMemory[];
  // Files under memories/ that failed to parse or validate, by filename.
  unreadableFiles: string[];
}

export interface StoreViewOptions {
  memoriesDir: string;
  projectsDir: string;
  now?: number;
}

/**
 * Build the store-side half of the report. `metrics` supplies which memory ids
 * were actually read, which is the join that makes "never retrieved" and
 * "stale" answerable at all.
 */
export async function loadStoreView(
  metrics: Metrics,
  options: StoreViewOptions,
): Promise<StoreView> {
  const now = options.now ?? Date.now();
  const { records, unreadableFiles } = await readMemories(options.memoriesDir);

  const projectNames: Record<string, string> = {};
  const registry = await loadProjectRegistry(options.projectsDir);
  for (const entry of registry.all) {
    projectNames[entry.record.id] = entry.record.name;
  }

  // The complete read set, not `topRetrieved` — that one is capped at ten, and
  // using it here would report every eleventh-most-read memory as never opened.
  const readIds = new Set(metrics.reuse.retrievedIds);

  const memoryTitles: Record<string, string> = {};
  const staleMemories: StaleMemory[] = [];
  let active = 0;
  let archived = 0;
  let neverRetrieved = 0;

  for (const record of records) {
    memoryTitles[record.id] = record.title;
    if (record.status === 'archived') {
      archived++;
      continue;
    }
    active++;
    const read = readIds.has(record.id);
    if (!read) neverRetrieved++;
    const ageDays = (now - Date.parse(record.updated_at)) / DAY_MS;
    if (!read && Number.isFinite(ageDays) && ageDays >= STALE_AFTER_DAYS) {
      staleMemories.push({
        id: record.id,
        title: record.title,
        type: record.type,
        updated_at: record.updated_at,
      });
    }
  }

  staleMemories.sort((a, b) => (a.updated_at < b.updated_at ? -1 : 1));

  return {
    projectNames,
    memoryTitles,
    totalMemories: records.length,
    activeMemories: active,
    archivedMemories: archived,
    archivedRate: rate(archived, records.length),
    neverRetrieved,
    neverRetrievedRate: rate(neverRetrieved, active),
    staleMemories,
    unreadableFiles,
  };
}

function rate(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return Math.round((numerator / denominator) * 100) / 100;
}

async function readMemories(
  memoriesDir: string,
): Promise<{ records: MemoryRecord[]; unreadableFiles: string[] }> {
  let filenames: string[];
  try {
    filenames = await readdir(memoriesDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { records: [], unreadableFiles: [] };
    }
    throw error;
  }

  const records: MemoryRecord[] = [];
  const unreadableFiles: string[] = [];
  for (const filename of filenames.filter((name) => name.endsWith('.md')).sort()) {
    try {
      const raw = await readFile(join(memoriesDir, filename), 'utf8');
      const { metadata } = parseFrontmatter(raw);
      records.push(validateMemoryFrontmatter(metadata));
    } catch {
      unreadableFiles.push(filename);
    }
  }
  return { records, unreadableFiles };
}
