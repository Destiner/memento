---
id: mem_01JEXAMPLE222222222
title: Flaky checkout test needs a seeded clock
description: The checkout reservation test flakes near minute boundaries because expiry is computed from wall-clock time.
scope:
  kind: projects
  project_ids:
    - prj_01JEXAMPLEPRJ000002
type: debugging_pattern
provenance:
  source: agent_observed
  verification: source_confirmed
  evidence:
    - kind: path
      value: test/checkout/reservation.test.ts
status: active
created_at: 2026-05-02T13:15:00Z
updated_at: 2026-05-02T13:15:00Z
last_verified_at: 2026-06-30T08:00:00Z
---

## Context

The test asserts on a 15-minute reservation window; runs near a minute boundary
intermittently fail.

## Guidance

Inject a fixed clock in the checkout reservation test rather than relying on the
real time.

## When to revisit

If reservation windows move to a monotonic timer instead of wall-clock time.
