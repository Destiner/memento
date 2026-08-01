---
id: mem_01KQNJ5000Z7G536TT0C5VFRJ1
title: Stripe webhook retry behaviour
description: Stripe retries failed webhooks, so handlers must remain idempotent under redelivery.
scope:
  kind: projects
  project_ids:
    - prj_HARNESS
type: environment_workflow_quirk
provenance:
  source: external_reference
  verification: source_confirmed
status: active
created_at: 2026-05-03T00:00:00Z
updated_at: 2026-05-03T00:00:00Z
---

## Summary

Stripe retries failed webhooks with exponential backoff; handlers must be idempotent to avoid double processing.
