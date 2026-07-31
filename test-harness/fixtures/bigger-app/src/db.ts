export interface User {
  id: string;
  email: string;
  createdAt: number;
}

export type InvoiceStatus = 'draft' | 'open' | 'paid' | 'void';

export interface Invoice {
  id: string;
  userId: string;
  amountCents: number;
  currency: string;
  status: InvoiceStatus;
}

export class Repo<T extends { id: string }> {
  private rows = new Map<string, T>();

  insert(row: T): T {
    if (this.rows.has(row.id)) throw new Error(`duplicate id ${row.id}`);
    this.rows.set(row.id, row);
    return row;
  }

  get(id: string): T | undefined {
    return this.rows.get(id);
  }

  update(id: string, patch: Partial<T>): T {
    const row = this.rows.get(id);
    if (!row) throw new Error(`no row ${id}`);
    const next = { ...row, ...patch, id };
    this.rows.set(id, next);
    return next;
  }

  all(): T[] {
    return [...this.rows.values()];
  }
}

export const users = new Repo<User>();
export const invoices = new Repo<Invoice>();
