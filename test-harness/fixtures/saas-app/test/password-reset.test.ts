// Oracle for the read/email-provider scenario (harness-spec §4.3). Provider-
// agnostic and offline: it injects a fake Mailer and asserts the reset flow
// sends the reset link to the user. Which provider backs the real mailer is the
// utility check's concern (a diff regex), not this test's.

import { expect, test } from 'bun:test';

import { requestPasswordReset, type PasswordResetDeps } from '../src/auth/password-reset.js';
import type { EmailMessage, Mailer } from '../src/email.js';

function fakeMailer(): { mailer: Mailer; sent: EmailMessage[] } {
  const sent: EmailMessage[] = [];
  const mailer: Mailer = {
    async send(message) {
      sent.push(message);
    },
  };
  return { mailer, sent };
}

function memoryStore(): PasswordResetDeps['store'] & { saved: Record<string, string> } {
  const saved: Record<string, string> = {};
  return {
    saved,
    save(email, token) {
      saved[email] = token;
    },
  };
}

test('requestPasswordReset emails the reset link to the user', async () => {
  const { mailer, sent } = fakeMailer();
  const store = memoryStore();

  await requestPasswordReset('user@example.com', { store, mailer });

  expect(sent).toHaveLength(1);
  const message = sent[0]!;
  expect(message.to).toBe('user@example.com');
  // The email must carry the issued reset token so the link actually works.
  expect(message.body).toContain(store.saved['user@example.com']!);
});
