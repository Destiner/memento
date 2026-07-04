// Validation helper. Tool handlers validate incoming MCP arguments against a
// zod schema before touching the filesystem; failures surface as a single
// canonical validation_error listing each offending field.

import type { ZodType } from 'zod';

import { MementoError } from './errors.js';

export interface FieldError {
  path: string;
  message: string;
}

// Parse untrusted data against a schema, returning it typed on success and
// throwing a validation_error (with per-field detail) on failure.
export function validate<T>(schema: ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (result.success) {
    return result.data;
  }
  const details: FieldError[] = result.error.issues.map((issue) => ({
    path: issue.path.length ? `/${issue.path.join('/')}` : '/',
    message: issue.message,
  }));
  throw new MementoError('validation_error', 'Input failed schema validation.', details);
}
