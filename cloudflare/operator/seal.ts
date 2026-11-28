import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { open, writeFile } from 'node:fs/promises';
import { approvedOrigin, MAX_PLAINTEXT_BYTES, seal, sha256, stagingPrefix } from './envelope.js';
import { parseSnapshot } from './snapshot.js';

async function main(): Promise<void> {
  const [origin, key, source, ciphertext, secretFile] = process.argv.slice(2);
  if (process.argv.length !== 7 || !origin || !key || !source || !ciphertext || !secretFile) {
    throw new Error('usage');
  }
  process.umask(0o077);
  approvedOrigin(origin);
  stagingPrefix(key);
  const file = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const plaintext = new Uint8Array(MAX_PLAINTEXT_BYTES + 1);
  let length = 0;
  try {
    try {
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        (stat.mode & 0o077) !== 0 ||
        stat.uid !== process.getuid?.() ||
        stat.size === 0 ||
        stat.size > MAX_PLAINTEXT_BYTES
      )
        throw new Error('input');
      while (length < plaintext.length) {
        const { bytesRead } = await file.read(plaintext, length, plaintext.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
    } finally {
      await file.close();
    }
    if (length === 0 || length > MAX_PLAINTEXT_BYTES) throw new Error('size');
    const bytes = plaintext.subarray(0, length);
    const { accounts } = parseSnapshot(bytes, origin);
    const secret = randomBytes(32).toString('hex');
    const envelope = await seal(bytes, secret, { key, origin });
    await writeFile(secretFile, secret, { flag: 'wx', mode: 0o600 });
    await writeFile(ciphertext, envelope, { flag: 'wx', mode: 0o600 });
    process.stdout.write(
      `${JSON.stringify({
        sha256: await sha256(envelope),
        accountsVerified: accounts.length,
        documentsVerified: accounts.reduce((n, account) => n + account.documents.length, 0),
      })}\n`,
    );
  } finally {
    plaintext.fill(0);
  }
}

main().catch(() => {
  process.stderr.write(
    'Sealing failed. Check private file ownership/modes, fresh output paths, snapshot capacity/schema and approved origin/key.\n',
  );
  process.exitCode = 1;
});
