import { spawn as nodeSpawn } from 'node:child_process';

export const AUTO_OPEN_OFF = 'BAOX_NO_AUTO_OPEN';
export const BROWSER_MODE_ENV = 'BAOX_BROWSER';
export const SYSTEM_BROWSER = 'system';
export const EGO_BROWSER = 'ego';
export const BROWSER_DISPATCHED = 'dispatched';

// The launcher must report exit 0 before the local page can be considered
// dispatched. Keep a hung launcher from holding the page for its full timeout.
const DEFAULT_OPEN_TIMEOUT_MS = 5000;

export class BrowserOpenError extends Error {
  constructor(message, { cause, command, args, url, code = 'BROWSER_OPEN_FAILED' } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'BrowserOpenError';
    this.code = code;
    this.command = command;
    this.args = args;
    this.url = url;
  }
}

export function browserUrl(value) {
  const raw = String(value ?? '');
  if (raw.startsWith('-')) {
    const error = new TypeError('浏览器 URL 不能以命令行选项开头');
    error.code = 'BROWSER_URL_INVALID';
    throw error;
  }
  let parsed;
  try { parsed = new URL(raw); }
  catch {
    const error = new TypeError('浏览器 URL 必须是合法的 http(s) 地址');
    error.code = 'BROWSER_URL_INVALID';
    throw error;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    const error = new TypeError('浏览器 URL 必须是 http(s) 地址');
    error.code = 'BROWSER_URL_INVALID';
    throw error;
  }
  return raw;
}

export function browserMode(env = process.env) {
  return String(env?.[BROWSER_MODE_ENV] ?? '').trim().toLowerCase() === EGO_BROWSER
    ? EGO_BROWSER : SYSTEM_BROWSER;
}

export function systemBrowserCommand(url, platform = process.platform) {
  const safeUrl = browserUrl(url);
  if (platform === 'darwin') return ['open', [safeUrl]];
  if (platform === 'win32') return ['cmd', ['/c', 'start', '', safeUrl]];
  return ['xdg-open', [safeUrl]];
}

/**
 * Open a URL using the operating system's default browser.
 *
 * A successful dispatch is based on the launcher exit status, not on a timer.
 * This keeps a hung or unavailable launcher distinguishable from a page that
 * was actually handed to the system browser.
 */
export function openDefaultBrowser(url, {
  platform = process.platform,
  spawnCommand = nodeSpawn,
  timeoutMs = DEFAULT_OPEN_TIMEOUT_MS,
  env = process.env,
} = {}) {
  if (env?.[AUTO_OPEN_OFF] === '1') return Promise.resolve(false);

  let command;
  let args;
  try { [command, args] = systemBrowserCommand(url, platform); }
  catch (error) {
    return Promise.reject(new BrowserOpenError(error.message, {
      cause: error, url, code: error.code ?? 'BROWSER_OPEN_FAILED',
    }));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;

    const settle = (opened, error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(opened);
    };
    const dispatched = () => settle({ status: BROWSER_DISPATCHED, command, args, url });
    timer = setTimeout(() => settle(false, new BrowserOpenError(
      `系统默认浏览器启动超时: ${command}`,
      { command, args, url, code: 'BROWSER_OPEN_TIMEOUT' },
    )), timeoutMs);

    let child;
    try {
      child = spawnCommand(command, args, { stdio: 'ignore', detached: true });
    } catch (error) {
      settle(false, new BrowserOpenError(`系统默认浏览器启动命令不可用: ${command}`, {
        cause: error, command, args, url,
      }));
      return;
    }

    child.once?.('error', (error) => settle(false,
      new BrowserOpenError(`系统默认浏览器启动失败: ${command}`, {
        cause: error, command, args, url,
      })));
    child.once?.('close', (code, signal) => {
      if (code === 0) dispatched();
      else settle(false, new BrowserOpenError(
        `系统默认浏览器启动失败: ${command} (code=${code}, signal=${signal ?? 'none'})`,
        { command, args, url },
      ));
    });
    child.once?.('spawn', () => child.unref?.());
    if (!child?.once) dispatched();
  });
}
