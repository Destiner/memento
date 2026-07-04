---
id: mem_01JEXAMPLE000000000
title: "Legacy sync service: current product role"
type: product_context
scope: cross_project
status: active
created_at: 2026-07-04T15:00:00Z
updated_at: 2026-07-04T15:00:00Z
version: 1
projects:
  - legacy-sync
  - customer-portal
entities:
  - legacy-sync
  - enterprise-imports
tags:
  - migration
  - customer-workflow
confidence: high
importance: high
review_after: 2026-10-01
source_kind: observed
source_refs:
  - "product planning discussion, 2026-07"
---

## Summary

The legacy sync service remains in place for enterprise import workflows that have not yet migrated to the customer portal's new onboarding path.

## Context

The service can look redundant from the code alone because its primary users are a limited set of enterprise customers. Its removal requires validating migration status and contract commitments, not only code references.

## Guidance

Do not schedule the legacy sync service for deletion based on code usage signals alone. Confirm enterprise migration status first.

## Evidence / caveats

Based on a product planning discussion; migration status may change as customers onboard.

## When to revisit

Once all enterprise customers have migrated to the new onboarding path.
