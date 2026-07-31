import { describe, expect, test } from 'bun:test';

import { invoices } from '../src/db.js';
import { handleWebhook } from '../src/webhooks/handler.js';

describe('webhooks', () => {
  test('invoice.paid marks the invoice paid', async () => {
    invoices.insert({
      id: 'inv_wh1',
      userId: 'usr_wh',
      amountCents: 500,
      currency: 'usd',
      status: 'open',
    });
    const res = await handleWebhook({
      method: 'POST',
      path: '/webhooks/billing',
      headers: {},
      body: JSON.stringify({ type: 'invoice.paid', invoiceId: 'inv_wh1' }),
    });
    expect(res.status).toBe(200);
    expect(invoices.get('inv_wh1')?.status).toBe('paid');
  });

  test('unknown event types are rejected', async () => {
    const res = await handleWebhook({
      method: 'POST',
      path: '/webhooks/billing',
      headers: {},
      body: JSON.stringify({ type: 'invoice.exploded', invoiceId: 'inv_x' }),
    });
    expect(res.status).toBe(400);
  });
});
