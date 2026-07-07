// Claude Code settings for a rep (harness-spec §7.2 step 2). The base settings
// pre-allow every Memento tool so retrieval/capture never stalls on a permission
// prompt — permission friction auto-denies headless and is a deferred knob
// (§3.2), so Phase 1 pre-allows and measures propensity, not gatekeeping.
//
// A config may ship a settings fragment (its install.settings) carrying the
// hooks and any extra permissions its knob needs (SessionStart/UserPromptSubmit/
// Stop, §3.2); it is deep-merged over the base so the runner owns the floor and
// the config owns its knob. Objects merge, arrays concatenate (so a fragment's
// permission rules add to, not replace, the memento allowance).

// Allows every mcp__memento__* tool with one rule (Claude Code prefix match).
const MEMENTO_ALLOW = 'mcp__memento';

export interface SettingsOptions {
  mementoRegistered: boolean;
  fragment?: Record<string, unknown>;
}

export function generateSettings(opts: SettingsOptions): Record<string, unknown> {
  const base: Record<string, unknown> = {
    permissions: { allow: opts.mementoRegistered ? [MEMENTO_ALLOW] : [] },
  };
  return opts.fragment ? deepMerge(base, opts.fragment) : base;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Merge `over` onto `base`: objects merge recursively, arrays concat, else override. */
export function deepMerge(
  base: Record<string, unknown>,
  over: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const existing = out[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
      out[key] = deepMerge(existing, value);
    } else if (Array.isArray(existing) && Array.isArray(value)) {
      out[key] = [...existing, ...value];
    } else {
      out[key] = value;
    }
  }
  return out;
}
