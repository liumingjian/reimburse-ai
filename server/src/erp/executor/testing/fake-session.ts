// Origin: 50931a3:kernel/test/fake-session.mjs. A queue fake: `Runtime.evaluate` returns pre-arranged values in order,
// every other command is only logged. It pins which input events are sent and where, which needs no browser.
// The stateful fake ERP (fake-erp.ts) covers whole jobs; this one covers single primitives.

import type { CdpSession } from '../cdp';

export type SentCommand = { method: string; params: Record<string, any> };
export type QueueSession = CdpSession & { sent: SentCommand[] };

export function fakeSession(evaluations: unknown[]): QueueSession {
  const sent: SentCommand[] = [];
  const queue = [...evaluations];
  return {
    sent,
    send(method, params = {}) {
      sent.push({ method, params });
      if (method === 'Runtime.evaluate') {
        if (queue.length === 0) throw new Error('求值次数超出预期');
        return Promise.resolve({ result: { value: queue.shift() } });
      }
      return Promise.resolve({});
    },
    close() {},
  };
}

/** Input events sent. On a real read-only path this list must be empty. */
export const inputs = (s: { sent: SentCommand[] }) => s.sent.filter((c) => c.method.startsWith('Input.'));

/** The JS each evaluation actually sent into the page. */
export const expressions = (s: { sent: SentCommand[] }) => s.sent.filter((c) => c.method === 'Runtime.evaluate').map((c) => String(c.params.expression));
