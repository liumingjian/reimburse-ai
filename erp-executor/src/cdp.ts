// Origin: 50931a3:kernel/src/chrome.mjs (connect, evalIn, autoAttach, clickAt, typeText, pressKey, selectAll, targets).
// A minimal Chrome DevTools Protocol client. Node 24 ships a global WebSocket, so this needs no dependency.
//
// One connection carries many commands: Kingdee (金蝶) controls only accept real input events, so
// "read an element's position -> click there -> read it back" must run on one session.

export type CdpSendOptions = { timeout?: number; sessionId?: string | null };
export type CdpListener = (params: Record<string, unknown>, sessionId: string | null) => void;

/** The seam every ERP primitive talks through. The fake ERP implements the same shape. */
export interface CdpSession {
  send(method: string, params?: Record<string, unknown>, options?: CdpSendOptions): Promise<any>;
  on?(method: string, listener: CdpListener): () => void;
  close(): void;
}

export type CdpTarget = { id?: string; type?: string; url?: string; title?: string; webSocketDebuggerUrl?: string };

/** Page targets of a Chromium started with `--remote-debugging-port`. */
export async function targets(port: number): Promise<CdpTarget[]> {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`CDP /json/list HTTP ${response.status}`);
  return (await response.json()) as CdpTarget[];
}

export async function connect(wsUrl: string, { timeout = 10_000 } = {}): Promise<CdpSession> {
  const ws = new WebSocket(wsUrl);
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const listeners = new Map<string, Set<CdpListener>>();
  let seq = 0;
  let closed: Error | null = null;

  ws.addEventListener('message', (event) => {
    let message: { id?: number; method?: string; params?: Record<string, unknown>; sessionId?: string; result?: unknown; error?: { message: string } };
    try { message = JSON.parse(String(event.data)); } catch { return; }
    if (message.id === undefined) {
      for (const listener of listeners.get(message.method ?? '') ?? []) {
        try { listener(message.params ?? {}, message.sessionId ?? null); } catch { /* a listener must not kill the socket */ }
      }
      return;
    }
    const waiting = pending.get(message.id);
    if (!waiting) return;
    pending.delete(message.id);
    if (message.error) waiting.reject(new Error(message.error.message));
    else waiting.resolve(message.result);
  });
  const die = (error: Error) => {
    closed = error;
    for (const [, waiting] of pending) waiting.reject(error);
    pending.clear();
  };
  ws.addEventListener('close', () => die(new Error('CDP 连接已关闭')));
  ws.addEventListener('error', () => die(new Error('CDP 连接出错')));

  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')), { once: true });
    setTimeout(() => reject(new Error('CDP WebSocket 连接超时')), timeout);
  });

  return {
    send(method, params = {}, { timeout: t = timeout, sessionId = null } = {}) {
      if (closed) return Promise.reject(closed);
      const id = ++seq;
      const promise = new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        setTimeout(() => { if (pending.delete(id)) reject(new Error(`CDP ${method} 超时`)); }, t);
      });
      ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
      return promise;
    },
    on(method, listener) {
      if (!listeners.has(method)) listeners.set(method, new Set());
      listeners.get(method)!.add(listener);
      return () => listeners.get(method)?.delete(listener);
    },
    close() { try { ws.close(); } catch { /* already closed */ } },
  };
}

type EvaluateResult = { result?: { value?: unknown }; exceptionDetails?: { exception?: { description?: string } } };

/** Evaluate an expression in the page. The only entry for every read-only probe. */
export async function evalIn<T = any>(session: CdpSession, expression: string, { timeout = 10_000 } = {}): Promise<T> {
  const result = (await session.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, { timeout })) as EvaluateResult;
  if (result?.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || '页面内求值抛出异常');
  return result?.result?.value as T;
}

/**
 * Tell this target it is focused and active, whatever the desktop thinks.
 *
 * This CHANGES browser behaviour: the page reports `document.visibilityState === 'visible'` and keeps focus while
 * its window is buried behind others, so timers, animations and `visibilitychange` handlers see a foreground page
 * nobody is looking at. It is still the correct default here, because the dedicated Chromium (ADR-0016) IS a
 * background automation browser: on a real desktop its window is occluded nearly all the time, and an occluded —
 * hence hidden — page receives no `Input.dispatchMouseEvent` at all. CDP accepts the command, answers ok, and
 * delivers the click nowhere.
 *
 * Measured live 2026-09-19 (V-53): with a `mousedown` listener on the element `document.elementFromPoint` resolved
 * at the click point, the listener saw nothing; after this command the same click produced
 * `["down:SPAN…","click:SPAN"]` and the page turned `visible`. Occlusion had silently eaten 登录, the 确认 of
 * 该帐号已登录在线, the 菜单 and 新增. Every click this executor makes rests on it, so it is enabled on every
 * session the executor attaches to, the piaozone OOPIF included.
 */
export async function enableFocusEmulation(session: CdpSession): Promise<{ ok: boolean; error?: string }> {
  try {
    await session.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    return { ok: true };
  } catch (error: any) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/** A child session on a cross-origin iframe target (the piaozone invoice assistant, 发票无忧助手). */
export type ChildTargets = {
  list(): Array<Record<string, unknown>>;
  waitFor(match: (url: string) => boolean, options?: { timeout?: number; interval?: number }): Promise<CdpSession | null>;
};

/**
 * Watch child targets as they are born. `Target.getTargets` lists cross-origin iframes unreliably, so this uses
 * auto-attach and `Target.attachedToTarget` events; `targetInfoChanged` keeps the url current because a target
 * attaches as about:blank and navigates afterwards.
 */
export async function autoAttach(session: CdpSession): Promise<ChildTargets> {
  if (!session.on) throw new Error('CDP session cannot receive events');
  const children = new Map<string, { info: Record<string, any>; sessionId: string }>();
  const focused = new Set<string>();
  session.on('Target.attachedToTarget', (p: any) => {
    children.set(p.targetInfo.targetId, { info: p.targetInfo, sessionId: p.sessionId });
  });
  session.on('Target.targetInfoChanged', (p: any) => {
    const child = children.get(p.targetInfo.targetId);
    if (child) child.info = p.targetInfo;
  });
  session.on('Target.detachedFromTarget', (p: any) => {
    for (const [id, child] of children) if (child.sessionId === p.sessionId) children.delete(id);
  });
  await session.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });

  const sub = (sessionId: string): CdpSession => ({
    send: (method, params = {}, options = {}) => session.send(method, params, { ...options, sessionId }),
    on: (method, listener) => session.on!(method, (params, sid) => { if (sid === sessionId) listener(params, sid); }),
    close: () => {},
  });

  return {
    list: () => [...children.values()].map((child) => child.info),
    async waitFor(match, { timeout = 30_000, interval = 500 } = {}) {
      const until = Date.now() + timeout;
      do {
        for (const child of [...children.values()]) {
          const childSession = sub(child.sessionId);
          let url = String(child.info.url ?? '');
          try {
            const r = await childSession.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true });
            url = r?.result?.value || url;
          } catch { children.delete(String(child.info.targetId)); continue; }
          if (match(url)) {
            // Once per child target. Best-effort here: a frame target that does not implement Emulation must not
            // kill the assistant path, and the parent page's emulation may already cover its frame tree. The page
            // target itself is not best-effort — see `attachChromiumPage`.
            if (!focused.has(child.sessionId)) {
              focused.add(child.sessionId);
              await enableFocusEmulation(childSession);
            }
            return childSession;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, interval));
      } while (Date.now() < until);
      return null;
    },
  };
}

// Real input below. It never edits the DOM; it makes the browser produce the event stream a person would.

export async function clickAt(session: CdpSession, x: number, y: number, { button = 'left', clickCount = 1 } = {}): Promise<void> {
  const base = { x, y, button, clickCount, buttons: button === 'left' ? 1 : 0 };
  await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
  await session.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' });
  await session.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', buttons: 0 });
}

/** Type key by key. A whole-value fill once "succeeded" visibly and was dropped on blur. */
export async function typeText(session: CdpSession, text: string): Promise<void> {
  for (const ch of String(text)) {
    await session.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, unmodifiedText: ch });
    await session.send('Input.dispatchKeyEvent', { type: 'keyUp', text: ch, unmodifiedText: ch });
  }
}

const KEYS: Record<string, { windowsVirtualKeyCode: number; code: string; key: string; text?: string }> = {
  Enter: { windowsVirtualKeyCode: 13, code: 'Enter', key: 'Enter', text: '\r' },
  Tab: { windowsVirtualKeyCode: 9, code: 'Tab', key: 'Tab' },
  Escape: { windowsVirtualKeyCode: 27, code: 'Escape', key: 'Escape' },
  Backspace: { windowsVirtualKeyCode: 8, code: 'Backspace', key: 'Backspace' },
  Delete: { windowsVirtualKeyCode: 46, code: 'Delete', key: 'Delete' },
  a: { windowsVirtualKeyCode: 65, code: 'KeyA', key: 'a' },
  ArrowDown: { windowsVirtualKeyCode: 40, code: 'ArrowDown', key: 'ArrowDown' },
  ArrowUp: { windowsVirtualKeyCode: 38, code: 'ArrowUp', key: 'ArrowUp' },
};

/** Press a function key. Modifier bits follow CDP: Alt 1, Ctrl 2, Meta 4, Shift 8. */
export async function pressKey(session: CdpSession, key: string, { modifiers = 0 } = {}): Promise<void> {
  const k = KEYS[key];
  if (!k) throw new Error(`不支持的按键 ${key}`);
  // With a modifier no `char` is sent: it would type a literal character and turn select-all into typing an "a".
  const withChar = !!k.text && modifiers === 0;
  await session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers, ...k });
  if (withChar) await session.send('Input.dispatchKeyEvent', { type: 'char', modifiers, ...k });
  await session.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers, ...k });
}

// Node names the platform on `process`, a browser (the extension's service worker) on `navigator`.
const onMac = typeof process !== 'undefined' ? process.platform === 'darwin' : /^Mac/.test(globalThis.navigator?.platform ?? '');
const SELECT_ALL_MODIFIER = onMac ? 4 : 2;

/**
 * Select the control's content so the typed value replaces it. `commands: ['selectAll']` is required: a bare
 * Meta+A left the old value in place on the real ERP (the purpose became "客户支持客户支持").
 */
export async function selectAll(session: CdpSession): Promise<void> {
  const key = { windowsVirtualKeyCode: 65, code: 'KeyA', key: 'a', modifiers: SELECT_ALL_MODIFIER };
  await session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key, commands: ['selectAll'] });
  await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
}

/** A cropped PNG screenshot (base64), for #32's error capture. */
export async function screenshot(session: CdpSession, clip?: { x: number; y: number; width: number; height: number }): Promise<string | null> {
  try {
    const r = await session.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
    return typeof r?.data === 'string' ? r.data : null;
  } catch {
    return null;
  }
}
