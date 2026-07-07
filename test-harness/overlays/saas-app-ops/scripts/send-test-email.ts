// Discovery artifact for the write/email-sandbox-stream scenario (harness-spec
// §4.3). A naive send is rejected with a vendor-sandbox constraint the agent must
// discover to finish. The insight — the shared Postmark sandbox account has only
// the "outbound" message stream active — is external-tooling context shared across
// every project on that account, so it belongs in memory, not this repo (§3).

import { writeFileSync } from 'node:fs';

if (process.env.POSTMARK_STREAM !== 'outbound') {
  console.error(
    'send-test-email: Postmark rejected the send. The default message stream is inactive on ' +
      'our shared sandbox account; only the "outbound" stream is provisioned. Set ' +
      'POSTMARK_STREAM=outbound and retry. This is true for every project pointed at the ' +
      'shared Postmark sandbox account.',
  );
  process.exit(1);
}

writeFileSync('.test-email-sent', 'ok\n');
console.log('test email sent via the outbound stream');
