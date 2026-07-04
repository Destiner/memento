// Canonical error shape shared across Memento's MCP tools. Handlers throw
// MementoError; the server layer converts it into a structured response so
// agents receive a stable { code, message, details } contract.

export type MementoErrorCode =
  | 'validation_error' // input failed schema / vocabulary checks
  | 'not_found' // referenced memory or version does not exist
  | 'version_conflict' // expected_version did not match current
  | 'invalid_request' // well-formed but semantically rejected
  | 'internal_error'; // unexpected failure

export interface MementoErrorShape {
  code: MementoErrorCode;
  message: string;
  details?: unknown;
}

export class MementoError extends Error {
  readonly code: MementoErrorCode;
  readonly details?: unknown;

  constructor(code: MementoErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'MementoError';
    this.code = code;
    this.details = details;
  }

  toShape(): MementoErrorShape {
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: this.details };
  }
}

// Narrow an unknown thrown value into the canonical shape. Non-MementoErrors
// collapse to internal_error without leaking stack traces to callers.
export function toErrorShape(error: unknown): MementoErrorShape {
  if (error instanceof MementoError) {
    return error.toShape();
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: 'internal_error', message };
}
