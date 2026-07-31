export interface Job {
  kind: string;
  payload: Record<string, unknown>;
}

export type QueueTransport = (jobs: Job[]) => Promise<void>;

// Default transport is swapped out in tests and ops scripts; the real broker
// client is injected at boot.
let transport: QueueTransport = async () => {};

export function setTransport(next: QueueTransport): void {
  transport = next;
}

export async function enqueue(job: Job): Promise<void> {
  await transport([job]);
}

export async function enqueueBatch(jobs: Job[]): Promise<void> {
  await transport(jobs);
}
