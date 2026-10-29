// The install's health check: after the start, it waits until the app sees the 本地执行器's channel, and says so only then.
import { PAIRING_PATH } from '@baox/contract';
import { describe, expect, it } from 'vitest';
import { awaitConnected } from './await-connected';

const PAIRING = { origin: 'http://10.250.0.222:8888', token: 'tok', accountId: 'a-1' };

/** The app's answers to the pairing lookup, one per ask; the last repeats. */
function app(answers: Array<number | { connected?: boolean }>) {
  const asked: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    asked.push(`${String(input)} ${new Headers(init?.headers).get('authorization')}`);
    const answer = answers[Math.min(asked.length, answers.length) - 1]!;
    if (typeof answer === 'number') return new Response(null, { status: answer });
    return Response.json({ accountId: 'a-1', username: 'alice', ...answer });
  }) as typeof fetch;
  return { asked, fetchImpl };
}

const clock = () => {
  let now = 0;
  return { now: () => now, sleep: async (ms: number) => { now += ms; } };
};

describe('awaitConnected', () => {
  it('asks the app by the pairing token until it sees the channel', async () => {
    const { asked, fetchImpl } = app([{ connected: false }, { connected: false }, { connected: true }]);
    expect(await awaitConnected({ pairing: PAIRING, timeoutMs: 60_000, fetchImpl, ...clock() })).toBe('connected');
    expect(asked).toEqual(Array(3).fill(`${PAIRING.origin}${PAIRING_PATH} Bearer tok`));
  });

  it('keeps asking through an app that does not answer for a moment', async () => {
    const { fetchImpl } = app([503, { connected: true }]);
    expect(await awaitConnected({ pairing: PAIRING, timeoutMs: 60_000, fetchImpl, ...clock() })).toBe('connected');
  });

  it('gives up at the deadline when the channel never shows', async () => {
    const { asked, fetchImpl } = app([{ connected: false }]);
    expect(await awaitConnected({ pairing: PAIRING, timeoutMs: 10_000, fetchImpl, ...clock() })).toBe('not_connected');
    expect(asked.length).toBeGreaterThan(5);
  });

  it('stops at once when the app no longer knows the pairing', async () => {
    const { asked, fetchImpl } = app([401]);
    expect(await awaitConnected({ pairing: PAIRING, timeoutMs: 60_000, fetchImpl, ...clock() })).toBe('not_paired');
    expect(asked).toHaveLength(1);
  });

  it('does not take an app that says nothing about the channel for a connected one', async () => {
    const { fetchImpl } = app([{}]);
    expect(await awaitConnected({ pairing: PAIRING, timeoutMs: 5_000, fetchImpl, ...clock() })).toBe('not_connected');
  });
});
