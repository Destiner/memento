import type { JsonValue } from './model.js';

export type RedactionKind =
  'secret' | 'path' | 'email' | 'url_credentials' | 'header' | 'pem' | 'provider_token';

export interface RedactionFinding {
  kind: RedactionKind;
  count: number;
}

export type RedactionResult<T> =
  | { ok: true; value: T; findings: RedactionFinding[] }
  | { ok: false; reason: string; findings: RedactionFinding[] };

export const MAX_NORMALIZED_TEXT_CHARS = 32_000;
export const MAX_JSON_STRING_CHARS = 16_000;
export const MAX_JSON_ARRAY_ITEMS = 200;
export const MAX_JSON_OBJECT_KEYS = 200;
export const MAX_JSON_DEPTH = 24;
export const MAX_JSON_SERIALIZED_CHARS = 128_000;

interface PatternDefinition {
  kind: RedactionKind;
  pattern: RegExp;
  replacement: string | ((substring: string, ...args: string[]) => string);
}

const PATTERNS: PatternDefinition[] = [
  {
    kind: 'pem',
    pattern:
      /-----BEGIN [A-Z0-9 ]*(?:PRIVATE KEY|CERTIFICATE)-----[\s\S]*?-----END [A-Z0-9 ]*(?:PRIVATE KEY|CERTIFICATE)-----/g,
    replacement: '[REDACTED:PEM]',
  },
  {
    kind: 'pem',
    pattern: /-----BEGIN [A-Z0-9 ]*(?:PRIVATE KEY|CERTIFICATE)-----[\s\S]*$/g,
    replacement: '[REDACTED:PEM]',
  },
  {
    kind: 'url_credentials',
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@[^\s]+/gi,
    replacement: (_match, scheme: string) => `${scheme}[REDACTED:URL_CREDENTIALS]`,
  },
  {
    kind: 'url_credentials',
    pattern:
      /([?&](?:access[_-]?token|auth[_-]?token|api[_-]?key|token|password|passwd|secret|signature|credential|x-amz-signature)=)(?!\[REDACTED:)[^&#\s"'<>]+/gi,
    replacement: (_match, prefix: string) => `${prefix}[REDACTED:URL_CREDENTIALS]`,
  },
  {
    kind: 'header',
    pattern:
      /\b(?:authorization|proxy-authorization|x-api-key|api-key|cookie|set-cookie)\s*:\s*[^\r\n]+/gi,
    replacement: '[REDACTED:HEADER]',
  },
  {
    kind: 'provider_token',
    pattern:
      /\b(?:sk-ant-[A-Za-z0-9_-]{12,}|sk-(?:proj-|live_|test_)?[A-Za-z0-9_-]{16,}|[sr]k_(?:live|test)_[A-Za-z0-9_-]{12,}|whsec_[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{12,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,}|hf_[A-Za-z0-9]{20,}|npm_[A-Za-z0-9]{20,}|SG\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,})\b/g,
    replacement: '[REDACTED:PROVIDER_TOKEN]',
  },
  {
    kind: 'email',
    pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    replacement: '[REDACTED:EMAIL]',
  },
  {
    kind: 'path',
    pattern:
      /(["'])((?:[A-Za-z]:\\|\\\\[^\\\r\n]+\\[^\\\r\n]+|~\/|\/(?:Users|home|root|private|tmp|var|opt|etc|mnt|srv|data|app|usr|Library|System|Applications|nix|Volumes|workspace|workspaces)\/)(?:\\.|(?!\1)[^\\\r\n])*)\1/g,
    replacement: (_match, quote: string) => `${quote}[REDACTED:PATH]${quote}`,
  },
  {
    kind: 'path',
    pattern:
      /(?<![A-Za-z0-9._:/-])(?:~\/|\/(?:Users|home|root|private|tmp|var|opt|etc|mnt|srv|data|app|usr|Library|System|Applications|nix|Volumes|workspace|workspaces)\/)(?:\\[ \t]|[A-Za-z0-9._~+@%/=:-])+/g,
    replacement: preserveTrailingPathPunctuation,
  },
  {
    kind: 'path',
    pattern: /(?<![A-Za-z0-9._-])[A-Za-z]:\\(?:[^\\\s<>:"|?*]+\\)*[^\\\s<>:"|?*]*/g,
    replacement: preserveTrailingPathPunctuation,
  },
  {
    kind: 'path',
    pattern: /(?<![A-Za-z0-9._-])\\\\[^\\\s<>:"|?*]+\\[^\\\s<>:"|?*]+(?:\\[^\\\s<>:"|?*]+)*/g,
    replacement: preserveTrailingPathPunctuation,
  },
  {
    kind: 'secret',
    pattern:
      /\b((?:[A-Z0-9_]*(?:API[_-]?KEY|ACCESS[_-]?TOKEN|AUTH[_-]?TOKEN|TOKEN|PASSWORD|PASSWD|CLIENT[_-]?SECRET|PRIVATE[_-]?KEY|SECRET)[A-Z0-9_-]*)\s*(?:=|:)\s*)(?!["']?\[REDACTED:)(?:"[^"]*"|'[^']*'|[^\s,;&#]+)/gi,
    replacement: '[REDACTED:SECRET]',
  },
  {
    kind: 'header',
    pattern: /\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.-]{8,}/gi,
    replacement: '[REDACTED:AUTH_HEADER]',
  },
];

const SENSITIVE_KEY =
  /(?:^|[_-])(?:password|passwd|secret|token|credential|credentials|api[_-]?key|access[_-]?key|private[_-]?key|authorization|cookie)(?:$|[_-])/i;

export function redactText(input: string): RedactionResult<string> {
  const counts = new Map<RedactionKind, number>();
  let value = input;

  try {
    for (const definition of PATTERNS) {
      definition.pattern.lastIndex = 0;
      value = value.replace(definition.pattern, (...args: unknown[]) => {
        counts.set(definition.kind, (counts.get(definition.kind) ?? 0) + 1);
        if (typeof definition.replacement === 'string') return definition.replacement;
        return definition.replacement(...(args as [string, ...string[]]));
      });
    }
  } catch (error) {
    return {
      ok: false,
      reason: `Redaction failed: ${(error as Error).message}`,
      findings: toFindings(counts),
    };
  }

  const residual = detectSensitiveKinds(value);
  if (residual.length > 0) {
    return {
      ok: false,
      reason: `Sensitive canary remained after redaction: ${residual.join(', ')}`,
      findings: toFindings(counts),
    };
  }

  return { ok: true, value, findings: toFindings(counts) };
}

export function redactJson(input: unknown): RedactionResult<JsonValue> {
  const findings = new Map<RedactionKind, number>();

  try {
    const value = redactJsonValue(input, findings, new Set<object>(), 0);
    const residual = detectSensitiveJsonKinds(value);
    if (residual.length > 0) {
      return {
        ok: false,
        reason: `Sensitive canary remained after JSON redaction: ${residual.join(', ')}`,
        findings: toFindings(findings),
      };
    }
    return { ok: true, value, findings: toFindings(findings) };
  } catch (error) {
    return {
      ok: false,
      reason: `JSON redaction failed: ${(error as Error).message}`,
      findings: toFindings(findings),
    };
  }
}

export function boundText(input: string): string {
  return truncateString(input, MAX_NORMALIZED_TEXT_CHARS, 'TEXT');
}

export function boundJson(input: JsonValue): JsonValue {
  const budget = { remaining: MAX_JSON_SERIALIZED_CHARS - 2_048 };
  const bounded = boundJsonValue(input, 0, budget);
  const serializedLength = JSON.stringify(bounded).length;
  if (serializedLength <= MAX_JSON_SERIALIZED_CHARS) return bounded;
  return `[TRUNCATED:JSON ${serializedLength - MAX_JSON_SERIALIZED_CHARS} chars over limit]`;
}

export function detectSensitiveKinds(input: string): RedactionKind[] {
  const matches = new Set<RedactionKind>();
  for (const definition of PATTERNS) {
    definition.pattern.lastIndex = 0;
    if (definition.pattern.test(input)) matches.add(definition.kind);
  }
  return [...matches].sort();
}

function detectSensitiveJsonKinds(value: JsonValue): RedactionKind[] {
  const matches = new Set<RedactionKind>();
  visitJsonStrings(value, (text) => {
    for (const kind of detectSensitiveKinds(text)) matches.add(kind);
  });
  return [...matches].sort();
}

function redactJsonValue(
  input: unknown,
  findings: Map<RedactionKind, number>,
  ancestors: Set<object>,
  depth: number,
): JsonValue {
  if (depth > 64) throw new Error('maximum object depth exceeded');
  if (input === null || typeof input === 'boolean') return input;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new Error('non-finite number');
    return input;
  }
  if (typeof input === 'string') {
    const result = redactText(input);
    if (!result.ok) throw new Error(result.reason);
    mergeFindings(findings, result.findings);
    return result.value;
  }
  if (typeof input !== 'object') throw new Error(`unsupported ${typeof input} value`);
  if (ancestors.has(input)) throw new Error('cyclic object');

  ancestors.add(input);
  try {
    if (Array.isArray(input)) {
      return input.map((item) => redactJsonValue(item, findings, ancestors, depth + 1));
    }

    const output: { [key: string]: JsonValue } = {};
    for (const [key, value] of Object.entries(input)) {
      const redactedKeyResult = redactText(key);
      if (!redactedKeyResult.ok) throw new Error(redactedKeyResult.reason);
      mergeFindings(findings, redactedKeyResult.findings);
      const redactedKey = uniqueKey(output, redactedKeyResult.value);
      if (isSensitiveKey(key) && value !== null) {
        output[redactedKey] = '[REDACTED:SECRET]';
        findings.set('secret', (findings.get('secret') ?? 0) + 1);
      } else {
        output[redactedKey] = redactJsonValue(value, findings, ancestors, depth + 1);
      }
    }
    return output;
  } finally {
    ancestors.delete(input);
  }
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  return SENSITIVE_KEY.test(normalized);
}

function mergeFindings(
  destination: Map<RedactionKind, number>,
  additions: RedactionFinding[],
): void {
  for (const finding of additions) {
    destination.set(finding.kind, (destination.get(finding.kind) ?? 0) + finding.count);
  }
}

function toFindings(counts: Map<RedactionKind, number>): RedactionFinding[] {
  return [...counts.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((left, right) => left.kind.localeCompare(right.kind));
}

function boundJsonValue(input: JsonValue, depth: number, budget: { remaining: number }): JsonValue {
  if (depth >= MAX_JSON_DEPTH) return consumeMarker(budget, '[TRUNCATED:JSON_DEPTH]');
  if (budget.remaining <= 0) return '[TRUNCATED:JSON_BUDGET]';
  if (input === null || typeof input === 'boolean' || typeof input === 'number') {
    budget.remaining -= String(input).length;
    return input;
  }
  if (typeof input === 'string') {
    const available = Math.max(32, Math.min(MAX_JSON_STRING_CHARS, budget.remaining));
    const bounded = truncateString(input, available, 'JSON_STRING');
    budget.remaining -= bounded.length;
    return bounded;
  }
  if (Array.isArray(input)) {
    const output: JsonValue[] = [];
    const limit = Math.min(input.length, MAX_JSON_ARRAY_ITEMS);
    for (let index = 0; index < limit && budget.remaining > 0; index += 1) {
      output.push(boundJsonValue(input[index]!, depth + 1, budget));
    }
    const omitted = input.length - output.length;
    if (omitted > 0) output.push(consumeMarker(budget, `[TRUNCATED:ARRAY ${omitted} item(s)]`));
    return output;
  }

  const output: { [key: string]: JsonValue } = {};
  const entries = Object.entries(input);
  const limit = Math.min(entries.length, MAX_JSON_OBJECT_KEYS);
  let consumed = 0;
  for (let index = 0; index < limit && budget.remaining > 0; index += 1) {
    const entry = entries[index];
    if (!entry) break;
    const key = truncateString(entry[0], 256, 'JSON_KEY');
    budget.remaining -= key.length;
    output[uniqueKey(output, key)] = boundJsonValue(entry[1], depth + 1, budget);
    consumed += 1;
  }
  const omitted = entries.length - consumed;
  if (omitted > 0) {
    output[uniqueKey(output, '_retrospective_truncation')] = consumeMarker(
      budget,
      `[TRUNCATED:OBJECT ${omitted} key(s)]`,
    );
  }
  return output;
}

function truncateString(input: string, limit: number, category: string): string {
  if (input.length <= limit) return input;
  const marker = `[TRUNCATED:${category} ${input.length - limit} chars]`;
  if (marker.length >= limit) return marker.slice(0, limit);
  return `${input.slice(0, limit - marker.length)}${marker}`;
}

function consumeMarker(budget: { remaining: number }, marker: string): string {
  budget.remaining -= marker.length;
  return marker;
}

function uniqueKey(output: { [key: string]: JsonValue }, preferred: string): string {
  if (!(preferred in output)) return preferred;
  let suffix = 2;
  while (`${preferred}#${suffix}` in output) suffix += 1;
  return `${preferred}#${suffix}`;
}

function visitJsonStrings(value: JsonValue, visit: (text: string) => void): void {
  if (typeof value === 'string') {
    visit(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) visitJsonStrings(item, visit);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    visit(key);
    visitJsonStrings(item, visit);
  }
}

function preserveTrailingPathPunctuation(match: string): string {
  const punctuation = /[.!?]+$/.exec(match)?.[0] ?? '';
  return `[REDACTED:PATH]${punctuation}`;
}
