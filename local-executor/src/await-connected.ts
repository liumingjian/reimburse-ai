// The install's health check (`await-connected`): the install says 已安装 only once the app sees the started 本地执行器's
// channel. A start that never ran, or a program that cannot reach the app, otherwise looks like a finished install
// until the first 试登录 says no 本地执行器 is connected.

import { checkPairing } from '@baox/channel/pairing';
import type { StoredPairing } from './store';

export type ConnectWait = 'connected' | 'not_connected' | 'not_paired';

const ASK_EVERY_MS = 1000;

export async function awaitConnected({ pairing, timeoutMs, fetchImpl = fetch, now = Date.now, sleep = (ms) => new Promise((done) => setTimeout(done, ms)) }: {
  pairing: Pick<StoredPairing, 'origin' | 'token'>;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<ConnectWait> {
  const deadline = now() + timeoutMs;
  for (;;) {
    const check = await checkPairing({ origin: pairing.origin, token: pairing.token, fetchImpl, timeoutMs: 5000 });
    if (check.state === 'not_paired') return 'not_paired';
    if (check.state === 'paired' && check.connected) return 'connected';
    if (now() >= deadline) return 'not_connected';
    await sleep(ASK_EVERY_MS);
  }
}
