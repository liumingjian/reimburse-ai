// The v1 browser port: the app's dedicated Chromium profile over CDP on 127.0.0.1 (ADR-0016). `ensureChromium` starts
// it when nothing answers on the port, headed by default, with its own user data directory, never the user's own
// profile. `headless` is the local executor's (ADR-0033, `@baox/local-executor`) and the spike's.
// Origin: 50931a3:kernel/src/chrome.mjs (findChrome, launch).

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { targets } from './cdp';
import { attachChromiumPage, ExecutorError, listChromiumPages } from './chromium';
import type { BrowserPort } from './job';

const CANDIDATES: Readonly<Record<string, readonly string[]>> = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ],
  win32: ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'],
  linux: ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
};

type Env = Record<string, string | undefined>;

// Per user on Windows: Chrome installed without administrator rights lives under %LOCALAPPDATA%, and Edge, which every
// Windows 10 and 11 has, is the last resort (ADR-0035: the 本地执行器 uses the browser the PC already has).
const windowsPerUser = (env: Env): string[] => [
  ...(env['LOCALAPPDATA'] ? [`${env['LOCALAPPDATA']}\\Google\\Chrome\\Application\\chrome.exe`] : []),
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

export function findChrome(env: Env = process.env, platform: string = process.platform, exists: (path: string) => boolean = existsSync): string | null {
  if (env['BAOX_CHROME']) return env['BAOX_CHROME'];
  const candidates = [...(CANDIDATES[platform] ?? []), ...(platform === 'win32' ? windowsPerUser(env) : [])];
  return candidates.find((path) => exists(path)) ?? null;
}

async function reachable(port: number): Promise<boolean> {
  try {
    await targets(port);
    return true;
  } catch {
    return false;
  }
}

// A headless browser has no screen to size its window by and defaults to 800x600, where the ERP's toolbar and the
// invoice assistant are laid out for nobody. A common desktop size keeps the page the shape every measurement in
// this package was taken on.
const HEADLESS_WINDOW = '1920,1080';

/** The command line `ensureChromium` starts Chromium with. Headed unless `headless` is asked for. */
export function chromiumArgs({ port, profileDir, openUrl, headless = false, extraArgs = [] }: { port: number; profileDir: string; openUrl: string; headless?: boolean; extraArgs?: readonly string[] }): string[] {
  return [
    `--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check', '--disable-features=Translate',
    ...(headless ? ['--headless=new', `--window-size=${HEADLESS_WINDOW}`] : []),
    ...extraArgs,
    openUrl,
  ];
}

/**
 * Start the dedicated Chromium unless something already answers CDP on `port`. `pid` is the started browser's own
 * process, which leads its own process group (`detached`); null when an already-running one was found.
 */
export async function ensureChromium({ port, profileDir, openUrl, env = process.env, timeoutMs = 20_000, headless = false, extraArgs = [] }: { port: number; profileDir: string; openUrl: string; env?: Env; timeoutMs?: number; headless?: boolean; extraArgs?: readonly string[] }): Promise<{ started: boolean; pid: number | null }> {
  if (await reachable(port)) return { started: false, pid: null };
  const bin = findChrome(env);
  if (!bin) throw new ExecutorError('CHROME_NOT_FOUND', '没有找到 Chrome 或 Edge；请安装后重试，或用 BAOX_CHROME 指定可执行文件');
  mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  const child = spawn(bin, chromiumArgs({ port, profileDir, openUrl, headless, extraArgs }), { detached: true, stdio: 'ignore' });
  let failure: Error | null = null;
  child.once('error', (error) => { failure = error; });
  child.once('exit', (code, signal) => { failure ??= new Error(`Chrome 在自动化连接就绪前退出（code=${code}, signal=${signal}）`); });
  child.unref();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await reachable(port)) return { started: true, pid: child.pid ?? null };
    if (failure) throw new ExecutorError('CHROME_LAUNCH_FAILED', `专用浏览器启动失败：${(failure as Error).message}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new ExecutorError('CDP_TIMEOUT', `专用浏览器已启动，但自动化端口 ${port} 在 ${Math.ceil(timeoutMs / 1000)} 秒内没有响应`);
}

/** Pages and sessions of the Chromium on `port`. `launchError` explains why it may be missing. */
export function cdpBrowser(port: number, launchError: Error | null = null): BrowserPort {
  return {
    async listPages() {
      try {
        return await listChromiumPages({ port });
      } catch (error) {
        throw new ExecutorError('CHROMIUM_CDP_UNAVAILABLE', `报销专用浏览器没有就绪（自动化端口 ${port}）${launchError ? `：${launchError.message}` : ''}`, { cause: error });
      }
    },
    attach: (page) => attachChromiumPage(page, { port }),
  };
}
