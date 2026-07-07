// Transactional email port used by the auth flows. Callers depend only on the
// Mailer interface so it can be faked in tests; createMailer() returns the
// concrete implementation the app is wired up with.

export interface EmailMessage {
  to: string;
  subject: string;
  body: string;
}

export interface Mailer {
  send(message: EmailMessage): Promise<void>;
}

// Development mailer: logs the message instead of calling a provider. Enough to
// run the fixture end to end; production wiring swaps in a real provider client.
export function createMailer(): Mailer {
  return {
    async send(message) {
      console.log(`[mail] to=${message.to} subject=${message.subject}`);
    },
  };
}
