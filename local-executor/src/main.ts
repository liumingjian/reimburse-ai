// The local executor's command line. Installed (ADR-0035: by the one command from the 设置页) its start entry runs
// `run`; from the repo it runs as `pnpm --filter @baox/local-executor start <command>`.
//
//   run [--origin http://<app>]                  hold the channel and run each 去报销 headless; keep to the
//                                                program the app ships. Installed, it first rechecks the Node
//                                                its config records and keeps its start entry to it (start.ts).
//                                                Unpaired, or once its pairing is gone,
//                                                it stays up and waits on 47319 for a 配对码 from the 设置页
//   pair --origin http://<app> <配对码>          pair with the 应用账号 that issued the code
//   unpair                                       撤销配对, on the app and here
//   finish-install --origin <app> --platform <p> the install script's last step: record the Node, write the start
//     --node <path> --account <id> --code <码>   entry, pair (unless already paired to that account), start
//   self-check                                   load and answer: what an update asks of a new program first
//
// Uninstalling is the /uninstall/<系统> command from the 设置页, which never revokes the pairing (spec #412 story 35);
// this program has no uninstall of its own.
//
// The ERP 凭据 are the app's to keep (ADR-0033): the employee saves them on the settings page, and each job brings
// them down with it. This program never asks for them and never writes them anywhere.

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync, truncateSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PAIRING_PATH, CLIENT_VERSION, LOCAL_EXECUTOR_CONFIG_FILE, LOCAL_EXECUTOR_INSTALL_EXIT, LocalExecutorConfigSchema, type LocalExecutorPlatform } from '@baox/contract';
import { channelWatch, createChannelClient, type ClientSocket } from '@baox/channel/connection';
import { serverBlobs } from '@baox/channel/blobs';
import { redeemPairingCode, revokePairing } from '@baox/channel/pairing';
import { launchHeadless } from './headless';
import { claimInstance, INSTANCE_PORT, type Instance } from './instance';
import { autostartFiles, downloadedRuntimePath, LAUNCH_AGENT, RESTART_EXIT_CODE, type InstallFile } from './install';
import { createPairingHolder, pairingListener } from './pairing-port';
import { createLocalRunner } from './runner';
import { ensureDownloaded, NODE_MAJOR, nodeProbe } from './runtime';
import { prepareStart, readConfig, recordNode, writeConfig } from './start';
import { openStore, type StoredPairing } from './store';
import { checkForUpdate, SELF_CHECK_ANSWER, sha256 } from './update';

const store = openStore();
const say = (line: string) => process.stdout.write(`[baox] ${line}\n`);
const fail = (line: string): never => {
  process.stderr.write(`[baox] ${line}\n`);
  process.exit(1);
};

// Installed, the program sits next to the config its install wrote; from the repo it does not.
const programPath = fileURLToPath(import.meta.url);
const programDir = dirname(programPath);
const configFile = join(programDir, LOCAL_EXECUTOR_CONFIG_FILE);
const config = existsSync(configFile) ? readConfig(configFile) : null;
// Installed: the program runs from the executor's own directory, whose start entry it keeps (`start.ts`).
// Compared as real paths: a HOME reached through a symlink (/tmp, /var on macOS) still names the same directory.
const real = (path: string) => { try { return realpathSync(path); } catch { return resolve(path); } };
const inAppDir = () => real(programDir) === real(store.appDir);
const installed = config !== null && inAppDir();
const UPDATE_EVERY_MS = 30 * 60_000;
// After a refusal that a new program did not fix: wait before the launcher starts it again, so a server that keeps
// refusing is asked every few minutes, not every ten seconds.
const REFUSED_BACKOFF_MS = 5 * 60_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const LOG_LIMIT_BYTES = 5 * 1024 * 1024;

async function redeem(origin: string, code: string) {
  return redeemPairingCode({ origin: origin.replace(/\/+$/, ''), code, browser: `baox 本地执行器（${process.platform}）`, version: CLIENT_VERSION, holder: 'local_executor' });
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

const hostPlatform = (): LocalExecutorPlatform => (process.platform === 'win32' ? 'win-x64' : process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64');
const appData = process.env['APPDATA'] ? { appData: process.env['APPDATA'] } : {};
const where = { platform: process.platform, appDir: store.appDir, logsDir: store.logsDir, userHome: homedir(), ...appData };
const installedConfig = () => join(store.appDir, LOCAL_EXECUTOR_CONFIG_FILE);
const downloadedRuntime = downloadedRuntimePath(store.appDir, process.platform);

/** The start-at-login files as the installed config has them; what starting in the background writes. */
const installFiles = (): InstallFile[] => {
  const installedCfg = existsSync(installedConfig()) ? readConfig(installedConfig()) : config;
  return autostartFiles({ ...where, node: installedCfg?.node ?? downloadedRuntime, origin: installedCfg?.origin ?? '', runtimePlatform: installedCfg?.platform ?? hostPlatform() });
};

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
    const answer = await fetch(`${pairing.origin}${PAIRING_PATH}`, { headers: { authorization: `Bearer ${pairing.token}` } });
    return answer.status !== 401;
  } catch {
    return true;
  }
}

// The one-command install's last step (spec #412 part C), run by the script from the executor's own directory once
// it has put the program there and stopped the running copy (`server/src/local-executor/install-script.ts`). It
// records the Node the script chose and writes the start entry for it as every start does, pairs with the code unless
// this PC already holds that account's pairing (a run that paired and then failed, run again with the same code), and
// starts it. It prints nothing for the terminal: the script prints the sentence its exit code stands for, and this
// output goes to the install log.
async function finishInstall(args: string[]) {
  const option = (name: string) => {
    const at = args.indexOf(`--${name}`);
    return at >= 0 ? args[at + 1] : undefined;
  };
  try {
    const parsed = LocalExecutorConfigSchema.safeParse({ origin: option('origin')?.replace(/\/+$/, ''), platform: option('platform'), node: option('node') });
    const code = option('code');
    const account = option('account');
    if (!parsed.success || !parsed.data.node || !code || !account) throw new Error('finish-install: missing --origin, --platform, --node, --account or --code');
    if (!inAppDir()) throw new Error(`finish-install runs from ${store.appDir}, not ${programDir}`);
    const { origin, node } = parsed.data;
    store.prepare();
    writeConfig(installedConfig(), parsed.data);
    recordNode({ configFile: installedConfig(), node, ...where });
    const held = store.readPairing();
    if (held && held.origin === origin && held.accountId === account && (await stillPaired(held))) {
      console.error('finish-install: this PC already holds the pairing; not pairing again');
    } else {
      const outcome = await redeem(origin, code);
      if (!outcome.ok) {
        console.error(`finish-install: pairing refused: ${outcome.code} ${outcome.message}`);
        process.exit(outcome.code === 'network_error' ? LOCAL_EXECUTOR_INSTALL_EXIT.unreachable : outcome.code === 'pairing_code_invalid' ? LOCAL_EXECUTOR_INSTALL_EXIT.expired : 1);
      }
      store.writePairing({ origin, token: outcome.token, accountId: outcome.accountId });
    }
    if (!startInBackground(installFiles())) process.exit(LOCAL_EXECUTOR_INSTALL_EXIT.start);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}

async function run(args: string[]) {
  // The app this executor belongs to: the one its install was for, else the one it was paired with from the repo.
  const at = args.indexOf('--origin');
  const stored = store.readPairing();
  const appOrigin = (config?.origin ?? (at >= 0 ? args[at + 1] : undefined) ?? stored?.origin)?.replace(/\/+$/, '');
  if (!appOrigin) return fail('这台电脑还没有配对：先运行 pair，或用 run --origin http://<应用地址> 等设置页来连接。');
  store.prepare();
  // Recheck the Node it runs on and keep the start entry to it (ADR-0035): before anything else, so that a Node that
  // no longer qualifies never gets as far as a job.
  if (installed) {
    try {
      const started = await prepareStart({ ...where, configFile, execPath: process.execPath, major: NODE_MAJOR });
      if (started.why) say(`记录的 Node ${started.why}，改用应用服务器提供的运行环境`);
      if (started.rewrote) say('已更新随登录启动的设置');
      if (started.restart) process.exit(RESTART_EXIT_CODE);
    } catch (error) {
      say(`检查运行环境没有成功：${error instanceof Error ? error.message : String(error)}`);
      await sleep(REFUSED_BACKOFF_MS);
      process.exit(1);
    }
  }
  const log = join(store.logsDir, 'executor.log');
  try { if (existsSync(log) && statSync(log).size > LOG_LIMIT_BYTES) truncateSync(log, 0); } catch { /* held by the launcher: next time */ }

  let runner: ReturnType<typeof createLocalRunner> | null = null;
  let instance: Instance | null = null;
  let stopLoop: (() => void) | null = null;
  const leave = (code: number): never => {
    stopLoop?.();
    instance?.release();
    process.exit(code);
  };
  // Packaged only: from the repo there is no release to follow.
  const running = sha256(readFileSync(programPath));
  const update = async (pairing: StoredPairing, why: string) => {
    if (!config || !installed) return;
    const check = await checkForUpdate({
      origin: pairing.origin, token: pairing.token, programPath, running,
      // The server moved to another Node major version: the runtime it serves, in place of whatever Node this was.
      downloadedRuntime: (major) => ensureDownloaded({ downloaded: downloadedRuntime, major, probe: nodeProbe(), runtime: { origin: config.origin, platform: config.platform } }),
    });
    if (check.kind === 'restart') {
      // Never under a job: a restart there would cut it off mid-write. The new program waits on disk until it is done.
      while (runner?.busy()) await sleep(5_000);
      if (check.node) {
        recordNode({ configFile, node: check.node, ...where });
        say(`应用服务器换了 Node 大版本，改用它提供的运行环境（${why}）`);
      } else say(`换成应用发布的新版本（${why}）`);
      leave(RESTART_EXIT_CODE);
    }
    if (check.kind === 'failed') say(`检查新版本没有成功：${check.reason}`);
  };

  // One job loop per pairing: the channel to the app, the runner behind it, and the periodic update check.
  const connect = (pairing: StoredPairing, lost: () => void) => {
    let stopped = false;
    let client: ReturnType<typeof createChannelClient> | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    const stop = () => {
      stopped = true;
      if (timer) clearInterval(timer);
      client?.stop();
    };
    void (async () => {
      await update(pairing, '启动时');
      if (stopped) return;
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
      timer = setInterval(() => { if (!runner?.busy()) void update(pairing, '定期检查'); }, UPDATE_EVERY_MS);
      client = createChannelClient({
        origin: pairing.origin,
        token: pairing.token,
        // Node's own WebSocket has the browser's shape, which is what the channel client was written against.
        open: (url) => new WebSocket(url) as unknown as ClientSocket,
        onRequest: runner,
        onStatus: (status) => {
          if (stopped) return;
          connection.status(status);
          say(status.state === 'ready' ? `已连上应用（账号 ${status.accountId}）` : status.state === 'refused' ? `应用拒绝了连接：${status.message}` : status.state);
          // A pairing that is gone leaves it running unpaired, waiting on 47319 for a new 配对码 (ADR-0035,
          // 2026-10-17). Anything else, a version the app no longer talks to above all, is what a new program fixes;
          // failing that, it waits and lets the launcher start it again.
          if (status.state === 'refused') {
            void (async () => {
              if (status.code === 'not_paired') {
                lost();
                say('配对已经作废：在应用的设置页点「连接这台电脑的执行器」重新连接。');
                return;
              }
              await update(pairing, '应用拒绝了连接');
              await sleep(REFUSED_BACKOFF_MS);
              if (!stopped) leave(1);
            })();
          }
        },
      });
    })();
    stopLoop = stop;
    return stop;
  };

  const holder = createPairingHolder({ origin: appOrigin, store, redeem: (code) => redeem(appOrigin, code), connect, busy: () => runner?.busy() ?? false });
  // The 设置页 only looks on 47319; another port is for a second executor beside an installed one (tests, demos).
  const port = Number(process.env['BAOX_LOCAL_EXECUTOR_PORT'] ?? INSTANCE_PORT);
  instance = await claimInstance(port, pairingListener({ appOrigin, holder }));
  if (!instance) {
    say('本地执行器已经在运行。');
    process.exit(0);
  }
  holder.start();
  if (!holder.current()) say('这台电脑还没有配对：在应用的设置页点「连接这台电脑的执行器」。');
  process.once('SIGINT', () => leave(0));
  process.once('SIGTERM', () => leave(0));
}

const [command, ...rest] = process.argv.slice(2);
if (command === 'self-check') process.stdout.write(`${SELF_CHECK_ANSWER}\n`);
else if (command === 'pair') await pair(rest);
else if (command === 'unpair') await unpair();
else if (command === 'finish-install') await finishInstall(rest);
else if (command === 'run') await run(rest);
else fail('用法：run [--origin http://<应用地址>] | pair --origin http://<应用地址> <配对码> | unpair');
