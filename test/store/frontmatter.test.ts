import { describe, expect, test } from 'vitest';

import { MementoError } from '../../src/errors.js';
import { parseFrontmatter, serializeFrontmatter } from '../../src/store/frontmatter.js';

describe('parseFrontmatter', () => {
  test('splits front matter from body', () => {
    const raw = ['---', 'id: mem_1', 'version: 3', '---', '', '## Summary', 'Hello.'].join('\n');
    const { metadata, body } = parseFrontmatter(raw);
    expect(metadata).toEqual({ id: 'mem_1', version: 3 });
    expect(body).toBe('## Summary\nHello.');
  });

  test('keeps date-like and colon-bearing scalars as strings', () => {
    const raw = [
      '---',
      'title: "Email provider: usage, constraints, and known issues"',
      'created_at: 2026-07-04T14:20:00Z',
      'review_after: 2026-10-04',
      '---',
      '',
      'body',
    ].join('\n');
    const { metadata } = parseFrontmatter(raw);
    expect(metadata.title).toBe('Email provider: usage, constraints, and known issues');
    expect(metadata.created_at).toBe('2026-07-04T14:20:00Z');
    expect(metadata.review_after).toBe('2026-10-04');
  });

  test('throws when the front-matter block is absent', () => {
    expect(() => parseFrontmatter('no front matter here')).toThrow(MementoError);
  });

  test('throws when front matter is not a mapping', () => {
    const raw = ['---', '- just', '- a', '- list', '---', '', 'body'].join('\n');
    expect(() => parseFrontmatter(raw)).toThrow(/must be a YAML mapping/);
  });
});

describe('serializeFrontmatter', () => {
  test('emits a delimited block followed by a normalized body', () => {
    const out = serializeFrontmatter({ id: 'mem_1', version: 1 }, '  ## Summary\nHi.  ');
    expect(out).toBe(
      ['---', 'id: mem_1', 'version: 1', '---', '', '## Summary', 'Hi.', ''].join('\n'),
    );
  });

  test('preserves the order in which metadata keys were inserted', () => {
    const out = serializeFrontmatter({ id: 'mem_1', title: 'T', type: 'decision' }, 'x');
    const keyLines = out
      .split('\n')
      .filter((line) => /^[a-z_]+:/.test(line))
      .map((line) => line.split(':')[0]);
    expect(keyLines).toEqual(['id', 'title', 'type']);
  });
});

describe('round-trip', () => {
  test('parse(serialize(x)) recovers metadata and body', () => {
    const metadata = {
      id: 'mem_01JABCDEF',
      title: 'Vendor: deliverability caveat',
      type: 'integration',
      version: 2,
      tags: ['deliverability', 'webhooks'],
      review_after: '2026-10-04',
    };
    const body =
      '## Summary\nWebhook timing is unreliable.\n\n## Context\nPeak volume delays events.';
    const parsed = parseFrontmatter(serializeFrontmatter(metadata, body));
    expect(parsed.metadata).toEqual(metadata);
    expect(parsed.body).toBe(body);
  });
});
