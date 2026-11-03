import { describe, expect, it, vi } from 'vitest';

import { createShutdown } from '../src/shutdown.js';

describe('createShutdown', () => {
  it('logs every client out before exiting', async () => {
    const order: string[] = [];
    const closable = (name: string) => ({
      close: async () => {
        order.push(name);
      },
    });
    const shutdown = createShutdown(
      () => [closable('a'), closable('b')],
      (code) => order.push(`exit ${code}`)
    );
    await shutdown(0);
    expect(order).toEqual(['a', 'b', 'exit 0']);
  });

  it('exits once, however often it is asked', async () => {
    const exit = vi.fn();
    const shutdown = createShutdown(() => [], exit);
    await Promise.all([shutdown(0), shutdown(0), shutdown(1)]);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('exits after the grace period when a LOGOUT never answers', async () => {
    vi.useFakeTimers();
    try {
      const exit = vi.fn();
      const shutdown = createShutdown(
        () => [{ close: () => new Promise<void>(() => {}) }],
        exit,
        500
      );
      void shutdown(0);
      await vi.advanceTimersByTimeAsync(600);
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still exits when a close rejects', async () => {
    const exit = vi.fn();
    const shutdown = createShutdown(
      () => [{ close: () => Promise.reject(new Error('gone')) }],
      exit
    );
    await shutdown(0);
    expect(exit).toHaveBeenCalledWith(0);
  });
});
