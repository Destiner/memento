---
id: mem_01KRA5AR00QKS0SYYEYFXFMQK1
title: Rate limiting for the public API
description: The public API uses a per-key token bucket with burst allowance.
scope:
  kind: projects
  project_ids:
    - prj_HARNESS
type: product_rationale
provenance:
  source: external_reference
  verification: source_confirmed
status: active
created_at: 2026-05-11T00:00:00Z
updated_at: 2026-05-11T00:00:00Z
---

## Summary

The public API enforces a token bucket rate limit per API key with burst allowance.
