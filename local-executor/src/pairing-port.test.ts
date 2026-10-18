// 47319 as the 设置页 sees it (ADR-0035): only the app's own page may read whom the executor is paired to and hand it a
// new 配对码, and a pairing that is gone leaves the executor up and listening, ready to start its job loop again.
// Each test claims its own free port (0): the maintainer's installed executor may hold the real 47319.
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { LOCAL_EXECUTOR_PAIRING_ERRORS, LOCAL_EXECUTOR_PAIRING_PATH } from '@baox/contract';
import type { PairingOutcome } from '@baox/extension/pairing';
import { claimInstance } from './instance';
import { createPairingHolder, pairingListener } from './pairing-port';
import type { StoredPairing } from './store';

const APP = 'http://10.250.0.222:8080';
const ELSEWHERE = 'http://evil.example';

function memoryStore(initial: StoredPairing | null = null) {
  let stored = initial;
  return {
    readPairing: () => stored,
    writePairing: (pairing: StoredPairing) => { stored = pairing; },
    clearPairing: () => { stored = null; },
  };
}

/** A holder over a memory store, a scripted redeem and a connect that records each job loop it starts and stops. */
function executor({ paired = null as StoredPairing | null, redeem = async (code: string): Promise<PairingOutcome> => (code === 'GOODCODE' ? { ok: true, token: 'token-2', accountId: 'account-2' } : { ok: false, code: 'code_invalid', message: '配对码不对或已过期。' }), busy = (): boolean => false } = {}) {
  const store = memoryStore(paired);
  const loops: { pairing: StoredPairing; stopped: boolean; lost: () => void }[] = [];
  const codes: string[] = [];
  const holder = createPairingHolder({
    origin: APP, store, busy,
    redeem: (code) => { codes.push(code); return redeem(code); },
    connect: (pairing, lost) => {
      const loop = { pairing, stopped: false, lost };
      loops.push(loop);
      return () => { loop.stopped = true; };
    },
  });
  holder.start();
  return { store, loops, codes, holder };
}

async function serving(holder: ReturnType<typeof executor>['holder']) {
  const instance = await claimInstance(0, pairingListener({ appOrigin: APP, holder }));
  const url = `http://127.0.0.1:${(instance!.address() as AddressInfo).port}${LOCAL_EXECUTOR_PAIRING_PATH}`;
  return { instance: instance!, url };
}

const post = (url: string, body: unknown, origin?: string) => fetch(url, {
  method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
});

describe('the pairing endpoint on 47319', () => {
  it('pairs with a 配对码 from the app\'s own page and starts the job loop on it', async () => {
    const local = executor();
    const { instance, url } = await serving(local.holder);
    try {
      expect(local.loops).toHaveLength(0);
      const answer = await post(url, { code: 'GOODCODE' }, APP);
      expect(answer.status).toBe(200);
      expect(answer.headers.get('access-control-allow-origin')).toBe(APP);
      expect(await answer.json()).toEqual({ ok: true, accountId: 'account-2' });
      expect(local.store.readPairing()).toEqual({ origin: APP, token: 'token-2', accountId: 'account-2' });
      expect(local.loops.map((loop) => loop.pairing.accountId)).toEqual(['account-2']);
    } finally {
      instance.release();
    }
  });

  it('passes on the app\'s own refusal of a bad code and starts nothing', async () => {
    const local = executor();
    const { instance, url } = await serving(local.holder);
    try {
      const answer = await post(url, { code: 'BADCODE' }, APP);
      expect(answer.status).toBe(422);
      expect(await answer.json()).toEqual({ ok: false, code: 'code_invalid', message: '配对码不对或已过期。' });
      expect(local.loops).toHaveLength(0);
      expect(local.store.readPairing()).toBeNull();
    } finally {
      instance.release();
    }
  });

  it.each([
    ['another site', ELSEWHERE],
    ['a look-alike host', 'http://10.250.0.222.evil.example:8080'],
    ['the app on another port', 'http://10.250.0.222:9090'],
    ['an opaque origin', 'null'],
    ['no Origin at all', undefined],
  ])('refuses a 配对码 from %s, without asking the app', async (_, origin) => {
    const local = executor();
    const { instance, url } = await serving(local.holder);
    try {
      const answer = await post(url, { code: 'GOODCODE' }, origin);
      expect(answer.status).toBe(403);
      expect(answer.headers.get('access-control-allow-origin')).toBeNull();
      expect(local.codes).toEqual([]);
      expect(local.loops).toHaveLength(0);
    } finally {
      instance.release();
    }
  });

  it('answers the browser\'s private-network preflight for the app\'s origin only', async () => {
    const local = executor();
    const { instance, url } = await serving(local.holder);
    const preflight = (origin: string) => fetch(url, {
      method: 'OPTIONS',
      headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type', 'access-control-request-private-network': 'true' },
    });
    try {
      const mine = await preflight(APP);
      expect(mine.status).toBe(204);
      expect(mine.headers.get('access-control-allow-origin')).toBe(APP);
      expect(mine.headers.get('access-control-allow-private-network')).toBe('true');
      expect(mine.headers.get('access-control-allow-methods')).toContain('POST');
      expect(mine.headers.get('access-control-allow-headers')).toContain('content-type');

      const theirs = await preflight(ELSEWHERE);
      expect(theirs.status).toBe(403);
      expect(theirs.headers.get('access-control-allow-origin')).toBeNull();
      expect(theirs.headers.get('access-control-allow-private-network')).toBeNull();
    } finally {
      instance.release();
    }
  });

  it('tells the app\'s page which 应用账号 it is paired to, and that it is unpaired when it is', async () => {
    const paired = executor({ paired: { origin: APP, token: 'token-1', accountId: 'account-1' } });
    const unpaired = executor();
    const one = await serving(paired.holder);
    const two = await serving(unpaired.holder);
    try {
      const answer = await fetch(one.url, { headers: { origin: APP } });
      expect(answer.status).toBe(200);
      expect(answer.headers.get('access-control-allow-origin')).toBe(APP);
      expect(await answer.json()).toEqual({ paired: true, accountId: 'account-1' });
      expect(await (await fetch(two.url, { headers: { origin: APP } })).json()).toEqual({ paired: false });
    } finally {
      one.instance.release();
      two.instance.release();
    }
  });

  it('tells no other site, nor a request without an Origin, whom it is paired to', async () => {
    const local = executor({ paired: { origin: APP, token: 'token-1', accountId: 'account-1' } });
    const { instance, url } = await serving(local.holder);
    try {
      for (const headers of [{ origin: ELSEWHERE }, {}]) {
        const answer = await fetch(url, { headers });
        expect(answer.status).toBe(403);
        expect(await answer.text()).not.toContain('account-1');
      }
    } finally {
      instance.release();
    }
  });

  it('does not take the pairing over while a 去报销 runs', async () => {
    const local = executor({ paired: { origin: APP, token: 'token-1', accountId: 'account-1' }, busy: () => true });
    const { instance, url } = await serving(local.holder);
    try {
      const answer = await post(url, { code: 'GOODCODE' }, APP);
      expect(answer.status).toBe(409);
      expect(local.codes).toEqual([]);
      expect(local.loops.map((loop) => loop.stopped)).toEqual([false]);
    } finally {
      instance.release();
    }
  });

  it('answers an unexpected failure with its fixed sentence, and keeps the error for its own log', async () => {
    const local = executor({ redeem: async () => { throw new Error('EACCES: permission denied, open pairing.json'); } });
    const logged: unknown[] = [];
    const instance = await claimInstance(0, pairingListener({ appOrigin: APP, holder: local.holder, log: (error) => logged.push(error) }));
    try {
      const answer = await post(`http://127.0.0.1:${(instance!.address() as AddressInfo).port}${LOCAL_EXECUTOR_PAIRING_PATH}`, { code: 'GOODCODE' }, APP);
      expect(answer.status).toBe(500);
      expect(await answer.json()).toEqual({ ok: false, code: 'local_executor_error', message: LOCAL_EXECUTOR_PAIRING_ERRORS.failed });
      expect(String(logged[0])).toContain('EACCES');
    } finally {
      instance!.release();
    }
  });

  it('refuses a body with no 配对码', async () => {
    const local = executor();
    const { instance, url } = await serving(local.holder);
    try {
      expect((await post(url, { nothing: true }, APP)).status).toBe(400);
      expect(local.codes).toEqual([]);
    } finally {
      instance.release();
    }
  });
});

describe('an executor whose pairing is gone', () => {
  it('stops its job loop, forgets the pairing and stays unpaired until a new 配对码 arrives', async () => {
    const local = executor({ paired: { origin: APP, token: 'token-1', accountId: 'account-1' } });
    const { instance, url } = await serving(local.holder);
    try {
      local.loops[0]!.lost();
      expect(local.loops[0]!.stopped).toBe(true);
      expect(local.store.readPairing()).toBeNull();
      expect(await (await fetch(url, { headers: { origin: APP } })).json()).toEqual({ paired: false });

      expect((await post(url, { code: 'GOODCODE' }, APP)).status).toBe(200);
      expect(local.loops.map((loop) => [loop.pairing.accountId, loop.stopped])).toEqual([['account-1', true], ['account-2', false]]);
    } finally {
      instance.release();
    }
  });

  it('switches to another 应用账号 handed over by the page, and ignores a late word that the old pairing is gone', async () => {
    const local = executor({ paired: { origin: APP, token: 'token-1', accountId: 'account-1' } });
    expect(await local.holder.pair('GOODCODE')).toEqual({ ok: true, accountId: 'account-2' });
    expect(local.loops.map((loop) => loop.stopped)).toEqual([true, false]);
    local.loops[0]!.lost();
    expect(local.store.readPairing()).toMatchObject({ accountId: 'account-2' });
    expect(local.loops[1]!.stopped).toBe(false);
  });
});

describe('one executor per PC', () => {
  it('still turns a second instance away while the first serves the pairing endpoint', async () => {
    const local = executor();
    const { instance } = await serving(local.holder);
    try {
      const port = (instance.address() as AddressInfo).port;
      expect(await claimInstance(port, pairingListener({ appOrigin: APP, holder: local.holder }))).toBeNull();
    } finally {
      instance.release();
    }
  });
});
