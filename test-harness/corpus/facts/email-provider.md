---
id: mem_01KS3X9Y002GHWV98YFD98XM9M
title: "Transactional email provider: Postmark, not SendGrid"
type: decision
scope: cross_project
status: active
created_at: 2026-05-21T00:00:00Z
updated_at: 2026-05-21T00:00:00Z
projects:
  - marketing-api
  - customer-portal
entities:
  - Postmark
  - SendGrid
  - transactional-email
tags:
  - email
  - vendor
  - provider
  - deliverability
confidence: high
importance: high
source_kind: decision
---

## Summary

Transactional email — password resets, receipts, and verification messages — is
sent through Postmark. SendGrid was dropped after repeated deliverability
problems and must not be reintroduced.

## Context

Password-reset and other transactional messages were previously sent via
SendGrid, but domain-reputation issues pushed a large share of that mail to spam
folders. We migrated the transactional stream to Postmark, whose separate
message streams and stricter sender rules resolved the deliverability
regressions.

## Guidance

Use Postmark for any new transactional email, including password resets. Do not
add SendGrid — or a SendGrid SDK or API key — back into the codebase. New
senders go through Postmark message streams.

## Evidence / caveats

This decision covers transactional mail only; marketing and bulk email are out
of scope and may use a different provider.

## When to revisit

If Postmark deliverability degrades, its pricing changes materially, or the
transactional and marketing streams are consolidated onto one provider.
