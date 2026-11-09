import { isAbsolute } from 'node:path';

import type { AuthServiceOptions } from './auth/index.js';

export interface CloudConfig extends AuthServiceOptions {
  host: string;
  port: number;
}

export function loadCloudConfig(env: NodeJS.ProcessEnv = process.env): CloudConfig {
  const required = (key: string): string => {
    const value = env[key]?.trim();
    if (!value) throw new Error(`${key} is required.`);
    return value;
  };
  const origin = required('MEMENTO_PUBLIC_ORIGIN');
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new Error('MEMENTO_PUBLIC_ORIGIN must be an origin URL.');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    url.origin !== origin ||
    (url.protocol !== 'https:' &&
      !(env.NODE_ENV !== 'production' && loopback && url.protocol === 'http:'))
  ) {
    throw new Error('MEMENTO_PUBLIC_ORIGIN must be HTTPS without a path.');
  }
  const dataDir = required('MEMENTO_DATA_DIR');
  if (!isAbsolute(dataDir)) throw new Error('MEMENTO_DATA_DIR must be absolute.');
  const allowedEmails = required('AUTH_ALLOWED_EMAILS')
    .split(',')
    .map((email) => email.trim().toLowerCase());
  if (allowedEmails.some((email) => !/^[^\s@*]+@[^\s@*]+\.[^\s@*]+$/.test(email))) {
    throw new Error('AUTH_ALLOWED_EMAILS must contain comma-separated email addresses.');
  }
  const secret = required('BETTER_AUTH_SECRET');
  if (secret.length < 32) throw new Error('BETTER_AUTH_SECRET must be at least 32 characters.');
  const googleClientId = env.GOOGLE_CLIENT_ID?.trim() || undefined;
  const googleClientSecret = env.GOOGLE_CLIENT_SECRET?.trim() || undefined;
  const githubClientId = env.GITHUB_CLIENT_ID?.trim() || undefined;
  const githubClientSecret = env.GITHUB_CLIENT_SECRET?.trim() || undefined;
  for (const [id, key] of [
    [googleClientId, googleClientSecret],
    [githubClientId, githubClientSecret],
  ]) {
    if (Boolean(id) !== Boolean(key))
      throw new Error('Social provider credentials must be configured in pairs.');
  }
  if (!googleClientId && !githubClientId)
    throw new Error('Configure at least one social login provider.');
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('PORT must be between 1 and 65535.');
  if (env.MEMENTO_HOME !== undefined)
    throw new Error('MEMENTO_HOME is no longer supported; configure MEMENTO_DATA_DIR.');
  return {
    origin,
    dataDir,
    allowedEmails: [...new Set(allowedEmails)],
    secret,
    googleClientId,
    googleClientSecret,
    githubClientId,
    githubClientSecret,
    host: env.HOST?.trim() || (env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1'),
    port,
  };
}
