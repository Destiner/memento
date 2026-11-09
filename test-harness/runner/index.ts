#!/usr/bin/env bun

import { HARNESS_EXECUTION_DISABLED } from './execution-policy.js';

// Fail before loading manifests, building servers, copying auth, or launching agents.
console.error(HARNESS_EXECUTION_DISABLED);
process.exitCode = 1;
