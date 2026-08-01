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
