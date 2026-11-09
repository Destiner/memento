import type { ResolvedConfig } from '../config.js';
import { openIndex } from './index-open.js';
import { decayMemories } from './memory-decay.js';
import type { MemoryIndex } from './search-index.js';

/** One account's store lifetime, independent of its MCP connections. */
export class StoreContext {
  private pending: Promise<void> = Promise.resolve();
  private closing?: Promise<void>;

  constructor(
    readonly resolved: ResolvedConfig,
    readonly index: MemoryIndex,
  ) {}

  enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error('The memory store is closed.'));
    const task = this.pending.then(operation);
    this.pending = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  // Called inside the queue, so retention cannot race reads or writes.
  async maintain(): Promise<void> {
    const result = await decayMemories({
      memoriesDir: this.resolved.paths.memories,
      index: this.index,
      config: this.resolved.config,
    });
    if (result.skipped.length) {
      console.error(`Memento retention skipped ${result.skipped.length} invalid or unsafe files.`);
    }
  }

  close(): Promise<void> {
    this.closing ??= this.pending.then(() => this.index.close());
    return this.closing;
  }
}

export async function openStore(resolved: ResolvedConfig): Promise<StoreContext> {
  // Own a snapshot: callers must not redirect a live account's paths or policy.
  const snapshot: ResolvedConfig = Object.freeze({
    ...resolved,
    paths: Object.freeze({ ...resolved.paths }),
    config: Object.freeze({ ...resolved.config }),
  });
  const { index } = await openIndex({
    indexDir: snapshot.paths.index,
    memoriesDir: snapshot.paths.memories,
  });
  return new StoreContext(snapshot, index);
}
