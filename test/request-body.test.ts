import { expect, test } from 'vitest';
import { bufferRequest } from '../src/request-body.js';

test('bounds incomplete streaming uploads by time', async () => {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode('partial'));
    },
  });
  const request = new Request('https://example.test/upload', {
    method: 'POST',
    body,
    duplex: 'half',
  } as RequestInit);
  await expect(bufferRequest(request, 100, 20)).rejects.toMatchObject({ status: 408 });
});

test('bounds bytes even when the content length is understated', async () => {
  const request = new Request('https://example.test/upload', {
    method: 'POST',
    headers: { 'content-length': '1' },
    body: 'too large',
  });
  await expect(bufferRequest(request, 3)).rejects.toMatchObject({ status: 413 });
});
