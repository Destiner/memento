import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { parseClaudeCodeHistory, parseCodexHistory } from './adapters/index.js';
import type { ParsedHistoryThread } from './adapters/types.js';
import { sessionId, threadId } from './adapters/common.js';
import {
  NORMALIZED_SCHEMA_VERSION,
  type IngestionResult,
  type InternalSourceReference,
  type NormalizedSession,
  type NormalizedThread,
  type ProjectContext,
  type ProjectResolutionHints,
} from './model.js';
import { discoverHistorySources, type DiscoveryOptions, type HistorySource } from './discover.js';

export interface IngestOptions {
  sources: HistorySource[];
}

export async function ingestDefaultHistories(
  options: DiscoveryOptions = {},
): Promise<IngestionResult> {
  const discovery = await discoverHistorySources(options);
  const result = await ingestHistorySources({ sources: discovery.sources });
  result.warnings.unshift(...discovery.warnings);
  return result;
}

export async function ingestHistorySources(options: IngestOptions): Promise<IngestionResult> {
  const parsed: ParsedHistoryThread[] = [];
  const sourceReferences: InternalSourceReference[] = [];
  const quarantined: IngestionResult['quarantined'] = [];
  const warnings: string[] = [];
  const sources = deduplicateSources(options.sources);

  for (const source of sources) {
    let bytes: Buffer;
    try {
      bytes = await readFile(source.path);
    } catch (error) {
      quarantined.push({
        sourceId: source.id,
        client: source.client,
        reason: `Could not read source: ${(error as NodeJS.ErrnoException).code ?? 'unknown error'}`,
      });
      continue;
    }
    sourceReferences.push({
      sourceId: source.id,
      client: source.client,
      path: source.path,
      contentSha256: fingerprintHistoryContent(bytes),
    });
    const raw = bytes.toString('utf8');

    try {
      const thread =
        source.client === 'claude-code'
          ? parseClaudeCodeHistory(raw, { sourceId: source.id, sourcePathHint: source.path })
          : parseCodexHistory(raw, { sourceId: source.id, sourcePathHint: source.path });
      if (thread) parsed.push(thread);
      else warnings.push(`${source.id}: empty history skipped`);
    } catch (error) {
      quarantined.push({
        sourceId: source.id,
        client: source.client,
        reason: sanitizeError(error),
      });
    }
  }

  const sessions = mergeParsedThreads(parsed);
  return {
    sessions,
    sources: sourceReferences.sort((left, right) => left.sourceId.localeCompare(right.sourceId)),
    projectResolutionHints: mergeResolutionHints(parsed),
    quarantined,
    warnings,
  };
}

export function fingerprintHistoryContent(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

export function mergeParsedThreads(parsed: ParsedHistoryThread[]): NormalizedSession[] {
  const groups = new Map<string, ParsedHistoryThread[]>();
  for (const source of parsed) {
    const key = `${source.client}\0${source.rootSourceSessionId}`;
    const group = groups.get(key) ?? [];
    group.push(source);
    groups.set(key, group);
  }

  const sessions = [...groups.values()].map(mergeSession);
  return sessions.sort((left, right) => {
    const time = (left.startedAt ?? '').localeCompare(right.startedAt ?? '');
    return time || left.id.localeCompare(right.id);
  });
}

function mergeResolutionHints(
  parsed: ParsedHistoryThread[],
): Record<string, ProjectResolutionHints[]> {
  const output: Record<string, ProjectResolutionHints[]> = {};
  const ordered = [...parsed].sort((left, right) => {
    const rootOrder =
      Number(left.sourceSessionId !== left.rootSourceSessionId) -
      Number(right.sourceSessionId !== right.rootSourceSessionId);
    return rootOrder || left.sourceId.localeCompare(right.sourceId);
  });
  for (const source of ordered) {
    if (!source.projectResolutionHints) continue;
    const normalizedSessionId = sessionId(source.client, source.rootSourceSessionId);
    const hints = output[normalizedSessionId] ?? [];
    if (
      !hints.some((candidate) => sameResolutionHints(candidate, source.projectResolutionHints!))
    ) {
      hints.push({ ...source.projectResolutionHints });
    }
    output[normalizedSessionId] = hints;
  }
  return output;
}

function sameResolutionHints(left: ProjectResolutionHints, right: ProjectResolutionHints): boolean {
  return (
    left.workingDirectory === right.workingDirectory &&
    left.gitRemote === right.gitRemote &&
    left.repositorySlug === right.repositorySlug &&
    left.nameHint === right.nameHint
  );
}

function mergeSession(sources: ParsedHistoryThread[]): NormalizedSession {
  const orderedSources = [...sources].sort((left, right) => {
    const rootOrder =
      Number(left.sourceSessionId !== left.rootSourceSessionId) -
      Number(right.sourceSessionId !== right.rootSourceSessionId);
    return rootOrder || left.sourceId.localeCompare(right.sourceId);
  });
  const first = orderedSources[0];
  if (!first) throw new Error('Cannot merge an empty session group.');

  const rootThreadId = threadId(first.client, first.rootSourceSessionId);
  const threadsById = new Map<string, NormalizedThread>();
  for (const source of orderedSources) threadsById.set(source.thread.id, source.thread);
  if (!threadsById.has(rootThreadId)) {
    threadsById.set(rootThreadId, {
      id: rootThreadId,
      sourceSessionId: first.rootSourceSessionId,
    });
  }

  const events = orderedSources.flatMap((source) => source.events);
  events.sort((left, right) => {
    const timestamp = (left.timestamp ?? '9999').localeCompare(right.timestamp ?? '9999');
    if (timestamp !== 0) return timestamp;
    const thread = left.threadId.localeCompare(right.threadId);
    if (thread !== 0) return thread;
    return left.sequence - right.sequence || left.id.localeCompare(right.id);
  });
  const sequenceByEventId = new Map<string, number>();
  for (const [sequence, event] of events.entries()) {
    event.sequence = sequence;
    sequenceByEventId.set(event.id, sequence);
  }

  const actualOperations = orderedSources.flatMap((source) => source.actualOperations);
  for (const operation of actualOperations) {
    operation.sequence = sequenceByEventId.get(operation.callEventId) ?? operation.sequence;
  }
  actualOperations.sort(
    (left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id),
  );

  const timestamps = events.flatMap((event) => (event.timestamp ? [event.timestamp] : [])).sort();
  const rootSource =
    orderedSources.find((source) => source.sourceSessionId === source.rootSourceSessionId) ?? first;
  const observedModels = new Set(
    orderedSources.flatMap((source) => (source.model ? [source.model] : [])),
  );
  const model =
    observedModels.has('mixed') || observedModels.size > 1 ? 'mixed' : [...observedModels][0];
  const warnings = orderedSources
    .flatMap((source) => source.warnings.map((warning) => `${source.sourceId}: ${warning}`))
    .sort();

  return {
    schemaVersion: NORMALIZED_SCHEMA_VERSION,
    id: sessionId(first.client, first.rootSourceSessionId),
    client: first.client,
    sourceSessionIds: [...new Set(orderedSources.map((source) => source.sourceSessionId))].sort(),
    sourceIds: [...new Set(orderedSources.map((source) => source.sourceId))].sort(),
    rootThreadId,
    threads: [...threadsById.values()].sort((left, right) => {
      if (left.id === rootThreadId) return -1;
      if (right.id === rootThreadId) return 1;
      return left.id.localeCompare(right.id);
    }),
    events,
    actualOperations,
    ...(timestamps[0] ? { startedAt: timestamps[0] } : {}),
    ...(timestamps.at(-1) ? { endedAt: timestamps.at(-1) } : {}),
    ...(model ? { model } : {}),
    ...(rootSource.clientVersion ? { clientVersion: rootSource.clientVersion } : {}),
    policyVersion: 'unknown',
    ...mergedProjectContext(orderedSources),
    warnings,
  };
}

function mergedProjectContext(sources: ParsedHistoryThread[]): { projectContext?: ProjectContext } {
  const contexts = sources.flatMap((source) =>
    source.projectContext ? [source.projectContext] : [],
  );
  if (contexts.length === 0) return {};
  return {
    projectContext: {
      workingDirectory: contexts.find((context) => context.workingDirectory)?.workingDirectory,
      workingDirectoryName: contexts.find((context) => context.workingDirectoryName)
        ?.workingDirectoryName,
      gitRemote: contexts.find((context) => context.gitRemote)?.gitRemote,
      repositorySlug: contexts.find((context) => context.repositorySlug)?.repositorySlug,
      projectIds: [...new Set(contexts.flatMap((context) => context.projectIds ?? []))].sort(),
    },
  };
}

function deduplicateSources(sources: HistorySource[]): HistorySource[] {
  const byPath = new Map<string, HistorySource>();
  for (const source of sources) byPath.set(`${source.client}\0${source.path}`, source);
  return [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function sanitizeError(error: unknown): string {
  if (!(error instanceof Error)) return 'History ingestion failed safely.';
  return error.message
    .replace(/(?:\/[^\s:]+)+/g, '[REDACTED:PATH]')
    .replace(/[A-Za-z]:\\[^\s:]+/g, '[REDACTED:PATH]')
    .slice(0, 500);
}
