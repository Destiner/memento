import { invoices, type Invoice } from '../db.js';
import { type Router } from '../http.js';

// Human-readable labels for list views and notification copy.
export const STATUS_LABELS: Record<Invoice['status'], string> = {
  draft: 'Draft',
  open: 'Awaiting payment',
  paid: 'Payed',
  void: 'Voided',
};

export function formatAmount(invoice: Invoice): string {
  return `${(invoice.amountCents / 100).toFixed(2)} ${invoice.currency.toUpperCase()}`;
}

export function registerInvoiceRoutes(router: Router): void {
  router.on('POST', '/invoices', (req) => {
    const input = JSON.parse(req.body) as Partial<Invoice>;
    if (!input.userId || !input.amountCents || input.amountCents <= 0) {
      return { status: 400, body: { error: 'userId and positive amountCents required' } };
    }
    const invoice: Invoice = {
      id: `inv_${invoices.all().length + 1}`,
      userId: input.userId,
      amountCents: input.amountCents,
      currency: input.currency ?? 'usd',
      status: 'draft',
    };
    return { status: 201, body: invoices.insert(invoice) };
  });

  router.on('GET', '/invoices', () => ({
    status: 200,
    body: invoices.all().map((inv) => ({
      ...inv,
      label: STATUS_LABELS[inv.status],
      amount: `${(inv.amountCents / 100).toFixed(2)} ${inv.currency.toUpperCase()}`,
    })),
  }));
}
