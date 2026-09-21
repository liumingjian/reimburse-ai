// chrome.debugger wrapped so that every command passes the brake, and so that the three candidate routes to the
// piaozone child target can be tried one at a time and reported on separately.
//
// The server-side executor talks CDP over a raw WebSocket to a Chromium started with --remote-debugging-port, and
// reaches the 发票无忧助手 (invoice assistant) iframe with `Target.setAutoAttach {flatten:true}` plus a `sessionId`
// on every message (server/src/erp/executor/cdp.ts). `chrome.debugger` is the same protocol with a different
// addressing scheme — a `DebuggerSession` object, not a raw sessionId field — so whether the same manoeuvre is
// available here is exactly question (1) of #250 and is NOT assumed anywhere in this file.

import { assertCommandAllowed, assertClickTargetAllowed, BrakeError } from './brake.js';

export { BrakeError };

const PROTOCOL_VERSION = '1.3';

/** Promise-wrapped chrome.debugger, with lastError turned into a rejection. */
const call = (fn, ...args) =>
  new Promise((resolve, reject) => {
    fn(...args, (result) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(result);
    });
  });

export const attach = (target) => call(chrome.debugger.attach.bind(chrome.debugger), target, PROTOCOL_VERSION);
export const detach = (target) => call(chrome.debugger.detach.bind(chrome.debugger), target);
export const getTargets = () => call(chrome.debugger.getTargets.bind(chrome.debugger));

/**
 * One rehearsal's worth of debugger state: the phase the brake reads, the child targets seen, and the event log.
 * `phase` starts at `drive` and is moved to `readonly` the instant the upload has been attempted — never back.
 */
export function createProbe({ onLog }) {
  const events = [];
  const children = new Map();
  let phase = 'drive';

  const log = (level, message, data) => onLog({ at: new Date().toISOString(), level, message, data });

  const hook = (source, method, params) => {
    if (method === 'Target.attachedToTarget') {
      children.set(params.targetInfo.targetId, { info: params.targetInfo, sessionId: params.sessionId, source });
    }
    if (method === 'Target.targetInfoChanged') {
      const child = children.get(params.targetInfo.targetId);
      if (child) child.info = params.targetInfo;
    }
    if (method === 'Target.detachedFromTarget') {
      for (const [id, child] of children) if (child.sessionId === params.sessionId) children.delete(id);
    }
    if (method.startsWith('Target.')) {
      // `source.sessionId` is the whole of question (1)'s route B: if chrome.debugger does not surface it, a flat
      // child session cannot be addressed from here at all. Recorded verbatim, present or absent.
      events.push({ method, sourceKeys: Object.keys(source ?? {}), sessionId: source?.sessionId ?? null, params });
    }
  };

  chrome.debugger.onEvent.addListener(hook);
  chrome.debugger.onDetach.addListener((source, reason) => log('warn', `调试器已断开：${reason}`, source));

  return {
    /** One way only. After this the brake refuses every input event and every scripted click. */
    sealReadOnly() {
      if (phase !== 'readonly') {
        phase = 'readonly';
        log('brake', '探针已进入只读阶段：之后不再发送任何输入事件。');
      }
    },
    children: () => [...children.values()],
    targetEvents: () => events,

    /** The single chokepoint. Nothing in this spike reaches chrome.debugger except through here. */
    async send(target, method, params = {}) {
      assertCommandAllowed(method, params, phase);
      log('cdp', `${method}`, { target, params: summarise(params) });
      return call(chrome.debugger.sendCommand.bind(chrome.debugger), target, method, params);
    },
  };
}

/** Keep megabytes of base64 out of the on-screen log without hiding that they were sent. */
function summarise(params) {
  const out = {};
  for (const [key, value] of Object.entries(params ?? {})) {
    out[key] = typeof value === 'string' && value.length > 240 ? `${value.slice(0, 120)}…（共 ${value.length} 字符）` : value;
  }
  return out;
}

/** Evaluate in whichever session `target` addresses, and surface a page-side throw as a rejection. */
export async function evalIn(probe, target, expression) {
  const result = await probe.send(target, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result?.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || '页面内求值抛出异常');
  }
  return result?.result?.value;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitFor(read, ok, { timeoutMs = 30_000, intervalMs = 500 } = {}) {
  const until = Date.now() + timeoutMs;
  let last;
  do {
    try {
      last = await read();
      if (ok(last)) return last;
    } catch (error) {
      if (error instanceof BrakeError) throw error;
      last = { error: String(error?.message ?? error) };
    }
    await sleep(intervalMs);
  } while (Date.now() < until);
  return last;
}

/**
 * Click a point that has just been hit-tested, after asking the page once more what is actually there. The second
 * read is barrier 2 of the brake: a point measured a second ago may now be under the import control.
 */
export async function clickPoint(probe, target, point, label) {
  const hit = await evalIn(probe, target, `(() => {
    const node = document.elementFromPoint(${point.x}, ${point.y});
    if (!node) return null;
    return { tag: node.tagName, text: String(node.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80) };
  })()`);
  if (!hit) throw new Error(`${label} 的落点 (${point.x}, ${point.y}) 上什么都没有，没有点击。`);
  assertClickTargetAllowed(hit, label);
  const base = { x: point.x, y: point.y, button: 'left', clickCount: 1 };
  await probe.send(target, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, buttons: 0 });
  await probe.send(target, 'Input.dispatchMouseEvent', { ...base, type: 'mousePressed', buttons: 1 });
  await probe.send(target, 'Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', buttons: 0 });
  return hit;
}
