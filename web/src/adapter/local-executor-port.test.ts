import { describe, expect, test } from 'vitest';
import { createLoopbackPort } from './local-executor-port';

// The page's half of 47319 (the executor's half is local-executor/src/pairing-port.test.ts): what it asks, and that
// anything but a well-formed answer reads as nobody there.

type Seen = { url: string; init: RequestInit };
const answering = (body: unknown, status = 200) => {
  const seen: Seen[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof globalThis.fetch;
  return { seen, fetch };
};

describe('the 本地执行器 port on 127.0.0.1:47319', () => {
  test('asks the executor whom it is paired to', async () => {
    const { seen, fetch } = answering({ paired: true, accountId: 'A1' });
    expect(await createLoopbackPort({ fetch }).probe()).toEqual({ paired: true, accountId: 'A1' });
    expect(seen[0]!.url).toBe('http://127.0.0.1:47319/pairing');
    expect(seen[0]!.init.method).toBe('GET');
  });

  test('hands it a 配对码 as JSON, and reads a refusal by its sentence whatever the status', async () => {
    const { seen, fetch } = answering({ ok: false, code: 'local_executor_busy', message: '正在去报销' }, 409);
    expect(await createLoopbackPort({ fetch }).pair('K7MQ2PXD')).toEqual({ ok: false, code: 'local_executor_busy', message: '正在去报销' });
    expect(seen[0]!.init.method).toBe('POST');
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual({ code: 'K7MQ2PXD' });
  });

  test('nothing listening, a refused origin (403, no body) or a stranger answering: null', async () => {
    const refused = (async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof globalThis.fetch;
    expect(await createLoopbackPort({ fetch: refused }).probe()).toBeNull();
    const forbidden = (async () => new Response(null, { status: 403 })) as unknown as typeof globalThis.fetch;
    expect(await createLoopbackPort({ fetch: forbidden }).probe()).toBeNull();
    expect(await createLoopbackPort({ fetch: answering({ hello: 'world' }).fetch }).pair('K7MQ2PXD')).toBeNull();
  });

  test('gives up on an executor that does not answer in time', async () => {
    const hanging = ((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    })) as unknown as typeof globalThis.fetch;
    expect(await createLoopbackPort({ fetch: hanging, probeTimeoutMs: 20 }).probe()).toBeNull();
  });
});
