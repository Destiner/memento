---
id: mem_01KS4C9X00H7P2S4W6YQ3B8N5K
title: 'Security contact for account emails is security@acme.io'
type: working_agreement
scope: cross_project
status: active
created_at: 2026-05-23T00:00:00Z
updated_at: 2026-05-23T00:00:00Z
projects:
  - customer-portal
  - marketing-api
entities:
  - security@acme.io
  - password-reset
tags:
  - email
  - security
  - support
confidence: high
importance: medium
source_kind: decision
---

## Summary

Account-security emails — password resets and sign-in alerts — must tell users
to contact `security@acme.io` if they did not request the action. That inbox is
watched by the on-call security rotation.

## Context

An unrequested password-reset email is often the first sign of an account-takeover
attempt, but users had nowhere to report one: the emails carried no contact
address, and replies to the noreply sender were discarded unseen.

## Guidance

Include a line in account-security emails directing users to `security@acme.io`
to report anything they did not initiate. Do not route these to a general support
alias — the monitored inbox is the security one.

## When to revisit

If the security on-call inbox changes, or reporting moves to an in-app flow.
