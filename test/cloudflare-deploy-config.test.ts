import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, test } from 'vitest';

function readConfig(name: string): unknown {
  const source = readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
  const { config, error } = ts.parseConfigFileTextToJson(name, source);
  expect(error).toBeUndefined();
  return config;
}

test('production differs from dark staging only by script name and custom domain', () => {
  const staging = readConfig('wrangler.jsonc');
  expect(staging).toMatchObject({
    name: 'memento-cf-stage',
    workers_dev: false,
    preview_urls: false,
  });
  for (const key of ['route', 'routes', 'triggers', 'env']) {
    expect(staging).not.toHaveProperty(key);
  }
  expect(readConfig('wrangler.production.jsonc')).toEqual({
    ...(staging as object),
    name: 'memento-cf-prod',
    routes: [{ pattern: 'memento.destiner.io', custom_domain: true }],
  });
});
