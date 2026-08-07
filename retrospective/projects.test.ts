import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createProject } from '../src/store/project-create.js';
import type { NormalizedSession } from './model.js';
import { resolveSessionProjects } from './projects.js';

describe('resolveSessionProjects', () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  it('turns process-local checkout evidence into an opaque project id', async () => {
    const root = await temporaryDirectory();
    const projectsDir = join(root, 'projects');
    const checkout = join(root, 'work', 'memento');
    await mkdir(checkout, { recursive: true });
    await createProject(
      {
        name: 'Memento',
        description: 'Coding-agent memory.',
        working_directories: [checkout],
      },
      { projectsDir, makeId: () => 'prj_MEMENTO' },
    );

    const session = normalizedSession();
    const result = await resolveSessionProjects(
      [session],
      { [session.id]: [{ workingDirectory: checkout, nameHint: 'memento' }] },
      projectsDir,
    );

    expect(result.resolutions).toEqual([
      {
        sessionId: session.id,
        outcome: 'exact_match',
        matchedOn: 'working_directory',
        projectId: 'prj_MEMENTO',
      },
    ]);
    expect(result.sessions[0]?.projectContext).toEqual({
      workingDirectory: '[REDACTED:PATH]',
      projectIds: ['prj_MEMENTO'],
    });
    expect(JSON.stringify(result.sessions)).not.toContain(checkout);
  });

  it('keeps an unresolved session usable but explicit', async () => {
    const root = await temporaryDirectory();
    const session = normalizedSession();
    const result = await resolveSessionProjects([session], {}, join(root, 'projects'));

    expect(result.resolutions).toEqual([{ sessionId: session.id, outcome: 'no_evidence' }]);
    expect(result.sessions[0]?.warnings).toContain(
      'Project resolution skipped: no usable evidence.',
    );
  });

  it('resolves every distinct checkout represented by a multi-project session', async () => {
    const root = await temporaryDirectory();
    const projectsDir = join(root, 'projects');
    const apiCheckout = join(root, 'work', 'api');
    const webCheckout = join(root, 'work', 'web');
    await Promise.all([
      createProject(
        {
          name: 'API',
          description: 'Backend service.',
          working_directories: [apiCheckout],
        },
        { projectsDir, makeId: () => 'prj_API' },
      ),
      createProject(
        {
          name: 'Web',
          description: 'Frontend application.',
          working_directories: [webCheckout],
        },
        { projectsDir, makeId: () => 'prj_WEB' },
      ),
    ]);
    const session = normalizedSession();

    const result = await resolveSessionProjects(
      [session],
      {
        [session.id]: [
          { workingDirectory: apiCheckout, nameHint: 'api' },
          { workingDirectory: webCheckout, nameHint: 'web' },
        ],
      },
      projectsDir,
    );

    expect(result.sessions[0]?.projectContext?.projectIds).toEqual(['prj_API', 'prj_WEB']);
    expect(result.resolutions).toEqual([
      {
        sessionId: session.id,
        outcome: 'exact_match',
        matchedOn: 'working_directory',
        projectId: 'prj_API',
      },
      {
        sessionId: session.id,
        outcome: 'exact_match',
        matchedOn: 'working_directory',
        projectId: 'prj_WEB',
      },
    ]);
  });

  it('marks a multi-project resolution incomplete when any checkout is unresolved', async () => {
    const root = await temporaryDirectory();
    const projectsDir = join(root, 'projects');
    const apiCheckout = join(root, 'work', 'api');
    const unknownCheckout = join(root, 'work', 'unknown');
    await createProject(
      {
        name: 'API',
        description: 'Backend service.',
        working_directories: [apiCheckout],
      },
      { projectsDir, makeId: () => 'prj_API' },
    );
    const session = normalizedSession();

    const result = await resolveSessionProjects(
      [session],
      {
        [session.id]: [
          { workingDirectory: apiCheckout, nameHint: 'api' },
          { workingDirectory: unknownCheckout, nameHint: 'unknown' },
        ],
      },
      projectsDir,
    );

    expect(result.sessions[0]?.projectContext).toMatchObject({
      projectIds: ['prj_API'],
      projectResolutionIncomplete: true,
    });
    expect(result.resolutions.map((resolution) => resolution.outcome)).toEqual([
      'exact_match',
      'not_found',
    ]);
  });

  it('scopes a session started above several checkouts to the projects beneath it', async () => {
    const root = await temporaryDirectory();
    const projectsDir = join(root, 'projects');
    const workspace = join(root, 'work');
    await mkdir(join(workspace, 'api'), { recursive: true });
    await mkdir(join(workspace, 'web'), { recursive: true });
    await createProject(
      {
        name: 'API',
        description: 'Backend service.',
        working_directories: [join(workspace, 'api')],
      },
      { projectsDir, makeId: () => 'prj_API' },
    );
    await createProject(
      {
        name: 'Web',
        description: 'Frontend application.',
        working_directories: [join(workspace, 'web')],
      },
      { projectsDir, makeId: () => 'prj_WEB' },
    );
    const session = normalizedSession();

    const result = await resolveSessionProjects(
      [session],
      { [session.id]: [{ workingDirectory: workspace, nameHint: 'work' }] },
      projectsDir,
    );

    // The candidate set is real project ids rather than `unresolved_projects`,
    // but stays flagged incomplete: an unregistered checkout could also live here.
    expect(result.sessions[0]?.projectContext).toMatchObject({
      projectIds: ['prj_API', 'prj_WEB'],
      projectResolutionIncomplete: true,
    });
    expect(result.resolutions).toContainEqual({
      sessionId: session.id,
      outcome: 'descendant_candidates',
      matchedOn: 'working_directory_descendants',
      projectIds: ['prj_API', 'prj_WEB'],
    });
    expect(result.sessions[0]?.warnings.join(' ')).toContain('may be incomplete');
  });

  it('prefers a checkout match over the projects beneath it', async () => {
    const root = await temporaryDirectory();
    const projectsDir = join(root, 'projects');
    const monorepo = join(root, 'work', 'monorepo');
    await mkdir(join(monorepo, 'packages', 'api'), { recursive: true });
    await createProject(
      { name: 'Monorepo', description: 'The repository root.', working_directories: [monorepo] },
      { projectsDir, makeId: () => 'prj_ROOT' },
    );
    await createProject(
      {
        name: 'API',
        description: 'A package inside the monorepo.',
        working_directories: [join(monorepo, 'packages', 'api')],
      },
      { projectsDir, makeId: () => 'prj_API' },
    );
    const session = normalizedSession();

    const result = await resolveSessionProjects(
      [session],
      { [session.id]: [{ workingDirectory: monorepo, nameHint: 'monorepo' }] },
      projectsDir,
    );

    // The directory is itself registered, so the descendant pass never runs and
    // the nested package does not widen the scope.
    expect(result.sessions[0]?.projectContext).toMatchObject({ projectIds: ['prj_ROOT'] });
    expect(result.sessions[0]?.projectContext?.projectResolutionIncomplete).toBeUndefined();
    expect(result.resolutions.map((resolution) => resolution.outcome)).toEqual(['exact_match']);
  });

  it('adds no candidates when nothing is registered beneath the directory', async () => {
    const root = await temporaryDirectory();
    const projectsDir = join(root, 'projects');
    const elsewhere = join(root, 'elsewhere');
    await mkdir(elsewhere, { recursive: true });
    await createProject(
      {
        name: 'API',
        description: 'Backend service.',
        working_directories: [join(root, 'work', 'api')],
      },
      { projectsDir, makeId: () => 'prj_API' },
    );
    const session = normalizedSession();

    const result = await resolveSessionProjects(
      [session],
      { [session.id]: [{ workingDirectory: elsewhere }] },
      projectsDir,
    );

    expect(result.sessions[0]?.projectContext?.projectIds).toBeUndefined();
    expect(result.resolutions.map((resolution) => resolution.outcome)).toEqual(['not_found']);
  });

  async function temporaryDirectory(): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), 'memento-retrospective-projects-'));
    temporaryDirectories.push(path);
    return path;
  }
});

function normalizedSession(): NormalizedSession {
  return {
    schemaVersion: 1,
    id: 'ses_test',
    client: 'codex',
    sourceSessionIds: ['source-session'],
    sourceIds: ['src_test'],
    rootThreadId: 'thr_test',
    threads: [{ id: 'thr_test', sourceSessionId: 'source-session' }],
    events: [],
    actualOperations: [],
    policyVersion: 'unknown',
    projectContext: { workingDirectory: '[REDACTED:PATH]' },
    warnings: [],
  };
}
