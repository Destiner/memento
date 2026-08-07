import { normalizeWorkingDirectory, workingDirectoryKey } from '../src/store/project-normalize.js';
import { loadProjectRegistry, projectDirectoryKeys } from '../src/store/project-registry.js';
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
  | {
      sessionId: string;
      outcome: 'descendant_candidates';
      matchedOn: 'working_directory_descendants';
      projectIds: string[];
    }
  | { sessionId: string; outcome: 'not_found' | 'no_evidence' };

/**
 * Cap on the candidate set a single ancestor directory may contribute.
 *
 * An ancestor match is weaker evidence than the tiers `resolve_project` reports,
 * and a very high directory (a home directory, a filesystem root) sits above
 * every checkout at once. The cap keeps one such hint from filling an evaluator
 * request with the whole registry; truncation is always reported as a warning
 * rather than applied silently.
 */
export const MAX_DESCENDANT_PROJECTS = 25;

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
    const descendantIds = new Set<string>();
    let omittedDescendants = 0;
    for (const input of inputs) {
      const resolution = await resolveProject(input, { projectsDir });
      sessionResolutions.push(resolution);

      // Only reach for the weaker ancestor signal when the registry could not
      // name a single project from the evidence it does understand.
      if (resolution.outcome === 'exact_match' || input.working_directory === undefined) continue;
      const descendants = await descendantProjectIds(input.working_directory, projectsDir);
      for (const id of descendants.ids) descendantIds.add(id);
      omittedDescendants += descendants.omitted;
    }

    const descendants = [...descendantIds].sort();
    resolvedSessions.push(
      applyResolutions(session, sessionResolutions, descendants, omittedDescendants),
    );
    resolutions.push(
      ...sessionResolutions.map((resolution) => toResolution(session.id, resolution)),
    );
    if (descendants.length > 0) {
      resolutions.push({
        sessionId: session.id,
        outcome: 'descendant_candidates',
        matchedOn: 'working_directory_descendants',
        projectIds: descendants,
      });
    }
  }

  return { sessions: resolvedSessions, resolutions };
}

/**
 * Registered checkouts strictly beneath `directory`.
 *
 * `resolve_project` reports the containing project when a caller stands inside a
 * registered checkout, but has no tier for a caller standing above several — so
 * a session started in a directory that holds many checkouts falls through to
 * the fuzzy-name tier and resolves as ambiguous. The projects underneath are the
 * honest candidate set for such a session: better evidence than a name that
 * happens to look similar, and weaker than a checkout match, which is why the
 * caller keeps `projectResolutionIncomplete` set.
 */
async function descendantProjectIds(
  directory: string,
  projectsDir: string,
): Promise<{ ids: string[]; omitted: number }> {
  let key: string;
  try {
    key = workingDirectoryKey(await normalizeWorkingDirectory(directory));
  } catch {
    // An unusable hint (empty, relative) is no evidence, not a failure.
    return { ids: [], omitted: 0 };
  }
  const boundary = key.endsWith('/') ? key : `${key}/`;

  const registry = await loadProjectRegistry(projectsDir);
  const ids = registry.active
    .filter((entry) =>
      projectDirectoryKeys(entry.record).some(
        (candidate) => candidate !== key && candidate.startsWith(boundary),
      ),
    )
    .map((entry) => entry.record.id)
    .sort();

  return {
    ids: ids.slice(0, MAX_DESCENDANT_PROJECTS),
    omitted: Math.max(0, ids.length - MAX_DESCENDANT_PROJECTS),
  };
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
  descendantIds: readonly string[] = [],
  omittedDescendants = 0,
): NormalizedSession {
  const projectIds = [
    ...new Set([
      ...(session.projectContext?.projectIds ?? []),
      ...resolutions.flatMap((resolution) =>
        resolution.outcome === 'exact_match' ? [resolution.project.id] : [],
      ),
      ...descendantIds,
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
  if (descendantIds.length > 0) {
    warnings.push(
      `Project scope inferred from ${descendantIds.length} registered checkout(s) beneath the ` +
        'session working directory; the set may be incomplete.',
    );
  }
  if (omittedDescendants > 0) {
    warnings.push(
      `${omittedDescendants} further project(s) beneath the session working directory were ` +
        `omitted at the ${MAX_DESCENDANT_PROJECTS}-project cap.`,
    );
  }
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
