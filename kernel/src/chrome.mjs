import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { paths, ensureDir } from './paths.mjs';

export const CDP_PORT = Number(process.env.BAOX_CDP_PORT || 9333);

const CANDIDATES = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ],
  linux: ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
};

export function findChrome() {
  if (process.env.BAOX_CHROME) return process.env.BAOX_CHROME;
  for (const p of CANDIDATES[process.platform] || []) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// 调试端口只在回环地址上开，且只服务 baox 专用 profile。
// 这个端口等同于对该 profile 的完全控制权，所以绝不能指向用户自己的 profile。
export async function version(port = CDP_PORT) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

export async function targets(port = CDP_PORT) {
  const r = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(3000),
  });
  if (!r.ok) throw new Error(`CDP /json/list HTTP ${r.status}`);
  const list = await r.json();
  return list.filter((t) => t.type === 'page');
}

export async function launch({ port = CDP_PORT, openUrl } = {}) {
  const existing = await version(port);
  if (existing) return { started: false, ...existing };

  const bin = findChrome();
  if (!bin) {
    const e = new Error('未找到 Chrome 可执行文件');
    e.code = 'CHROME_NOT_FOUND';
    throw e;
  }
  const profile = ensureDir(paths.chromeProfile);
  ensureDir(paths.run);
  ensureDir(paths.logs);
  const log = fs.openSync(path.join(paths.logs, 'chrome.log'), 'a');

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate',
  ];
  if (openUrl) args.push(openUrl);

  const child = spawn(bin, args, { detached: true, stdio: ['ignore', log, log] });
  child.unref();
  fs.writeFileSync(path.join(paths.run, 'chrome.pid'), String(child.pid));

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const v = await version(port);
    if (v) return { started: true, pid: child.pid, ...v };
    await new Promise((r) => setTimeout(r, 300));
  }
  const e = new Error(`Chrome 已启动但 ${port} 端口在 20s 内没有响应`);
  e.code = 'CDP_TIMEOUT';
  throw e;
}

// 极简 CDP 客户端。Node 21+ 自带全局 WebSocket，所以内核零依赖。
export async function evaluate(wsUrl, expression, { timeout = 10000 } = {}) {
  const ws = new WebSocket(wsUrl);
  try {
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('CDP WebSocket 连接失败')), { once: true });
      setTimeout(() => rej(new Error('CDP WebSocket 连接超时')), timeout);
    });
    const id = 1;
    const reply = new Promise((res, rej) => {
      ws.addEventListener('message', (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id === id) msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
      });
      setTimeout(() => rej(new Error('CDP Runtime.evaluate 超时')), timeout);
    });
    ws.send(JSON.stringify({
      id,
      method: 'Runtime.evaluate',
      params: { expression, returnByValue: true, awaitPromise: true },
    }));
    const result = await reply;
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || '页面内求值抛出异常');
    }
    return result.result.value;
  } finally {
    try { ws.close(); } catch {}
  }
}
