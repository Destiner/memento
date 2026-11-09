import { expect, test } from 'vitest';
import { loadCloudConfig } from '../src/cloud-config.js';

const env = {
  NODE_ENV: 'production',
  MEMENTO_PUBLIC_ORIGIN: 'https://memento.example.com',
  MEMENTO_DATA_DIR: '/var/data/memento',
  AUTH_ALLOWED_EMAILS: ' Work@example.com, personal@example.com ',
  BETTER_AUTH_SECRET: 'test-only-not-a-real-secret-000000000000',
  GOOGLE_CLIENT_ID: 'test-client',
  GOOGLE_CLIENT_SECRET: 'test-secret',
};

test('normalizes a private explicit allowlist and chooses production binding', () => {
  const config = loadCloudConfig(env);
  expect(config.allowedEmails).toEqual(['work@example.com', 'personal@example.com']);
  expect(config.host).toBe('0.0.0.0');
});

test.each([
  'AUTH_ALLOWED_EMAILS',
  'BETTER_AUTH_SECRET',
  'MEMENTO_PUBLIC_ORIGIN',
  'MEMENTO_DATA_DIR',
])('fails closed without %s', (key) => {
  expect(() => loadCloudConfig({ ...env, [key]: '' })).toThrow(key);
});

test.each(['', 'bad', 'a@example.com,', '*@example.com', 'a@example.com b@example.com'])(
  'rejects invalid allowlist %s',
  (value) => {
    expect(() => loadCloudConfig({ ...env, AUTH_ALLOWED_EMAILS: value })).toThrow();
  },
);

test('rejects local product mode, insecure production origins and incomplete credentials', () => {
  expect(() => loadCloudConfig({ ...env, MEMENTO_HOME: '/legacy' })).toThrow('MEMENTO_HOME');
  expect(() =>
    loadCloudConfig({ ...env, MEMENTO_PUBLIC_ORIGIN: 'http://localhost:3000' }),
  ).toThrow();
  expect(() =>
    loadCloudConfig({ ...env, MEMENTO_PUBLIC_ORIGIN: `${env.MEMENTO_PUBLIC_ORIGIN}/path` }),
  ).toThrow();
  expect(() => loadCloudConfig({ ...env, GOOGLE_CLIENT_SECRET: '' })).toThrow();
  expect(() =>
    loadCloudConfig({ ...env, GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '' }),
  ).toThrow();
});

test('development uses the same authenticated HTTP service, not a local memory fallback', () => {
  const config = loadCloudConfig({
    ...env,
    NODE_ENV: 'development',
    MEMENTO_PUBLIC_ORIGIN: 'http://127.0.0.1:3000',
  });
  expect(config.host).toBe('127.0.0.1');
  expect(config.allowedEmails).toHaveLength(2);
});
