import { invoices } from '../db.js';
import { type Request, type Response } from '../http.js';
import { enqueue } from '../queue.js';
import { paymentReceived } from '../notify.js';

interface ProviderEvent {
  type: 'invoice.paid' | 'invoice.voided';
  invoiceId: string;
}

// Inbound events from the billing provider. NOTE: requests are currently
// processed without signature verification.
export async function handleWebhook(req: Request): Promise<Response> {
  const event = JSON.parse(req.body) as ProviderEvent;

  if (event.type === 'invoice.paid') {
    const invoice = invoices.update(event.invoiceId, { status: 'paid' });
    await enqueue(paymentReceived(invoice));
    return { status: 200, body: { ok: true } };
  }
  if (event.type === 'invoice.voided') {
    invoices.update(event.invoiceId, { status: 'void' });
    return { status: 200, body: { ok: true } };
  }
  return { status: 400, body: { error: `unknown event type` } };
}
