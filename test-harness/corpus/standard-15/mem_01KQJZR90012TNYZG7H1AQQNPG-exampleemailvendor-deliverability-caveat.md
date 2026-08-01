---
id: mem_01KQJZR90012TNYZG7H1AQQNPG
title: ExampleEmailVendor deliverability caveat
description: Email-vendor webhooks can lag at peak volume and make prompt-delivery assumptions fail.
scope:
  kind: projects
  project_ids:
    - prj_HARNESS
type: environment_workflow_quirk
provenance:
  source: external_reference
  verification: source_confirmed
status: active
created_at: 2026-05-02T00:00:00Z
updated_at: 2026-05-02T00:00:00Z
---

## Summary

Webhook delivery from the email vendor can lag at peak volume, so retry policies that assume prompt delivery fail.
