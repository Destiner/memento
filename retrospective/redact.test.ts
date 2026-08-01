import { describe, expect, it } from 'vitest';

import { requireRedactedJson, requireRedactedText } from './adapters/common.js';
import {
  boundJson,
  boundText,
  detectSensitiveKinds,
  MAX_JSON_ARRAY_ITEMS,
  MAX_JSON_DEPTH,
  MAX_JSON_OBJECT_KEYS,
  MAX_JSON_SERIALIZED_CHARS,
  MAX_JSON_STRING_CHARS,
  MAX_NORMALIZED_TEXT_CHARS,
  redactJson,
  redactText,
} from './redact.js';

describe('retrospective redaction', () => {
  it.each([
    ['email', 'alice@example.com'],
    ['unix path', '/Users/alice/private/repo/file.ts'],
    ['windows path', 'C:\\Users\\alice\\repo\\file.ts'],
    ['URL credentials', 'https://alice:hunter2@example.com/private'],
    ['authorization header', 'Authorization: Bearer abcdefghijklmnop'],
    ['provider token', 'sk-proj-abcdefghijklmnopqrstuv'],
    ['generic secret', 'CLIENT_SECRET=abcdefghijklmnop'],
    ['bare token assignment', 'TOKEN=abcdefghijklmnop'],
    ['URL query credential', 'https://example.com/callback?token=abcdefghijklmnop&safe=1'],
    ['PEM block', '-----BEGIN PRIVATE KEY-----\nabcdefghijklmnop\n-----END PRIVATE KEY-----'],
  ])('redacts a %s canary and verifies the output', (_name, canary) => {
    const result = redactText(`before ${canary} after`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).not.toContain(canary);
    expect(detectSensitiveKinds(result.value)).toEqual([]);
    expect(result.findings.length).toBeGreaterThan(0);
  });

  it.each([
    [
      'plain path before prose',
      'Open /Users/alice/work/repo/file.ts then retry.',
      'Open [REDACTED:PATH] then retry.',
    ],
    [
      'shell-escaped path before punctuation',
      'Open /Users/alice/My\\ Project/file.ts, then retry.',
      'Open [REDACTED:PATH], then retry.',
    ],
    [
      'quoted path with spaces',
      'Open "/Users/alice/My Project/file.ts" then retry.',
      'Open "[REDACTED:PATH]" then retry.',
    ],
  ])('redacts a %s without swallowing its suffix', (_name, input, expected) => {
    const result = redactText(input);
    expect(result).toMatchObject({ ok: true, value: expected });
  });

  it('preserves non-credential URL query parameters', () => {
    const result = redactText(
      'Open https://example.com/callback?token=abcdefghijklmnop&safe=1#section now.',
    );
    expect(result).toMatchObject({
      ok: true,
      value:
        'Open https://example.com/callback?token=[REDACTED:URL_CREDENTIALS]&safe=1#section now.',
    });
  });

  it.each([
    [
      'oversized PEM',
      `before -----BEGIN PRIVATE KEY-----\n${'a'.repeat(MAX_NORMALIZED_TEXT_CHARS + 2_000)}\n-----END PRIVATE KEY----- after`,
      '-----BEGIN PRIVATE KEY-----',
    ],
    [
      'unterminated PEM',
      'before -----BEGIN PRIVATE KEY-----\nmalformed-without-an-end-marker',
      '-----BEGIN PRIVATE KEY-----',
    ],
    [
      'provider token crossing the text limit',
      `${'x'.repeat(MAX_NORMALIZED_TEXT_CHARS - 5)}sk-proj-abcdefghijklmnopqrstuv`,
      'sk-proj-',
    ],
  ])('redacts a %s before applying content bounds', (_name, input, forbidden) => {
    const value = requireRedactedText(input, 'oversized test value');
    expect(value.length).toBeLessThanOrEqual(MAX_NORMALIZED_TEXT_CHARS);
    expect(value).not.toContain(forbidden);
    expect(detectSensitiveKinds(value)).toEqual([]);
  });

  it('redacts sensitive object keys recursively', () => {
    const result = redactJson({ nested: { api_key: 'not-even-a-provider-token', safe: true } });
    expect(result).toMatchObject({
      ok: true,
      value: { nested: { api_key: '[REDACTED:SECRET]', safe: true } },
    });
  });

  it('redacts camelCase credential keys recursively', () => {
    const result = redactJson({
      accessToken: 'plain-access-value',
      clientSecret: 'plain-client-value',
      authToken: 'plain-auth-value',
      apiKey: 'plain-api-value',
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        accessToken: '[REDACTED:SECRET]',
        clientSecret: '[REDACTED:SECRET]',
        authToken: '[REDACTED:SECRET]',
        apiKey: '[REDACTED:SECRET]',
      },
    });
  });

  it('removes attachment payloads and redacts evaluator-bound privacy canaries', () => {
    const value = requireRedactedJson(
      {
        credential: 'plain-secret-value',
        image: { data: 'BASE64-PRIVATE-DATA' },
        path: '/usr/local/private/file.txt',
        stripe: 'sk_live_abcdefghijklmnop',
        webhook: 'whsec_abcdefghijklmnop',
      },
      'synthetic evaluator context',
    );

    expect(value).toEqual({
      credential: '[REDACTED:SECRET]',
      path: '[REDACTED:PATH]',
      stripe: '[REDACTED:PROVIDER_TOKEN]',
      webhook: '[REDACTED:PROVIDER_TOKEN]',
    });
  });

  it('verifies redacted JSON one key and leaf at a time', () => {
    const result = redactJson({
      token: 'plain-value',
      escaped: 'quotes " and slashes \\ remain ordinary text',
      nested: ['safe', { authorization: 'also-redacted-by-key' }],
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        token: '[REDACTED:SECRET]',
        escaped: 'quotes " and slashes \\ remain ordinary text',
        nested: ['safe', { authorization: '[REDACTED:SECRET]' }],
      },
    });
  });

  it('fails closed for values that cannot be represented safely', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const result = redactJson(cyclic);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('cyclic object');
  });

  it('bounds normalized text with a visible marker', () => {
    const bounded = boundText('x'.repeat(MAX_NORMALIZED_TEXT_CHARS + 500));
    expect(bounded).toHaveLength(MAX_NORMALIZED_TEXT_CHARS);
    expect(bounded).toContain('[TRUNCATED:TEXT');
  });

  it('bounds JSON strings, collections, depth, and total serialized size', () => {
    let deep: unknown = 'leaf';
    for (let index = 0; index < MAX_JSON_DEPTH + 5; index += 1) deep = { child: deep };
    const bounded = boundJson({
      long: 'x'.repeat(MAX_JSON_STRING_CHARS + 500),
      array: Array.from({ length: MAX_JSON_ARRAY_ITEMS + 10 }, (_, index) => index),
      object: Object.fromEntries(
        Array.from({ length: MAX_JSON_OBJECT_KEYS + 10 }, (_, index) => [`key_${index}`, index]),
      ),
      deep: deep as never,
    });
    const serialized = JSON.stringify(bounded);

    expect(serialized.length).toBeLessThanOrEqual(MAX_JSON_SERIALIZED_CHARS);
    expect(serialized).toContain('[TRUNCATED:JSON_STRING');
    expect(serialized).toContain('[TRUNCATED:ARRAY');
    expect(serialized).toContain('[TRUNCATED:OBJECT');
    expect(serialized).toContain('[TRUNCATED:JSON_DEPTH]');
  });
});
