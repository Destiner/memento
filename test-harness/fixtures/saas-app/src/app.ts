import { requestPasswordReset, type TokenStore } from './auth/password-reset.js';
import { createMailer } from './email.js';

// Production wiring: build the password-reset action backed by the real mailer.
export function passwordResetAction(store: TokenStore): (email: string) => Promise<void> {
  const mailer = createMailer();
  return (email) => requestPasswordReset(email, { store, mailer });
}
