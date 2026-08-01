---
id: mem_01KQTPYE00VC0B0NGB2418Z8AH
title: Idempotent webhook processing incident lesson
description: Duplicate webhook processing caused charges and is identified by repeated event ids.
scope:
  kind: projects
  project_ids:
    - prj_HARNESS
type: debugging_pattern
provenance:
  source: external_reference
  verification: source_confirmed
status: active
created_at: 2026-05-05T00:00:00Z
updated_at: 2026-05-05T00:00:00Z
---

## Summary

A prior incident caused duplicate charges; deduplicate by event id when processing webhooks to stay idempotent.
