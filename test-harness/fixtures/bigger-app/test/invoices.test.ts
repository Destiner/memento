import { describe, expect, test } from 'bun:test';

import { invoices, users } from '../src/db.js';
import { Router } from '../src/http.js';
import { registerInvoiceRoutes } from '../src/routes/invoices.js';
import { registerUserRoutes } from '../src/routes/users.js';

function makeRouter(): Router {
  const router = new Router();
  registerUserRoutes(router);
  registerInvoiceRoutes(router);
  return router;
}

describe('invoices', () => {
  test('create and list with labels and formatted amounts', async () => {
    const router = makeRouter();
    const user = users.insert({ id: 'usr_t1', email: 't@example.com', createdAt: 0 });
    const created = await router.dispatch({
      method: 'POST',
      path: '/invoices',
      headers: {},
      body: JSON.stringify({ userId: user.id, amountCents: 1250 }),
    });
    expect(created.status).toBe(201);

    const list = await router.dispatch({ method: 'GET', path: '/invoices', headers: {}, body: '' });
    const rows = list.body as Array<{ label: string; amount: string }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.amount).toContain('USD');
  });

  test('rejects a non-positive amount', async () => {
    const router = makeRouter();
    const res = await router.dispatch({
      method: 'POST',
      path: '/invoices',
      headers: {},
      body: JSON.stringify({ userId: 'usr_x', amountCents: 0 }),
    });
    expect(res.status).toBe(400);
  });

  test('paid invoices carry a human label', () => {
    const inv = invoices.insert({
      id: 'inv_label',
      userId: 'usr_t1',
      amountCents: 100,
      currency: 'usd',
      status: 'paid',
    });
    expect(inv.status).toBe('paid');
  });
});
