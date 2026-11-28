import type { DurableObjectId, R2Bucket, ScheduledController } from '@cloudflare/workers-types';
import type { AccountDocument } from '../account-store.js';
import {
  approvedOrigin,
  MAX_ENVELOPE_BYTES,
  MIN_ENVELOPE_BYTES,
  open,
  sha256,
  SHA256_HEX,
  stagingPrefix,
} from './envelope.js';
import { parseSnapshot, type Snapshot } from './snapshot.js';

type Namespace<T> = { idFromName(name: string): DurableObjectId; get(id: DurableObjectId): T };

interface Env {
  STAGING: R2Bucket;
  MEMENTO_AUTH: Namespace<{ importSnapshot(snapshot: Snapshot['auth']): Promise<true> }>;
  MEMENTO_ACCOUNTS: Namespace<{ importDocuments(documents: AccountDocument[]): Promise<true> }>;
  STAGING_KEY: string;
  EXPECTED_SHA256: string;
  EXPECTED_ORIGIN: string;
  SCHEDULED_AT: string;
  MIGRATION_KEY: string;
}

const MINUTE_MS = 60_000;
const GRACE_MS = 10 * MINUTE_MS;
const CREATE_ONLY = { onlyIf: { etagDoesNotMatch: '*' } };

function cronFor(time: Date) {
  return `${time.getUTCMinutes()} ${time.getUTCHours()} ${time.getUTCDate()} ${time.getUTCMonth() + 1} *`;
}

function inWindow(time: number): boolean {
  const now = Date.now();
  return now >= time && now < time + GRACE_MS;
}

export default {
  async scheduled(event: ScheduledController, env: Env): Promise<void> {
    event.noRetry();
    let phase = 'configuration';
    let claim = false;
    let authVerified = false;
    let accountsVerified = 0;
    let documentsVerified = 0;
    let receiptKey = '';
    try {
      const time = new Date(env.SCHEDULED_AT);
      const scheduled = time.getTime();
      if (time.toISOString() !== env.SCHEDULED_AT || scheduled % MINUTE_MS !== 0) {
        throw new Error('configuration');
      }
      // Hosted Cron can report a timestamp inside the scheduled UTC minute.
      const eventMinute = Math.floor(event.scheduledTime / MINUTE_MS) * MINUTE_MS;
      if (event.cron !== cronFor(time) || eventMinute !== scheduled || !inWindow(scheduled)) {
        return;
      }
      const prefix = stagingPrefix(env.STAGING_KEY);
      const claimKey = `${prefix}claim.json`;
      receiptKey = `${prefix}receipt.json`;
      const origin = approvedOrigin(env.EXPECTED_ORIGIN);
      if (!SHA256_HEX.test(env.EXPECTED_SHA256) || !SHA256_HEX.test(env.MIGRATION_KEY)) {
        throw new Error('configuration');
      }

      phase = 'staging';
      if ((await env.STAGING.head(claimKey)) || (await env.STAGING.head(receiptKey))) return;
      const object = await env.STAGING.get(env.STAGING_KEY);
      if (!object) throw new Error('missing');
      if (object.size < MIN_ENVELOPE_BYTES || object.size > MAX_ENVELOPE_BYTES) {
        await object.body.cancel();
        throw new Error('size');
      }
      const envelope = await object.arrayBuffer();
      if (envelope.byteLength !== object.size) throw new Error('size');
      phase = 'hash';
      if ((await sha256(envelope)) !== env.EXPECTED_SHA256) throw new Error('hash');
      phase = 'decrypt';
      const plaintext = await open(envelope, env.MIGRATION_KEY, { key: env.STAGING_KEY, origin });
      phase = 'snapshot';
      let snapshot: Snapshot;
      try {
        snapshot = parseSnapshot(plaintext, origin);
      } finally {
        plaintext.fill(0);
      }

      // The strongly consistent, create-only claim is the point of no automatic return.
      // Keep it even if the runtime dies between RPC commit and acknowledgement.
      phase = 'claim';
      if (!inWindow(scheduled)) throw new Error('expired');
      const metadata = { version: 1, sha256: env.EXPECTED_SHA256, scheduledAt: env.SCHEDULED_AT };
      claim = Boolean(await env.STAGING.put(claimKey, JSON.stringify(metadata), CREATE_ONLY));
      if (!claim) return;

      // Auth checks the destination's configured origin and verifies its durable readback.
      phase = 'auth';
      const auth = env.MEMENTO_AUTH.get(env.MEMENTO_AUTH.idFromName('auth-v1'));
      if ((await auth.importSnapshot(snapshot.auth)) !== true) throw new Error('auth_verification');
      authVerified = true;
      phase = 'accounts';
      for (const account of snapshot.accounts) {
        const target = env.MEMENTO_ACCOUNTS.get(env.MEMENTO_ACCOUNTS.idFromName(account.id));
        if ((await target.importDocuments(account.documents)) !== true) {
          throw new Error('document_verification');
        }
        accountsVerified++;
        documentsVerified += account.documents.length;
      }
      phase = 'receipt';
      const result = await env.STAGING.put(
        receiptKey,
        JSON.stringify({
          ...metadata,
          status: 'verified',
          authVerified,
          accountsVerified,
          documentsVerified,
        }),
        CREATE_ONLY,
      );
      if (!result) throw new Error('receipt');
    } catch {
      if (claim) {
        // Best-effort diagnostics only; claim without a verified receipt always blocks release.
        try {
          await env.STAGING.put(
            receiptKey,
            JSON.stringify({
              version: 1,
              sha256: env.EXPECTED_SHA256,
              scheduledAt: env.SCHEDULED_AT,
              status: 'failed',
              phase,
              authVerified,
              accountsVerified,
              documentsVerified,
            }),
            CREATE_ONLY,
          );
        } catch {
          /* A claim alone is sufficient to block release. */
        }
      }
      // Do not pass through exceptions (including RPC/crypto/JSON errors) or runtime bindings.
      throw new Error(`memento_migration_${phase}`);
    }
  },
};
