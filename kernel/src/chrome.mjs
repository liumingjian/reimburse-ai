import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { paths, ensureDir } from './paths.mjs';

export const CDP_PORT = Number(
  process.env.BAOX_CHROMIUM_CDP_PORT || process.env.BAOX_CDP_PORT || 9333,
);

const LAUNCH_TIMEOUT = 20000;
const LOCK_WAIT_TIMEOUT = LAUNCH_TIMEOUT + 5000;
const LOCK_STALE_AFTER = LOCK_WAIT_TIMEOUT + 5000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

const CANDIDATE_BY_BUNDLE = {
  darwin: {
    'com.google.Chrome': '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    'com.microsoft.edgemac': '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  },
};

export function findChrome({ browserBundleId = null } = {}) {
  if (process.env.BAOX_CHROME) return process.env.BAOX_CHROME;
  const preferred = CANDIDATE_BY_BUNDLE[process.platform]?.[browserBundleId];
  const candidates = [...(preferred ? [preferred] : []), ...(CANDIDATES[process.platform] || [])];
  for (const p of [...new Set(candidates)]) {
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

async function existingVersion(port) {
  // 一次 1.5 秒超时只能说明这一刻没答，不能证明 Chrome 不存在。启动新实例前
  // 再问一次，避免主线程短暂繁忙时把一个健康的专用 Chrome 判成 down。
  return await version(port) || await version(port);
}

function readLaunchLock(lockDir) {
  let stat;
  try { stat = fs.statSync(lockDir); } catch { return null; }
  try {
    const owner = JSON.parse(fs.readFileSync(path.join(lockDir, 'owner.json'), 'utf8'));
    return { owner, age: Date.now() - stat.mtimeMs };
  } catch {
    // mkdir 和 owner.json 写入之间崩溃也会留下锁。年龄仍从目录读取，过了 stale
    // 门槛即可回收；刚 mkdir 尚未来得及写 owner 的正常持有者不会被碰。
    return { owner: null, age: Date.now() - stat.mtimeMs };
  }
}

async function acquireLaunchLock(port, timeout) {
  ensureDir(paths.run);
  const lockDir = path.join(paths.run, 'chrome-launch.lock');
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    try {
      fs.mkdirSync(lockDir, { mode: 0o700 });
      fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({
        pid: process.pid, token, port, acquiredAt: new Date().toISOString(),
      }));
      const heartbeat = setInterval(() => {
        try {
          const current = readLaunchLock(lockDir);
          if (current?.owner?.token === token) fs.utimesSync(lockDir, new Date(), new Date());
        } catch {}
      }, 1000);
      heartbeat.unref();
      return {
        acquired: true,
        release() {
          clearInterval(heartbeat);
          // 只删自己仍持有的锁；绝不根据 chrome.pid 杀进程，也不探测或碰未知进程。
          try {
            const current = readLaunchLock(lockDir);
            if (current?.owner?.token === token) fs.rmSync(lockDir, { recursive: true });
          } catch {}
        },
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }

    const existing = await version(port);
    if (existing) return { acquired: false, existing, release() {} };

    const current = readLaunchLock(lockDir);
    // 持有者每秒刷新目录时间；只有心跳超龄才按崩溃遗留锁回收。这里不探测、
    // 不关闭任何进程；年龄门槛也避免撞上 owner.json 尚未写完的极短窗口。
    if (current && current.age >= LOCK_STALE_AFTER) {
      try {
        const again = readLaunchLock(lockDir);
        if (again?.owner?.token === current.owner?.token) fs.rmSync(lockDir, { recursive: true });
      } catch {}
      continue;
    }
    await sleep(100);
  }

  const e = new Error(`等待另一个 Chrome 启动请求超过 ${Math.ceil(timeout / 1000)}s`);
  e.code = 'CHROME_LAUNCH_LOCK_TIMEOUT';
  throw e;
}

export async function launch({ port = CDP_PORT, openUrl, browserBundleId = null, chromePath = null,
  readinessTimeout = LAUNCH_TIMEOUT, lockWaitTimeout = LOCK_WAIT_TIMEOUT } = {}) {
  const existing = await existingVersion(port);
  if (existing) return { started: false, ...existing };

  const lock = await acquireLaunchLock(port, lockWaitTimeout);
  if (!lock.acquired) return { started: false, ...lock.existing };

  try {
    // 等锁期间另一个持有者可能刚完成启动；拿到锁后必须在 spawn 前重新确认。
    const ready = await existingVersion(port);
    if (ready) return { started: false, ...ready };

    const bin = chromePath ?? findChrome({ browserBundleId });
    if (!bin) {
      const e = new Error('未找到 Chrome 可执行文件');
      e.code = 'CHROME_NOT_FOUND';
      throw e;
    }
    const profile = ensureDir(paths.chromeProfile);
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

    let child;
    try {
      child = spawn(bin, args, { detached: true, stdio: ['ignore', log, log] });
    } finally {
      fs.closeSync(log);
    }
    child.unref();

    let launchFailure = null;
    child.once('error', (err) => { launchFailure = err; });
    child.once('exit', (code, signal) => {
      launchFailure ??= new Error(`Chrome 在 CDP ready 前退出（code=${code}, signal=${signal}）`);
    });
    if (child.pid) fs.writeFileSync(path.join(paths.run, 'chrome.pid'), String(child.pid));

    const deadline = Date.now() + readinessTimeout;
    while (Date.now() < deadline) {
      const v = await version(port);
      if (v) return { started: true, pid: child.pid, ...v };
      if (launchFailure) {
        const e = new Error(`Chrome 启动失败：${launchFailure.message}`);
        e.code = 'CHROME_LAUNCH_FAILED';
        throw e;
      }
      await sleep(300);
    }
    const e = new Error(`Chrome 已启动但 ${port} 端口在 ${Math.ceil(readinessTimeout / 1000)}s 内没有响应`);
    e.code = 'CDP_TIMEOUT';
    throw e;
  } finally {
    lock.release();
  }
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

  // method -> 一组回调。事件是没有 id 的那些包。
  const listeners = new Map();

  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.id === undefined) {
      for (const fn of listeners.get(msg.method) || []) {
        try { fn(msg.params || {}, msg.sessionId || null); } catch {}
      }
      return;
    }
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

  // sessionId 是给附加上去的子目标用的（跨域 iframe 是独立目标，只能这样说话）。
  // 用 flatten 模式，回包还是走同一条连接、还是按 id 认领，所以这里只多带一个字段。
  const send = (method, params = {}, { timeout: t = timeout, sessionId = null } = {}) => {
    if (closed) return Promise.reject(closed);
    const id = ++seq;
    const p = new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`CDP ${method} 超时`));
      }, t);
    });
    ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    return p;
  };

  const on = (method, fn) => {
    if (!listeners.has(method)) listeners.set(method, new Set());
    listeners.get(method).add(fn);
    return () => listeners.get(method).delete(fn);
  };

  return { send, on, close: () => { try { ws.close(); } catch {} } };
}

function commandForPid(pid) {
  try {
    process.kill(pid, 0);
    if (process.platform === 'win32') return null;
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

export async function close({ port = CDP_PORT, pidFile = path.join(paths.run, 'chrome.pid'),
  profile = paths.chromeProfile, versionFn = version, connectFn = connect,
  processCommand = commandForPid } = {}) {
  const pid = Number.parseInt(fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8') : '', 10);
  const command = Number.isInteger(pid) ? processCommand(pid) : '';
  const current = await versionFn(port);
  if (!current) {
    return command ? { ok: false, reason: 'cdp_unavailable' } : { ok: true, alreadyClosed: true };
  }
  if (!command || !command.includes(`--remote-debugging-port=${port}`)
      || !command.includes(`--user-data-dir=${profile}`)) {
    return { ok: false, reason: 'browser_not_owned' };
  }
  if (!current.webSocketDebuggerUrl) return { ok: false, reason: 'cdp_unavailable' };

  try {
    const session = await connectFn(current.webSocketDebuggerUrl, { timeout: 3000 });
    try { await session.send('Browser.close'); } finally { session.close(); }
  } catch {
    return { ok: false, reason: 'close_failed' };
  }

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!await versionFn(port)) return { ok: true };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { ok: false, reason: 'still_running' };
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

/**
 * 页面里的全部框架。金蝶的对话框（发票无忧助手就是一例）整个活在 iframe 里：
 * 主文档只看得见一个标题，正文一个字都读不到——不进框架就等于没打开。
 */
export async function frames(session) {
  await session.send('Page.enable');
  const { frameTree } = await session.send('Page.getFrameTree');
  const out = [];
  const walk = (node) => {
    out.push({ id: node.frame.id, url: node.frame.url || '', name: node.frame.name || null });
    for (const c of node.childFrames || []) walk(c);
  };
  walk(frameTree);
  return out;
}

/**
 * 在指定框架里求值。走隔离世界：读得到 DOM，碰不到页面自己的 JS 变量——
 * 只读探测本来也只需要 DOM。
 *
 * 注意框架内的 getBoundingClientRect 是**框架自己的**视口坐标，
 * 而 Input.* 事件走的是顶层视口坐标。要点击框架里的东西，
 * 得把框架元素在顶层里的位置加回去（见 frameOffset）。
 */
export async function evalInFrame(session, frameId, expression, { timeout = 10000 } = {}) {
  const { executionContextId } = await session.send('Page.createIsolatedWorld',
    { frameId, grantUniveralAccess: true });
  return unwrap(await session.send('Runtime.evaluate',
    { expression, contextId: executionContextId, returnByValue: true, awaitPromise: true }, { timeout }));
}

/**
 * 附到一个跨域 iframe 目标上，拿一个"看起来和普通会话一样"的子会话。
 * 发票无忧助手（piaozone.com）就是这种目标：它不在主页面的框架树里，
 * Page.getFrameTree 看不见它，只有 Target.getTargets 里才有。
 */
export async function attachTarget(session, targetId) {
  const { sessionId } = await session.send('Target.attachToTarget', { targetId, flatten: true });
  return {
    sessionId,
    send: (method, params = {}, opts = {}) => session.send(method, params, { ...opts, sessionId }),
    // 只把属于这个子目标的事件转给调用方。
    on: (method, fn) => session.on(method, (params, sid) => { if (sid === sessionId) fn(params, sid); }),
    close: () => {},
  };
}

/**
 * 盯住这个页面新生出来的子目标。
 *
 * `Target.getTargets` 里跨域 iframe 出现得**不稳定**：同一次点击，有时几秒后就查得到，
 * 有时轮询半分钟也查不到，而窗口和 iframe 其实早就在了。所以不轮询，改成开自动附加、
 * 等 `Target.attachedToTarget` 事件——目标一诞生就直接把 sessionId 送上门。
 *
 * 返回的 `waitFor` 拿到的是一个和普通会话同形的子会话，可以直接喂给 evalIn / clickAt。
 */
export async function autoAttach(session) {
  const children = new Map();   // targetId -> { info, sessionId }
  session.on('Target.attachedToTarget', (p) => {
    children.set(p.targetInfo.targetId, { info: p.targetInfo, sessionId: p.sessionId });
  });
  // 目标附上来的那一刻 url 往往还是 about:blank，真正的地址是**之后**才导航过去的。
  // 只记附加时那一份，就会永远等不到自己要的那个框架。
  session.on('Target.targetInfoChanged', (p) => {
    const c = children.get(p.targetInfo.targetId);
    if (c) c.info = p.targetInfo;
  });
  session.on('Target.detachedFromTarget', (p) => {
    for (const [id, c] of children) if (c.sessionId === p.sessionId) children.delete(id);
  });
  await session.send('Target.setAutoAttach',
    { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });

  const sub = (sessionId) => ({
    sessionId,
    send: (method, params = {}, opts = {}) => session.send(method, params, { ...opts, sessionId }),
    on: (method, fn) => session.on(method, (params, sid) => { if (sid === sessionId) fn(params, sid); }),
    close: () => {},
  });

  return {
    list: () => [...children.values()].map((c) => c.info),
    /** 等一个 url 命中 `match` 的子目标，等不到就返回 null（不抛）。 */
    waitFor: async (match, { timeout = 30000, interval = 500 } = {}) => {
      const until = Date.now() + timeout;
      while (Date.now() < until) {
        for (const c of children.values()) {
          const s2 = sub(c.sessionId);
          let url = c.info.url || '';
          // targetInfoChanged 也可能还没来，所以再去框架自己那边问一句当前地址。
          // 顺带确认它已经能求值了——附上了不等于能说话。
          try {
            const r = await s2.send('Runtime.evaluate',
              { expression: 'location.href', returnByValue: true });
            url = r.result?.value || url;
          } catch { children.delete(c.info.targetId); continue; }
          if (match(url)) return s2;
        }
        await new Promise((r) => setTimeout(r, interval));
      }
      return null;
    },
  };
}

/** 当前浏览器里的所有目标（含跨域 iframe）。 */
export async function targetList(session) {
  const { targetInfos } = await session.send('Target.getTargets');
  return targetInfos;
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

/** 敲一个功能键（Enter、Tab、Escape 之类）。modifiers 按 CDP 的位：Alt1/Ctrl2/Meta4/Shift8。 */
export async function pressKey(session, key, { modifiers = 0 } = {}) {
  const map = {
    Enter: { windowsVirtualKeyCode: 13, code: 'Enter', key: 'Enter', text: '\r' },
    Tab: { windowsVirtualKeyCode: 9, code: 'Tab', key: 'Tab' },
    Escape: { windowsVirtualKeyCode: 27, code: 'Escape', key: 'Escape' },
    Backspace: { windowsVirtualKeyCode: 8, code: 'Backspace', key: 'Backspace' },
    a: { windowsVirtualKeyCode: 65, code: 'KeyA', key: 'a' },
    ArrowDown: { windowsVirtualKeyCode: 40, code: 'ArrowDown', key: 'ArrowDown' },
    ArrowUp: { windowsVirtualKeyCode: 38, code: 'ArrowUp', key: 'ArrowUp' },
  };
  const k = map[key];
  if (!k) throw new Error(`不支持的按键 ${key}`);
  // 带修饰键时不发 char：那会往控件里塞一个字面字符，把全选变成输入一个 a。
  const withChar = k.text && modifiers === 0;
  await session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers, ...k });
  if (withChar) await session.send('Input.dispatchKeyEvent', { type: 'char', modifiers, ...k });
  await session.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers, ...k });
}

// mac 上是 Command，别处是 Ctrl。内核跟浏览器跑在同一台机器上，所以这里可以按平台判。
const SELECT_ALL_MODIFIER = process.platform === 'darwin' ? 4 : 2;

/**
 * 全选当前控件里的内容，好让接下来的逐键输入把旧值**替换**掉。
 *
 * 不用退格逐个删：旧值有几位是读出来的，读错就会删过头或删不干净，
 * 而"删不干净"会变成 0.0018.25 这种静默错值。
 *
 * 必须显式带上 `commands: ['selectAll']`：实测只发 Meta+A 的按键事件，
 * 光标所在的控件**根本不会全选**（2026-09-05 现场：事由写成了"客户支持客户支持"，
 * 费用金额因为拼成 0.0018.25 被控件整个丢弃）。Chrome 把编辑命令的分发放在
 * commands 上，而不是让页面自己去解释修饰键。
 */
export async function selectAll(session) {
  const key = { windowsVirtualKeyCode: 65, code: 'KeyA', key: 'a', modifiers: SELECT_ALL_MODIFIER };
  await session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key, commands: ['selectAll'] });
  await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
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
