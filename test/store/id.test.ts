import { describe, expect, test } from 'vitest';

import { generateId, memoryFilename, slugify } from '../../src/store/id.js';

const CROCKFORD = /^[0-9A-HJKMNP-TV-Z]+$/;

describe('generateId', () => {
  test('produces a mem_-prefixed 26-char ULID', () => {
    const id = generateId();
    expect(id.startsWith('mem_')).toBe(true);
    const ulid = id.slice('mem_'.length);
    expect(ulid).toHaveLength(26);
    expect(ulid).toMatch(CROCKFORD);
  });

  test('is unique across calls at the same timestamp', () => {
    const now = 1_751_640_000_000;
    const ids = new Set(Array.from({ length: 500 }, () => generateId(now)));
    expect(ids.size).toBe(500);
  });

  test('shares a timestamp prefix for the same instant', () => {
    const now = 1_751_640_000_000;
    const a = generateId(now).slice(4, 14);
    const b = generateId(now).slice(4, 14);
    expect(a).toBe(b);
  });

  test('sorts lexicographically by creation time', () => {
    const earlier = generateId(1_751_640_000_000);
    const later = generateId(1_751_640_001_000);
    expect(earlier < later).toBe(true);
  });
});

describe('slugify', () => {
  test('lowercases and hyphenates', () => {
    expect(slugify('Email provider: usage, constraints')).toBe('email-provider-usage-constraints');
  });

  test('is deterministic', () => {
    const title = 'Legacy sync service: current product role';
    expect(slugify(title)).toBe(slugify(title));
  });

  test('strips diacritics and leading/trailing separators', () => {
    expect(slugify('  Café Déjà-vu!  ')).toBe('cafe-deja-vu');
  });

  test('caps length without a trailing hyphen', () => {
    const slug = slugify('a'.repeat(40) + ' ' + 'b'.repeat(40), 20);
    expect(slug).toHaveLength(20);
    expect(slug.endsWith('-')).toBe(false);
  });

  test('falls back to "memory" for a title with no usable characters', () => {
    expect(slugify('!!!')).toBe('memory');
  });
});

describe('memoryFilename', () => {
  test('joins id and slug with a .md extension', () => {
    expect(memoryFilename('mem_01JABCDEF', 'Vendor: deliverability caveat')).toBe(
      'mem_01JABCDEF-vendor-deliverability-caveat.md',
    );
  });
});
