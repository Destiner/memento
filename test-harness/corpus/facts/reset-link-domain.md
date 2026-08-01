---
id: mem_01KS4B7Q00Z8Q3M5T7VNKD9R2A
title: 'Password-reset links must use account.acme.io'
description: Account-security links use account.acme.io because the old marketing domain has no reset route.
scope:
  kind: projects
  project_ids:
    - prj_HARNESS
type: product_rationale
provenance:
  source: user_stated
  verification: user_confirmed
status: active
created_at: 2026-05-22T00:00:00Z
updated_at: 2026-05-22T00:00:00Z
---

## Summary

Password-reset and other account-security links must point at
`https://account.acme.io/reset`. The old `app.example.com` domain is the legacy
marketing site — it has no reset route and returns a 404 in production.

## Context

When the product was split from the marketing site, all account flows moved to
the `account.acme.io` host. A batch of reset emails kept building links against
`app.example.com`, and every one of them dead-ended on a 404, generating support
tickets from users who could not reset their passwords.

## Guidance

Build password-reset URLs from `https://account.acme.io/reset`. Do not use
`app.example.com` for any account-security link.

## When to revisit

If account flows move to a new host, or the marketing and account domains are
reunified behind a single router.
