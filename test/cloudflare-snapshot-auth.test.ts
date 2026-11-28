import { expect, it } from 'vitest';
import { AUTH_COLUMNS, AUTH_TABLES, validateAuthSnapshot } from '../cloudflare/snapshot-auth.js';

const production = 'https://memento.destiner.io';
const canonical = `${production}/mcp`;
const historical = 'https://memento-o9bz.onrender.com/mcp';
const other = 'https://memento.example';
const unexpected = 'https://other.example/mcp';

function snapshot(identifiers: readonly string[]) {
  return {
    ...Object.fromEntries(AUTH_TABLES.map((table) => [table, []])),
    oauthResource: identifiers.map((identifier, index) => ({
      ...Object.fromEntries(AUTH_COLUMNS.oauthResource.map((column) => [column, null])),
      id: `synthetic-${index}`,
      identifier,
      name: identifier,
    })),
  };
}

it.each([
  ['canonical only in production', production, [canonical]],
  ['canonical and historical', production, [canonical, historical]],
  ['historical before canonical', production, [historical, canonical]],
  ['canonical only outside production', other, [`${other}/mcp`]],
] as const)('accepts %s without modifying rows', (_label, origin, identifiers) => {
  const auth = snapshot(identifiers);
  const before = structuredClone(auth);
  expect(validateAuthSnapshot(auth, origin)).toBe(auth);
  expect(auth).toEqual(before);
});

it.each([
  ['no resource', production, []],
  ['historical only', production, [historical]],
  ['wrong canonical', production, [unexpected, historical]],
  ['arbitrary second resource', production, [canonical, unexpected]],
  ['arbitrary third resource', production, [canonical, historical, unexpected]],
  ['historical lookalike', production, [canonical, `${historical}/`]],
  ['canonical lookalike', production, [`${canonical}/`, historical]],
  ['historical outside production', other, [`${other}/mcp`, historical]],
  ['historical on a different port', `${production}:8443`, [`${production}:8443/mcp`, historical]],
] as const)('rejects %s', (_label, origin, identifiers) => {
  expect(() => validateAuthSnapshot(snapshot(identifiers), origin)).toThrow(/migration resource/);
});

it.each([
  ['canonical', [canonical, canonical]],
  ['historical', [canonical, historical, historical]],
] as const)(
  'rejects duplicate %s identifiers even with distinct row IDs',
  (_label, identifiers) => {
    expect(() => validateAuthSnapshot(snapshot(identifiers), production)).toThrow(/constraints/);
  },
);
