export const HARNESS_EXECUTION_DISABLED =
  'Paid harness execution is disabled for cloud-only Memento. ' +
  'It requires isolated authenticated HTTP fixture accounts, remote corpus lifecycle, ' +
  'and authoritative per-rep server telemetry before it can run safely. ' +
  'No production stdio server or local memory fallback will be launched. ' +
  'Offline tests and harness:report remain available.';
