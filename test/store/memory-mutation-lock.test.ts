import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import {
  usesPrivateMemoryFilesystem,
  withMemoryMutationLock,
  withSerializedMemoryStore,
} from '../../src/store/memory-mutation-lock.js';

describe('memory mutation lock', () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('serializes mutations and releases safely for the next operation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'memento-lock-'));
    directories.push(root);
    const memoriesDir = join(root, 'memories');
    let signalAcquired: (() => void) | undefined;
    let signalRelease: (() => void) | undefined;
    const acquired = new Promise<void>((resolve) => {
      signalAcquired = resolve;
    });
    const release = new Promise<void>((resolve) => {
      signalRelease = resolve;
    });
    const held = withMemoryMutationLock(memoriesDir, async () => {
      signalAcquired?.();
      await release;
    });
    await acquired;

    await expect(withMemoryMutationLock(memoriesDir, async () => 'blocked')).rejects.toThrow(
      /already being mutated/,
    );
    signalRelease?.();
    await held;
    await expect(withMemoryMutationLock(memoriesDir, async () => 'next')).resolves.toBe('next');
  });

  test('private lock bypass stays in its async scope and applies only to the named store', async () => {
    const root = mkdtempSync(join(tmpdir(), 'memento-lock-'));
    directories.push(root);
    const privateDir = join(root, 'private');
    const sharedDir = join(root, 'shared');
    let signalAcquired!: () => void;
    let signalRelease!: () => void;
    const acquired = new Promise<void>((resolve) => (signalAcquired = resolve));
    const release = new Promise<void>((resolve) => (signalRelease = resolve));
    const held = withMemoryMutationLock(sharedDir, async () => {
      signalAcquired();
      await release;
    });
    try {
      await acquired;
      await Promise.all([
        withSerializedMemoryStore(privateDir, async () => {
          await Promise.resolve();
          expect(usesPrivateMemoryFilesystem()).toBe(true);
          await expect(withMemoryMutationLock(privateDir, async () => 'private')).resolves.toBe(
            'private',
          );
          await expect(withMemoryMutationLock(sharedDir, async () => 'blocked')).rejects.toThrow(
            /already being mutated/,
          );
        }),
        Promise.resolve().then(() => expect(usesPrivateMemoryFilesystem()).toBe(false)),
      ]);
      expect(usesPrivateMemoryFilesystem()).toBe(false);
    } finally {
      signalRelease();
      await held;
    }
  });
});
