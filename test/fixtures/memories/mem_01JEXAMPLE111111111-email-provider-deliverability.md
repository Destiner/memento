---
id: mem_01JEXAMPLE111111111
title: "ExampleEmailVendor: deliverability caveat"
description: The provider delays webhook events at peak volume, so delivery time is not a freshness signal.
scope:
  kind: projects
  project_ids:
    - prj_01JEXAMPLEPRJ000003
    - prj_01JEXAMPLEPRJ000002
type: environment_workflow_quirk
provenance:
  source: agent_observed
  verification: observed_once
  evidence:
    - kind: issue
      value: acme/marketing-api#812
      note: incident triage thread
status: active
created_at: 2026-06-18T09:30:00Z
updated_at: 2026-06-20T11:00:00Z
---

## Context

During the 2026-06-18 incident, retry logic that assumed immediate webhook delivery
produced duplicate sends.

## Guidance

Preserve idempotency keys and avoid retry policies that assume webhooks arrive
promptly during peak load.

## Caveats

Observed once during a single incident; the magnitude of the delay under sustained
load is not yet quantified.
