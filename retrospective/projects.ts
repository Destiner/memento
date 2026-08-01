import { resolveProject, type ResolveProjectResult } from '../src/store/project-resolve.js';
import type { NormalizedSession, ProjectResolutionHints } from './model.js';

export type SessionProjectResolution =
  | {
      sessionId: string;
      outcome: 'exact_match';
      matchedOn: string;
      projectId: string;
    }
  | {
      sessionId: string;
      outcome: 'candidates';
      matchedOn: string;
      projectIds: string[];
    }
  | { sessionId: string; outcome: 'not_found' | 'no_evidence' };

export interface ResolveSessionProjectsResult {
  sessions: NormalizedSession[];
  resolutions: SessionProjectResolution[];
}

/**
 * Resolve raw, process-local checkout evidence before it is discarded.
 *
 * Returned sessions contain only redacted/bounded labels, normalized remotes,
 * repository slugs, and opaque project ids. Raw paths stay in the caller-owned
 * hints map and are never copied into normalized context.
 */
export async function resolveSessionProjects(
  sessions: readonly NormalizedSession[],
  hintsBySessionId: Readonly<Record<string, readonly ProjectResolutionHints[]>>,
  projectsDir: string,
): Promise<ResolveSessionProjectsResult> {
  const resolvedSessions: NormalizedSession[] = [];
  const resolutions: SessionProjectResolution[] = [];

  for (const session of sessions) {
    const existing = session.projectContext?.projectIds;
    if (existing && existing.length > 0) {
      resolvedSessions.push(copySession(session));
      resolutions.push({
        sessionId: session.id,
        outcome: 'exact_match',
        matchedOn: 'normalized_context',
        projectId: existing[0]!,
      });
      continue;
    }

    const inputs = (hintsBySessionId[session.id] ?? [])
      .map(resolutionInput)
      .filter((input) => input !== undefined);
    if (inputs.length === 0) {
      resolvedSessions.push(
        markResolutionIncomplete(
          copySession(session, 'Project resolution skipped: no usable evidence.'),
        ),
      );
      resolutions.push({ sessionId: session.id, outcome: 'no_evidence' });
      continue;
    }

    const sessionResolutions: ResolveProjectResult[] = [];
    for (const input of inputs) {
      sessionResolutions.push(await resolveProject(input, { projectsDir }));
    }
    resolvedSessions.push(applyResolutions(session, sessionResolutions));
    resolutions.push(
      ...sessionResolutions.map((resolution) => toResolution(session.id, resolution)),
    );
  }

  return { sessions: resolvedSessions, resolutions };
}

function resolutionInput(hints: ProjectResolutionHints | undefined):
  | {
      working_directory?: string;
      git_remote?: string;
      repository_slug?: string;
      name_hint?: string;
    }
  | undefined {
  if (hints === undefined) return undefined;
  const input = {
    ...(hints.workingDirectory ? { working_directory: hints.workingDirectory } : {}),
    ...(hints.gitRemote ? { git_remote: hints.gitRemote } : {}),
    ...(hints.repositorySlug ? { repository_slug: hints.repositorySlug } : {}),
    ...(hints.nameHint ? { name_hint: hints.nameHint } : {}),
  };
  return Object.keys(input).length === 0 ? undefined : input;
}

function applyResolutions(
  session: NormalizedSession,
  resolutions: readonly ResolveProjectResult[],
): NormalizedSession {
  const projectIds = [
    ...new Set([
      ...(session.projectContext?.projectIds ?? []),
      ...resolutions.flatMap((resolution) =>
        resolution.outcome === 'exact_match' ? [resolution.project.id] : [],
      ),
    ]),
  ].sort();
  const warnings = resolutions.flatMap((resolution) =>
    resolution.outcome === 'candidates'
      ? [
          `Project resolution is ambiguous (${resolution.candidates.length} candidates matched on ${resolution.matched_on}).`,
        ]
      : resolution.outcome === 'not_found'
        ? ['Project resolution found no registered project.']
        : [],
  );
  let output = copySession(session);
  if (projectIds.length > 0) {
    output = { ...output, projectContext: { ...output.projectContext, projectIds } };
  }
  for (const warning of warnings) output = copySession(output, warning);
  if (resolutions.some((resolution) => resolution.outcome !== 'exact_match')) {
    output = markResolutionIncomplete(output);
  }
  return output;
}

function markResolutionIncomplete(session: NormalizedSession): NormalizedSession {
  return {
    ...session,
    projectContext: {
      ...session.projectContext,
      projectResolutionIncomplete: true,
    },
  };
}

function toResolution(
  sessionId: string,
  resolution: ResolveProjectResult,
): SessionProjectResolution {
  if (resolution.outcome === 'exact_match') {
    return {
      sessionId,
      outcome: 'exact_match',
      matchedOn: resolution.matched_on,
      projectId: resolution.project.id,
    };
  }
  if (resolution.outcome === 'candidates') {
    return {
      sessionId,
      outcome: 'candidates',
      matchedOn: resolution.matched_on,
      projectIds: resolution.candidates.map((candidate) => candidate.id),
    };
  }
  return { sessionId, outcome: 'not_found' };
}

function copySession(session: NormalizedSession, warning?: string): NormalizedSession {
  return {
    ...session,
    threads: session.threads.map((thread) => ({ ...thread })),
    events: session.events.map((event) => ({
      ...event,
      ...(event.toolCall ? { toolCall: { ...event.toolCall } } : {}),
    })),
    actualOperations: session.actualOperations.map((operation) => ({ ...operation })),
    warnings: warning === undefined ? [...session.warnings] : [...session.warnings, warning],
    ...(session.projectContext ? { projectContext: { ...session.projectContext } } : {}),
  };
}
