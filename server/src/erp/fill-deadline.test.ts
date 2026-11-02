import { describe, expect, it, vi } from 'vitest';
import type { ExecutorChannel, ExecutorEvent } from '@baox/erp-executor/protocol';
import { withinDeadline } from './fill-jobs';
import { manualTimers } from '../test/timers';

const step = { type: 'step', step: 'fill', status: 'running', progress: { done: 1, total: 3 } } satisfies ExecutorEvent;
const forever = () => new Promise<never>(() => undefined);

describe('job deadline gate', () => {
  it('reports expiry even when abort synchronously rejects the executor', async () => {
    const timers = manualTimers();
    const job = withinDeadline({ policy: { kind: 'absolute', timeoutMs: 5 }, schedule: timers.schedule },
      vi.fn<(event: ExecutorEvent) => Promise<unknown>>().mockResolvedValue(undefined) as ExecutorChannel['emit'], (_channel, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('executor aborted')));
      }));
    timers.advanceBy(5);
    await expect(job).resolves.toBe(true);
  });

  it('ignores cancelled timer callbacks and closes synchronously when the current timer expires', async () => {
    const callbacks: Array<() => void> = [];
    let channel!: ExecutorChannel;
    let signal!: AbortSignal;
    const emit = vi.fn<(event: ExecutorEvent) => Promise<unknown>>().mockResolvedValue(undefined) as ExecutorChannel['emit'];
    const job = withinDeadline({ policy: { kind: 'idle', timeoutMs: 15, progressed: () => true }, schedule: (run) => {
      callbacks.push(run);
      return () => undefined;
    } }, emit, async (gated, abort) => { channel = gated; signal = abort; return forever(); });
    await channel.emit(step);
    callbacks[0]!();
    expect(signal.aborted).toBe(false);
    callbacks[1]!();
    expect(signal.aborted).toBe(true);
    await expect(channel.emit(step)).rejects.toThrow('已经结束');
    expect(emit).toHaveBeenCalledTimes(1);
    await expect(job).resolves.toBe(true);
  });

  it('drains an in-flight write after expiry without letting its success rearm the timer', async () => {
    const timers = manualTimers();
    let persist!: () => void;
    const persisted = new Promise<void>((resolve) => { persist = resolve; });
    let channel!: ExecutorChannel;
    let signal!: AbortSignal;
    const job = withinDeadline({ policy: { kind: 'idle', timeoutMs: 15, progressed: () => true }, schedule: timers.schedule },
      vi.fn<(event: ExecutorEvent) => Promise<unknown>>().mockReturnValue(persisted) as ExecutorChannel['emit'], async (gated, abort) => { channel = gated; signal = abort; return forever(); });
    const pending = channel.emit(step);
    let finished = false;
    void job.then(() => { finished = true; });
    timers.advanceBy(15);
    expect(signal.aborted).toBe(true);
    await Promise.resolve();
    expect(finished).toBe(false);
    persist();
    await pending;
    await expect(job).resolves.toBe(true);
    expect(timers.pending(15)).toBe(0);
    await expect(channel.emit(step)).rejects.toThrow('已经结束');
  });

  it('keeps the absolute deadline even while events are persisted', async () => {
    const timers = manualTimers();
    let channel!: ExecutorChannel;
    const job = withinDeadline({ policy: { kind: 'absolute', timeoutMs: 5 }, schedule: timers.schedule },
      vi.fn<(event: ExecutorEvent) => Promise<unknown>>().mockResolvedValue(undefined) as ExecutorChannel['emit'], async (gated) => { channel = gated; return forever(); });
    timers.advanceBy(4);
    await channel.emit(step);
    timers.advanceBy(1);
    await expect(job).resolves.toBe(true);
  });

  it.each(['success', 'error'] as const)('closes the gate and cancels timers after executor %s', async (outcome) => {
    const timers = manualTimers();
    let channel!: ExecutorChannel;
    const job = withinDeadline({ policy: { kind: 'idle', timeoutMs: 15, progressed: () => true }, schedule: timers.schedule },
      vi.fn<(event: ExecutorEvent) => Promise<unknown>>().mockResolvedValue(undefined) as ExecutorChannel['emit'], async (gated) => { channel = gated; if (outcome === 'error') throw new Error('executor failed'); });
    if (outcome === 'error') await expect(job).rejects.toThrow('executor failed');
    else await expect(job).resolves.toBe(false);
    await expect(channel.emit(step)).rejects.toThrow('已经结束');
    expect(timers.pending(15)).toBe(0);
  });
});
