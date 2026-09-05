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
//
// 一次连接要能发多条命令：金蝶的控件只认真实输入事件（DOM 里可见的值 ERP 未必收到，
// 这是 save-contract 里反复踩到的坑），所以"读一下元素位置 -> 在那个位置真点一下 ->
// 再读回来确认"必须在同一个会话里连着做。
export async function connect(wsUrl, { timeout = 10000 } = {}) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let seq = 0;
  let closed = null;

  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
  });
  const die = (err) => {
    closed = err;
    for (const [, p] of pending) p.reject(err);
    pending.clear();
  };
  ws.addEventListener('close', () => die(new Error('CDP 连接已关闭')));
  ws.addEventListener('error', () => die(new Error('CDP 连接出错')));

  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('CDP WebSocket 连接失败')), { once: true });
    setTimeout(() => rej(new Error('CDP WebSocket 连接超时')), timeout);
  });

  const send = (method, params = {}, { timeout: t = timeout } = {}) => {
    if (closed) return Promise.reject(closed);
    const id = ++seq;
    const p = new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`CDP ${method} 超时`));
      }, t);
    });
    ws.send(JSON.stringify({ id, method, params }));
    return p;
  };

  return { send, close: () => { try { ws.close(); } catch {} } };
}

const unwrap = (result) => {
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || '页面内求值抛出异常');
  }
  return result.result.value;
};

/** 在会话里求值。这是所有只读探测的唯一入口。 */
export async function evalIn(session, expression, { timeout = 10000 } = {}) {
  return unwrap(await session.send('Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true }, { timeout }));
}

/** 一次性求值：开一条连接、问一句、关掉。只读探测都走这个。 */
export async function evaluate(wsUrl, expression, { timeout = 10000 } = {}) {
  const session = await connect(wsUrl, { timeout });
  try {
    return await evalIn(session, expression, { timeout });
  } finally {
    session.close();
  }
}

// 下面是**真实输入**。它们不改 DOM，只让浏览器产生和人操作时一样的事件流 ——
// 这是让金蝶控件真正收到值的唯一可靠办法。

/** 在视口坐标上真点一下。 */
export async function clickAt(session, x, y, { button = 'left', clickCount = 1 } = {}) {
  const base = { x, y, button, clickCount, buttons: button === 'left' ? 1 : 0 };
  await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
  await session.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' });
  await session.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', buttons: 0 });
}

/** 逐键输入文本。整值 fill 曾出现"编辑态可见、失焦后丢失"的假成功，所以只走逐键。 */
export async function typeText(session, text) {
  for (const ch of String(text)) {
    await session.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, unmodifiedText: ch });
    await session.send('Input.dispatchKeyEvent', { type: 'keyUp', text: ch, unmodifiedText: ch });
  }
}

/** 敲一个功能键（Enter、Tab、Escape 之类）。 */
export async function pressKey(session, key) {
  const map = {
    Enter: { windowsVirtualKeyCode: 13, code: 'Enter', key: 'Enter', text: '\r' },
    Tab: { windowsVirtualKeyCode: 9, code: 'Tab', key: 'Tab' },
    Escape: { windowsVirtualKeyCode: 27, code: 'Escape', key: 'Escape' },
    Backspace: { windowsVirtualKeyCode: 8, code: 'Backspace', key: 'Backspace' },
  };
  const k = map[key];
  if (!k) throw new Error(`不支持的按键 ${key}`);
  await session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...k });
  if (k.text) await session.send('Input.dispatchKeyEvent', { type: 'char', ...k });
  await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...k });
}

/** 开一个新标签页 / 关掉它。排练用的临时页面靠它，不去动用户已经开着的页面。 */
export async function newTab(url, port = CDP_PORT) {
  const r = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`,
    { method: 'PUT', signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`CDP /json/new HTTP ${r.status}`);
  return await r.json();
}

export async function closeTab(id, port = CDP_PORT) {
  const r = await fetch(`http://127.0.0.1:${port}/json/close/${id}`, { signal: AbortSignal.timeout(5000) });
  return r.ok;
}
