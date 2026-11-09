export class BodyLimitError extends Error {
  constructor(readonly status: 408 | 413) {
    super(status === 413 ? 'Request body too large.' : 'Request body timed out.');
  }
}

/** Bound uploads before entering a database critical section. */
export async function bufferRequest(
  request: Request,
  maxBytes: number,
  timeoutMs = 10_000,
): Promise<Request> {
  if (!request.body) return request;
  const length = Number(request.headers.get('content-length'));
  if (Number.isFinite(length) && length > maxBytes) throw new BodyLimitError(413);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new BodyLimitError(408));
      void reader.cancel().catch(() => undefined);
    }, timeoutMs);
  });
  try {
    while (true) {
      const part = await Promise.race([reader.read(), expired]);
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maxBytes) {
        void reader.cancel().catch(() => undefined);
        throw new BodyLimitError(413);
      }
      chunks.push(part.value);
    }
    const headers = new Headers(request.headers);
    headers.delete('transfer-encoding');
    headers.set('content-length', String(size));
    return new Request(request.url, {
      method: request.method,
      headers,
      body: Buffer.concat(chunks),
      signal: request.signal,
    });
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}
