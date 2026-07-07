---
id: mem_01KQNJ5000Z7G536TT0C5VFRJ1
title: Stripe webhook retry behaviour
type: integration
scope: cross_project
status: active
created_at: 2026-05-03T00:00:00Z
updated_at: 2026-05-03T00:00:00Z
entities:
  - Stripe
tags:
  - webhooks
  - retry
---

## Summary

Stripe retries failed webhooks with exponential backoff; handlers must be idempotent to avoid double processing.
