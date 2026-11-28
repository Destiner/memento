export const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;

// Leave headroom below Workers' 32 MiB serialized RPC limit.
export const MAX_RPC_ESTIMATE_BYTES = 24 * 1024 * 1024;
