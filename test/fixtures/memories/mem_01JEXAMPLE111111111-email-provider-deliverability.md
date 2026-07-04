---
id: mem_01JEXAMPLE111111111
title: "ExampleEmailVendor: deliverability caveat"
type: integration
scope: cross_project
status: active
created_at: 2026-06-18T09:30:00Z
updated_at: 2026-06-20T11:00:00Z
version: 2
projects:
  - marketing-api
  - customer-portal
entities:
  - ExampleEmailVendor
  - transactional-email
tags:
  - deliverability
  - webhooks
confidence: medium
importance: medium
review_after: 2026-10-04
source_kind: observed
source_refs:
  - "2026-06-18 incident triage"
---

## Summary

The provider delays webhook events during peak volume; do not use webhook delivery time as a hard freshness signal.

## Context

During the 2026-06-18 incident, retry logic that assumed immediate webhook delivery produced duplicate sends.

## Guidance

Preserve idempotency keys and avoid retry policies that assume webhooks arrive promptly during peak load.

## Evidence / caveats

Observed once during a single incident; magnitude of delay under sustained load is not yet quantified.

## When to revisit

If the vendor publishes a delivery SLA or the incident recurs.
