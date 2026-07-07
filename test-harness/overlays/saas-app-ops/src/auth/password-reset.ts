import { randomBytes } from 'node:crypto';

import type { Mailer } from '../email.js';

export interface TokenStore {
  save(email: string, token: string): void;
}

export interface PasswordResetDeps {
  store: TokenStore;
  mailer: Mailer;
}

const RESET_URL_BASE = 'https://app.example.com/reset';

// Start a password reset: issue a single-use token, persist it, and email the
// reset link to the user.
export async function requestPasswordReset(email: string, deps: PasswordResetDeps): Promise<void> {
  const token = randomBytes(32).toString('hex');
  deps.store.save(email, token);
  const resetUrl = `${RESET_URL_BASE}?token=${token}`;
  await deps.mailer.send({
    to: email,
    subject: 'Reset your password',
    body: `Use this link to reset your password: ${resetUrl}`,
  });
}
