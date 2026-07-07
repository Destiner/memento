---
id: mem_01KQJZR90012TNYZG7H1AQQNPG
title: ExampleEmailVendor deliverability caveat
type: integration
scope: external_tooling
status: active
created_at: 2026-05-02T00:00:00Z
updated_at: 2026-05-02T00:00:00Z
entities:
  - ExampleEmailVendor
tags:
  - deliverability
  - webhooks
---

## Summary

Webhook delivery from the email vendor can lag at peak volume, so retry policies that assume prompt delivery fail.
