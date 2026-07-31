import { type Invoice } from './db.js';
import { type Job } from './queue.js';
import { formatAmount } from './routes/invoices.js';

export function paymentReceived(invoice: Invoice): Job {
  return {
    kind: 'email.payment-received',
    payload: {
      userId: invoice.userId,
      subject: 'Payment received',
      body: `We received your payment of ${formatAmount(invoice)}.`,
    },
  };
}

export function demoWelcome(userId: string, n: number): Job {
  return {
    kind: 'email.demo',
    payload: { userId, subject: `Welcome #${n}`, body: 'Thanks for trying the demo.' },
  };
}
