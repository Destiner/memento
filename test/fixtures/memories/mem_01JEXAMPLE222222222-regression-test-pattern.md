---
id: mem_01JEXAMPLE222222222
title: Flaky checkout test needs a seeded clock
type: pattern
scope: project
status: active
created_at: 2026-05-02T13:15:00Z
updated_at: 2026-05-02T13:15:00Z
version: 1
projects:
  - customer-portal
entities:
  - checkout
tags:
  - testing
  - flaky
  - time
confidence: high
importance: medium
---

## Summary

The checkout integration test is flaky unless the system clock is seeded, because expiry windows are computed from wall-clock time.

## Context

The test asserts on a 15-minute reservation window; runs near a minute boundary intermittently fail.

## Guidance

Inject a fixed clock in the checkout reservation test rather than relying on the real time.

## Evidence / caveats

Reproduced by running the suite in a tight loop around minute boundaries.

## When to revisit

If reservation windows move to a monotonic timer instead of wall-clock time.
