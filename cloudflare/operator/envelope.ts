import { MAX_SNAPSHOT_BYTES } from '../snapshot-limits.js';

const MAGIC = new TextEncoder().encode('MEMCFv1\0');
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const OVERHEAD = MAGIC.length + NONCE_BYTES + TAG_BYTES;
export const MAX_PLAINTEXT_BYTES = MAX_SNAPSHOT_BYTES;
export const MIN_ENVELOPE_BYTES = OVERHEAD + 1;
export const MAX_ENVELOPE_BYTES = MAX_PLAINTEXT_BYTES + OVERHEAD;
export const SHA256_HEX = /^[0-9a-f]{64}$/;

export type Context = { key: string; origin: string };

export function stagingPrefix(key: string): string {
  if (!/^migration\/[0-9a-f]{32}\/snapshot\.aead$/.test(key)) throw new Error('staging_key');
  return key.slice(0, -'snapshot.aead'.length);
}

export function approvedOrigin(value: string): string {
  const url = new URL(value);
  const labels = url.hostname.split('.');
  if (
    url.protocol !== 'https:' ||
    url.origin !== value ||
    labels.length < 2 ||
    url.hostname.length > 253 ||
    !labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
    !/[a-z]/.test(labels.at(-1)!) ||
    /(?:^|\.)(?:workers\.dev|onrender\.com|pages\.dev|localhost|local)$/.test(url.hostname) ||
    url.port
  )
    throw new Error('origin');
  return value;
}

function aad(context: Context): Uint8Array<ArrayBuffer> {
  stagingPrefix(context.key);
  approvedOrigin(context.origin);
  return new TextEncoder().encode(JSON.stringify(['memento-cf-v1', context.key, context.origin]));
}

async function importKey(secret: string, usage: 'encrypt' | 'decrypt') {
  if (!SHA256_HEX.test(secret)) throw new Error('secret_format');
  const bytes = Uint8Array.from(secret.match(/../g)!, (part) => parseInt(part, 16));
  try {
    return await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, [usage]);
  } finally {
    bytes.fill(0);
  }
}

export async function sha256(bytes: ArrayBuffer | Uint8Array<ArrayBuffer>): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function seal(
  plaintext: Uint8Array<ArrayBuffer>,
  secret: string,
  context: Context,
): Promise<Uint8Array<ArrayBuffer>> {
  if (plaintext.length === 0 || plaintext.length > MAX_PLAINTEXT_BYTES) throw new Error('size');
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: aad(context), tagLength: 128 },
    await importKey(secret, 'encrypt'),
    plaintext,
  );
  const result = new Uint8Array(MAGIC.length + nonce.length + ciphertext.byteLength);
  result.set(MAGIC);
  result.set(nonce, MAGIC.length);
  result.set(new Uint8Array(ciphertext), MAGIC.length + nonce.length);
  return result;
}

export async function open(
  envelope: ArrayBuffer,
  secret: string,
  context: Context,
): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = new Uint8Array(envelope);
  if (
    bytes.length < MIN_ENVELOPE_BYTES ||
    bytes.length > MAX_ENVELOPE_BYTES ||
    !MAGIC.every((value, i) => bytes[i] === value)
  )
    throw new Error('envelope');
  return new Uint8Array(
    await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: bytes.subarray(MAGIC.length, MAGIC.length + NONCE_BYTES),
        additionalData: aad(context),
        tagLength: 128,
      },
      await importKey(secret, 'decrypt'),
      bytes.subarray(MAGIC.length + NONCE_BYTES),
    ),
  );
}
