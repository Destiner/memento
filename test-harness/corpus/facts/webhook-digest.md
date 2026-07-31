---
id: mem_01KYWD1G00X7Q4RZV8N2M5PC3H
title: 'Webhook verification: HMAC-SHA512 via X-Hook-Digest, not the provider default'
type: decision
scope: cross_project
status: active
entities:
  - billing-provider
  - webhooks
tags:
  - security
  - webhooks
  - integration
confidence: high
importance: high
created_at: 2026-06-02T10:00:00Z
updated_at: 2026-06-02T10:00:00Z
---

## Summary

Inbound billing-provider webhooks are verified with an HMAC-SHA512 hex digest
of the raw request body, carried in the `X-Hook-Digest` header and keyed by
`WEBHOOK_SECRET`. The provider's documented default (`X-Hook-Signature` with
SHA-256) is deprecated org-wide.

## Context

After a spoofed-webhook incident, security standardized every service on the
provider's enterprise signing scheme (SHA-512 digest header) and rotated all
secrets. The provider docs still lead with the legacy default, so new
integrations copy the wrong scheme unless they know about this decision.

## Guidance

Verify `X-Hook-Digest` (hex HMAC-SHA512 over the raw body, keyed by
`WEBHOOK_SECRET`) before processing any provider event. Reject requests with a
missing or mismatched digest. Do not implement the `X-Hook-Signature`/SHA-256
variant from the provider's quickstart.

## Evidence / caveats

Incident retro 2026-05; provider enterprise-signing docs. The legacy header
keeps working on the provider side, which is exactly why copying the
quickstart is dangerous.

## When to revisit

If the provider retires the legacy scheme or the org rotates to asymmetric
signatures.
