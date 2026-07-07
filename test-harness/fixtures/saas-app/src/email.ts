// Transactional email port used by the auth flows. Callers depend only on the
// Mailer interface so it can be faked in tests; the concrete, provider-backed
// implementation is produced by createMailer().

export interface EmailMessage {
  to: string;
  subject: string;
  body: string;
}

export interface Mailer {
  send(message: EmailMessage): Promise<void>;
}

export function createMailer(): Mailer {
  throw new Error('createMailer is not implemented yet');
}
