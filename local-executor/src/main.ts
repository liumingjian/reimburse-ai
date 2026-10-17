// The local executor's command line. Packaged (ADR-0035: the zip from the settings page, run by its launcher) it starts
// with `setup`; from the repo it runs as `pnpm --filter @baox/local-executor start <command>`.
//
//   setup                                        the launcher's: ask for the 配对码, install into the executor's own
//                                                directory, start with the login, start now (packaged only)
//   run                                          hold the channel and run each 去报销 headless; keep to the
//                                                program the app ships
//   pair --origin http://<app> <配对码>          pair with the 应用账号 that issued the code
//   unpair                                       撤销配对, on the app and here
//   uninstall                                    stop starting with the login, and 撤销配对
//   self-check                                   load and answer: what an update asks of a new program first
//
// The ERP 凭据 are the app's to keep (ADR-0033): the employee saves them on the settings page, and each job brings
// them down with it. This program never asks for them and never writes them anywhere.

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync, truncateSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { EXTENSION_PAIR_PATH, EXTENSION_VERSION, LOCAL_EXECUTOR_CONFIG_FILE, LocalExecutorConfigSchema } from '@baox/contract';
import { channelWatch, createChannelClient, type ClientSocket } from '@baox/extension/connection';
import { serverBlobs } from '@baox/extension/blobs';
import { redeemPairingCode, revokePairing } from '@baox/extension/pairing';
import { launchHeadless } from './headless';
import { claimInstance } from './instance';
import { autostartFiles, installApp, LAUNCH_AGENT, removeInstallFiles, RESTART_EXIT_CODE, writeInstallFiles, type InstallFile } from './install';
import { createLocalRunner } from './runner';
import { openStore } from './store';
import { checkForUpdate, SELF_CHECK_ANSWER, sha256 } from './update';

const store = openStore();
const say = (line: string) => process.stdout.write(`[baox] ${line}\n`);
const fail = (line: string): never => {
  process.stderr.write(`[baox] ${line}\n`);
  process.exit(1);
};

// Packaged, the program sits next to the config the server wrote into the zip; from the repo it does not.
const programPath = fileURLToPath(import.meta.url);
const programDir = dirname(programPath);
const configFile = join(programDir, LOCAL_EXECUTOR_CONFIG_FILE);
const config = existsSync(configFile) ? LocalExecutorConfigSchema.parse(JSON.parse(readFileSync(configFile, 'utf8')) as unknown) : null;
const UPDATE_EVERY_MS = 30 * 60_000;
// After a refusal that a new program did not fix: wait before the launcher starts it again, so a server that keeps
// refusing is asked every few minutes, not every ten seconds.
const REFUSED_BACKOFF_MS = 5 * 60_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const LOG_LIMIT_BYTES = 5 * 1024 * 1024;

async function redeem(origin: string, code: string) {
  return redeemPairingCode({ origin: origin.replace(/\/+$/, ''), code, browser: `baox 本地执行器（${process.platform}）`, version: EXTENSION_VERSION, holder: 'local_executor' });
}

async function pair(args: string[]) {
  const at = args.indexOf('--origin');
  const origin = at >= 0 ? args[at + 1] : undefined;
  const code = args.filter((arg, i) => arg !== '--origin' && args[i - 1] !== '--origin')[0];
  if (!origin || !code) fail('用法：pair --origin http://<应用地址> <配对码>');
  const outcome = await redeem(origin!, code!);
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

const installFiles = (): InstallFile[] => autostartFiles({
  platform: process.platform, appDir: store.appDir, logsDir: store.logsDir, userHome: homedir(),
  ...(process.env['APPDATA'] ? { appData: process.env['APPDATA'] } : {}),
});

/** Start the installed copy now, as the login would: no window, and the launcher's restart rule. */
function startInBackground(files: readonly InstallFile[]): boolean {
  if (process.platform === 'darwin') {
    const target = `gui/${process.getuid?.() ?? 0}`;
    try { execFileSync('launchctl', ['bootout', `${target}/${LAUNCH_AGENT}`], { stdio: 'ignore' }); } catch { /* was not loaded */ }
    // bootout returns before launchd has let go of the label; bootstrap right after it can fail for a moment.
    for (let tries = 0; ; tries += 1) {
      try {
        execFileSync('launchctl', ['bootstrap', target, files[0]!.path], { stdio: 'ignore' });
        return true;
      } catch {
        if (tries >= 5) return false;
        execFileSync('sleep', ['1']);
      }
    }
  } else if (process.platform === 'win32') {
    const runner = files[0]!.path.replace(/'/g, "''");
    spawn('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', `Start-Process -WindowStyle Hidden -FilePath '${runner}'`], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  }
  return true;
}

/** Is this stored pairing still one the app knows? Unknown (the app not answering) counts as yes. */
async function stillPaired(pairing: { origin: string; token: string }): Promise<boolean> {
  try {
    const answer = await fetch(`${pairing.origin}${EXTENSION_PAIR_PATH}`, { headers: { authorization: `Bearer ${pairing.token}` } });
    return answer.status !== 401;
  } catch {
    return true;
  }
}

async function setup() {
  if (!config) return fail('setup 只能从设置页下载的安装包里运行。');
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    let pairing = store.readPairing();
    if (pairing && (pairing.origin !== config.origin || !(await stillPaired(pairing)))) {
      store.clearPairing();
      pairing = null;
    }
    for (let tries = 0; !pairing && tries < 3; tries += 1) {
      const code = (await prompt.question('请输入应用设置页上显示的配对码：')).trim();
      if (!code) continue;
      const outcome = await redeem(config.origin, code);
      if (!outcome.ok) {
        say(`配对没有成功：${outcome.message}`);
        continue;
      }
      pairing = { origin: config.origin, token: outcome.token, accountId: outcome.accountId };
      store.writePairing(pairing);
    }
    if (!pairing) return fail('没有配对成功。请在应用的设置页重新生成配对码，再双击启动文件。');
    store.prepare();
    if (resolve(programDir) !== resolve(store.appDir)) installApp({ sourceDir: programDir, appDir: store.appDir, platform: process.platform });
    // The copy came out of a downloaded zip; Node's own signature is what macOS checks, the download flag is not needed.
    if (process.platform === 'darwin') { try { execFileSync('xattr', ['-dr', 'com.apple.quarantine', store.appDir], { stdio: 'ignore' }); } catch { /* not set */ } }
    const files = installFiles();
    writeInstallFiles(files);
    if (startInBackground(files)) say('已安装：本地执行器正在后台运行，以后每次登录电脑都会自动运行。现在可以关掉这个窗口，回到应用去报销。');
    else say('已安装，但这次没能马上在后台启动。请退出登录再登录一次电脑，它会自动运行。');
    if (process.stdin.isTTY) await prompt.question('按回车键关闭这个窗口。');
  } finally {
    prompt.close();
  }
}

async function uninstall() {
  if (process.platform === 'darwin') {
    try { execFileSync('launchctl', ['bootout', `gui/${process.getuid?.() ?? 0}/${LAUNCH_AGENT}`], { stdio: 'ignore' }); } catch { /* was not loaded */ }
  }
  removeInstallFiles(installFiles());
  await unpair();
  say('不会再随登录启动。');
}

async function run() {
  const pairing = store.readPairing();
  if (!pairing) {
    // Started by the login after the pairing was undone: nothing to do, and nothing to restart for.
    if (config) { say('这台电脑还没有配对：请双击安装包里的启动文件。'); process.exit(0); }
    return fail('这台电脑还没有配对：先运行 pair。');
  }
  store.prepare();
  const instance = await claimInstance();
  if (!instance) {
    say('本地执行器已经在运行。');
    process.exit(0);
  }
  const log = join(store.logsDir, 'executor.log');
  try { if (existsSync(log) && statSync(log).size > LOG_LIMIT_BYTES) truncateSync(log, 0); } catch { /* held by the launcher: next time */ }

  let client: ReturnType<typeof createChannelClient> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  const leave = (code: number): never => {
    if (timer) clearInterval(timer);
    client?.stop();
    instance.release();
    process.exit(code);
  };
  // Packaged only: from the repo there is no release to follow.
  const running = sha256(readFileSync(programPath));
  const update = async (why: string) => {
    if (!config) return;
    const check = await checkForUpdate({ origin: pairing.origin, token: pairing.token, programPath, running });
    if (check.kind === 'restart') {
      // Never under a job: a restart there would cut it off mid-write. The new program waits on disk until it is done.
      while (runner?.busy()) await sleep(5_000);
      say(`换成应用发布的新版本（${why}）`);
      leave(RESTART_EXIT_CODE);
    }
    if (check.kind === 'runtime') say(`应用发布的版本要用新的运行环境（Node ${check.wants}），请到应用的设置页重新下载本地执行器安装包。`);
    if (check.kind === 'failed') say(`检查新版本没有成功：${check.reason}`);
  };
  let runner: ReturnType<typeof createLocalRunner> | null = null;
  await update('启动时');

  const connection = channelWatch();
  runner = createLocalRunner({
    request: (method, payload) => (client ? client.request(method, payload) : Promise.reject(new Error('channel_closed'))),
    connection,
    blobs: serverBlobs({ origin: pairing.origin, token: async () => pairing.token, fetch: (url, init) => fetch(url, init) }),
    launch: (erpOrigin) => launchHeadless({ profileDir: store.profileDir, erpOrigin }),
    stagingRoot: store.stagingRoot,
    log: say,
  });
  // Never under a job: a restart there would cut it off mid-write.
  timer = setInterval(() => { if (!runner?.busy()) void update('定期检查'); }, UPDATE_EVERY_MS);
  client = createChannelClient({
    origin: pairing.origin,
    token: pairing.token,
    // Node's own WebSocket has the browser's shape, which is what the channel client was written against.
    open: (url) => new WebSocket(url) as unknown as ClientSocket,
    onRequest: runner,
    onStatus: (status) => {
      connection.status(status);
      say(status.state === 'ready' ? `已连上应用（账号 ${status.accountId}）` : status.state === 'refused' ? `应用拒绝了连接：${status.message}` : status.state);
      // A pairing that is gone stops it until the employee pairs again (exit 0: the launcher leaves it stopped).
      // Anything else, a version the app no longer talks to above all, is what a new program fixes; failing that,
      // it waits and lets the launcher start it again.
      if (status.state === 'refused') {
        void (async () => {
          await update('应用拒绝了连接');
          if (status.code === 'not_paired') leave(0);
          await sleep(REFUSED_BACKOFF_MS);
          leave(1);
        })();
      }
    },
  });
  process.once('SIGINT', () => leave(0));
  process.once('SIGTERM', () => leave(0));
}

const [command, ...rest] = process.argv.slice(2);
if (command === 'self-check') process.stdout.write(`${SELF_CHECK_ANSWER}\n`);
else if (command === 'setup' || (command === undefined && config)) await setup();
else if (command === 'pair') await pair(rest);
else if (command === 'unpair') await unpair();
else if (command === 'uninstall') await uninstall();
else if (command === 'run') await run();
else fail('用法：setup | run | pair --origin http://<应用地址> <配对码> | unpair | uninstall');
