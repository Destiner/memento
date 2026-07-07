// Stub MCP server profiles for the crowded environment (harness-spec §7.3).
//
// The crowded arm reproduces the "deferred-tool discoverability pressure" of a
// real developer's machine: a handful of unrelated MCP servers whose many tools
// crowd the agent's tool list, making Memento's tools harder to notice and
// select. One stub server binary (`server.ts`) is instantiated once per profile
// below, each registered under the profile's `server` name and exposing that
// profile's no-op tools.
//
// The set is FIXED and version-controlled — never "whatever is on the machine"
// (§7.3) — so the crowded env is reproducible across runs. Profiles are modelled
// on peripheral services a coding agent would plausibly have connected but never
// needs to complete a local code-editing task (issue tracking, error monitoring,
// feature flags, product analytics). Deliberately excluded: source-control,
// filesystem, or shell-flavoured tools the agent might legitimately reach for and
// then hit a no-op — the stubs are pure distractors, not task hazards.

export interface StubTool {
  name: string;
  description: string;
}

export interface StubProfile {
  /** Catalog id (env selector: STUB_PROFILE). */
  id: string;
  /** MCP server name it registers under — the mcpServers key (§7.2 step 2). */
  server: string;
  tools: StubTool[];
}

const PROFILES: StubProfile[] = [
  {
    id: 'tracker',
    server: 'linear',
    tools: [
      {
        name: 'list_issues',
        description: 'List issues in a team, filterable by assignee and state.',
      },
      {
        name: 'get_issue',
        description: 'Fetch a single issue by identifier, with description and comments.',
      },
      {
        name: 'create_issue',
        description: 'Create an issue in a team with a title, description, and priority.',
      },
      {
        name: 'update_issue',
        description: "Update an issue's state, assignee, priority, or labels.",
      },
      { name: 'add_comment', description: 'Add a comment to an issue thread.' },
      { name: 'list_teams', description: 'List the teams in the workspace.' },
    ],
  },
  {
    id: 'errors',
    server: 'sentry',
    tools: [
      {
        name: 'list_issues',
        description: 'List unresolved error groups for a project, most frequent first.',
      },
      {
        name: 'get_issue',
        description: 'Get an error group with its latest event and stack trace.',
      },
      { name: 'resolve_issue', description: 'Mark an error group as resolved.' },
      { name: 'list_events', description: 'List recent captured events for an error group.' },
      { name: 'list_projects', description: 'List the projects monitored in the organization.' },
    ],
  },
  {
    id: 'flags',
    server: 'launchdarkly',
    tools: [
      { name: 'list_flags', description: 'List feature flags in a project and environment.' },
      {
        name: 'get_flag',
        description: 'Get a feature flag with its targeting rules and current state.',
      },
      { name: 'toggle_flag', description: 'Turn a feature flag on or off in an environment.' },
      { name: 'list_environments', description: 'List the environments configured for a project.' },
    ],
  },
  {
    id: 'analytics',
    server: 'posthog',
    tools: [
      {
        name: 'query_events',
        description: 'Query product events by name over a time range with filters.',
      },
      {
        name: 'get_insight',
        description: 'Fetch a saved insight (funnel, trend, or retention) by id.',
      },
      { name: 'list_dashboards', description: 'List analytics dashboards in the project.' },
      { name: 'list_persons', description: 'List tracked persons matching a property filter.' },
      {
        name: 'get_feature_usage',
        description: 'Report usage counts for a tracked feature over a period.',
      },
    ],
  },
];

/** All defined profiles, keyed by id. */
export const STUB_PROFILES: Record<string, StubProfile> = Object.fromEntries(
  PROFILES.map((profile) => [profile.id, profile]),
);

// The fixed, ordered set the crowded env instantiates (§7.3). Listed explicitly
// (rather than "all of STUB_PROFILES") so adding a profile to the catalog does
// not silently change what every crowded run registers.
export const CROWDED_PROFILES: readonly string[] = ['tracker', 'errors', 'flags', 'analytics'];

/** Resolve a profile by id; throws on an unknown id so a bad env fails loudly. */
export function getStubProfile(id: string): StubProfile {
  const profile = STUB_PROFILES[id];
  if (!profile) {
    const known = Object.keys(STUB_PROFILES).join(', ');
    throw new Error(`unknown stub profile "${id}" (known: ${known}).`);
  }
  return profile;
}
