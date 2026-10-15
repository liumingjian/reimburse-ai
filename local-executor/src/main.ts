// The local executor's command line (`pnpm --filter @baox/local-executor start <command>`; how it reaches an
// employee's PC is line 2, item 6).
//
//   start pair --origin http://<app> <配对码>   pair with the 应用账号 that issued the code
//   start unpair                                 撤销配对, on the app and here
//   start run                                    hold the channel and run each 去报销 headless
//
// Until the app hands out the employee's ERP 凭据 with each job (line 2, item 1 of erp-headless-v1.md), `run` signs
// in with BAOX_ERP_ACCOUNT / BAOX_ERP_PASSWORD from its own environment. They are read once and never printed.

import { EXTENSION_VERSION } from '@baox/contract';
import { channelWatch, createChannelClient, type ClientSocket } from '@baox/extension/connection';
import { serverBlobs } from '@baox/extension/blobs';
import { redeemPairingCode, revokePairing } from '@baox/extension/pairing';
import { launchHeadless } from './headless';
import { createLocalRunner } from './runner';
import { openStore } from './store';

const store = openStore();
const say = (line: string) => process.stdout.write(`[baox] ${line}\n`);
const fail = (line: string): never => {
  process.stderr.write(`[baox] ${line}\n`);
  process.exit(1);
};

async function pair(args: string[]) {
  const at = args.indexOf('--origin');
  const origin = at >= 0 ? args[at + 1] : undefined;
  const code = args.filter((arg, i) => arg !== '--origin' && args[i - 1] !== '--origin')[0];
  if (!origin || !code) fail('用法：pair --origin http://<应用地址> <配对码>');
  const outcome = await redeemPairingCode({ origin: origin!.replace(/\/+$/, ''), code: code!, browser: `baox 本地执行器（${process.platform}）`, version: EXTENSION_VERSION });
  if (!outcome.ok) fail(`配对没有成功：${outcome.message}`);
  if (outcome.ok) {
    store.writePairing({ origin: origin!.replace(/\/+$/, ''), token: outcome.token, accountId: outcome.accountId });
    say('已配对。运行 `run` 开始接收去报销。');
  }
}

async function unpair() {
  const pairing = store.readPairing();
  if (!pairing) return say('这台电脑没有配对。');
  const revoked = await revokePairing({ origin: pairing.origin, token: pairing.token });
  store.clearPairing();
  say(revoked ? '已撤销配对。' : '本机的配对已删除；应用暂时连不上，请在应用的设置页里确认配对已撤销。');
}

function run() {
  const pairing = store.readPairing() ?? fail('这台电脑还没有配对：先运行 pair。');
  store.prepare();
  const account = process.env['BAOX_ERP_ACCOUNT'];
  const password = process.env['BAOX_ERP_PASSWORD'];
  const connection = channelWatch();
  let client: ReturnType<typeof createChannelClient> | null = null;
  const runner = createLocalRunner({
    request: (method, payload) => (client ? client.request(method, payload) : Promise.reject(new Error('channel_closed'))),
    connection,
    blobs: serverBlobs({ origin: pairing.origin, token: async () => pairing.token, fetch: (url, init) => fetch(url, init) }),
    credentials: async () => (account && password ? { account, password } : null),
    launch: (erpOrigin) => launchHeadless({ profileDir: store.profileDir, erpOrigin }),
    stagingRoot: store.stagingRoot,
    log: say,
  });
  client = createChannelClient({
    origin: pairing.origin,
    token: pairing.token,
    // Node's own WebSocket has the browser's shape, which is what the channel client was written against.
    open: (url) => new WebSocket(url) as unknown as ClientSocket,
    onRequest: runner,
    onStatus: (status) => {
      connection.status(status);
      say(status.state === 'ready' ? `已连上应用（账号 ${status.accountId}）` : status.state === 'refused' ? `应用拒绝了连接：${status.message}` : status.state);
      if (status.state === 'refused') process.exit(2);
    },
  });
  const stop = () => {
    client?.stop();
    process.exit(0);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

const [command, ...rest] = process.argv.slice(2);
if (command === 'pair') await pair(rest);
else if (command === 'unpair') await unpair();
else if (command === 'run') run();
else fail('用法：pair --origin http://<应用地址> <配对码> | unpair | run');
