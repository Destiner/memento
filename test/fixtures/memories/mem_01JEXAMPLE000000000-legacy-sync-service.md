---
id: mem_01JEXAMPLE000000000
title: "Legacy sync service: current product role"
description: The legacy sync service stays for enterprise imports that have not migrated; code-usage signals understate its role.
scope:
  kind: projects
  project_ids:
    - prj_01JEXAMPLEPRJ000001
    - prj_01JEXAMPLEPRJ000002
type: product_rationale
provenance:
  source: user_stated
  verification: user_confirmed
  evidence:
    - kind: issue
      value: PLAT-4127
      note: enterprise migration tracking
status: active
created_at: 2026-07-04T15:00:00Z
updated_at: 2026-07-04T15:00:00Z
---

## Context

The service can look redundant from the code alone because its primary users are a
limited set of enterprise customers. Removing it requires validating migration
status and contract commitments, not only code references.

## Guidance

Do not schedule the legacy sync service for deletion based on code usage signals
alone. Confirm enterprise migration status first.

## When to revisit

Once all enterprise customers have migrated to the new onboarding path.
