---
id: mem_01KQX9B500YN304P8D82M5AK06
title: Regression test pattern for flaky timers
description: Fake timers make time-dependent regression tests deterministic.
scope:
  kind: projects
  project_ids:
    - prj_HARNESS
type: debugging_pattern
provenance:
  source: external_reference
  verification: source_confirmed
status: active
created_at: 2026-05-06T00:00:00Z
updated_at: 2026-05-06T00:00:00Z
---

## Summary

Use fake timers to make time-dependent tests deterministic and remove flakiness from timer-based code.
