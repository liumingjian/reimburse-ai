import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

import {
  egoPage,
  evaluateEgoPage,
  isEgoControlError,
  isEgoPage,
  listEgoTabs,
  safeUrl as egoSafeUrl,
} from './ego.mjs';
import {
  CHROMIUM_CDP_TRANSPORT,
  chromiumCdpTransport as buildChromiumCdpTransport,
  evaluateChromiumPage,
  listChromiumPages,
} from './chromium-cdp.mjs';

export const DEFAULT_BROWSER_UNSUPPORTED = 'DEFAULT_BROWSER_UNSUPPORTED';
export const DEFAULT_BROWSER_AUTOMATION_PERMISSION_REQUIRED =
  'DEFAULT_BROWSER_AUTOMATION_PERMISSION_REQUIRED';
export const DEFAULT_BROWSER_JAVASCRIPT_PERMISSION_REQUIRED =
  'DEFAULT_BROWSER_JAVASCRIPT_PERMISSION_REQUIRED';
export const DEFAULT_BROWSER_WRITE_UNSUPPORTED = 'DEFAULT_BROWSER_WRITE_UNSUPPORTED';
export const DEFAULT_BROWSER_ORIGIN_REQUIRED = 'DEFAULT_BROWSER_ORIGIN_REQUIRED';
export const DEFAULT_BROWSER_ORIGIN_MISMATCH = 'DEFAULT_BROWSER_ORIGIN_MISMATCH';
export const DEFAULT_BROWSER_PAGE_IDENTITY_MISMATCH = 'DEFAULT_BROWSER_PAGE_IDENTITY_MISMATCH';
export const DEFAULT_BROWSER_PAGE_NOT_FOUND = 'DEFAULT_BROWSER_PAGE_NOT_FOUND';
export const DEFAULT_BROWSER_EVALUATION_FAILED = 'DEFAULT_BROWSER_EVALUATION_FAILED';
export const DEFAULT_BROWSER_EVALUATION_TIMEOUT = 'DEFAULT_BROWSER_EVALUATION_TIMEOUT';
export const DEFAULT_BROWSER_NOT_RUNNING = 'DEFAULT_BROWSER_NOT_RUNNING';
export const DEFAULT_BROWSER_PROTOCOL_ERROR = 'DEFAULT_BROWSER_PROTOCOL_ERROR';
export const BROWSER_TRANSPORT_UNSUPPORTED = 'BROWSER_TRANSPORT_UNSUPPORTED';

const DEFAULT_TIMEOUT_MS = 15_000;
const NATIVE_CLEANUP_GRACE_MS = 1_000;
const MACOS = 'darwin';

const errorWithCode = (code, message, cause = undefined) => {
  const error = new Error(message);
  error.code = code;
  if (cause !== undefined) error.cause = cause;
  return error;
};

const normalizeOrigin = (value) => {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    return parsed.origin;
  } catch {
    return null;
  }
};

/** The URL form used in tab descriptors never includes query or hash state. */
export const safeUrl = (value) => egoSafeUrl(value);
export { normalizeOrigin };

const sameOrigin = (left, right) => {
  const a = normalizeOrigin(left);
  const b = normalizeOrigin(right);
  return !!a && !!b && a === b;
};

const knownBrowsers = Object.freeze([
  { bundleId: 'com.google.Chrome', name: 'Google Chrome', family: 'chromium' },
  { bundleId: 'com.microsoft.edgemac', name: 'Microsoft Edge', family: 'chromium' },
]);

const browserById = new Map(knownBrowsers.map((browser) => [browser.bundleId, browser]));

/** Resolve only browser scripting dictionaries that this adapter understands. */
export function browserInfoForBundleId(bundleId) {
  const id = typeof bundleId === 'string' ? bundleId.trim() : '';
  const exact = browserById.get(id);
  if (exact) return { ...exact };

  throw errorWithCode(DEFAULT_BROWSER_UNSUPPORTED,
    `系统默认浏览器 ${id || '（未知）'} 不是当前支持的 Chromium 浏览器`);
}

export function browserTransport({ env = process.env, platform = process.platform } = {}) {
  const selected = typeof env?.BAOX_BROWSER === 'string' ? env.BAOX_BROWSER.trim().toLowerCase() : '';
  if (!selected || selected === 'default' || selected === 'system') {
    return { transport: 'default', kind: 'default', platform };
  }
  if (selected === 'ego') return { transport: 'ego', kind: 'ego', platform };
  throw errorWithCode(BROWSER_TRANSPORT_UNSUPPORTED,
    `BAOX_BROWSER=${JSON.stringify(env.BAOX_BROWSER)} 不是受支持的浏览器传输（可用 default 或 ego）`);
}

export const getBrowserTransport = browserTransport;
export const chromiumCdpTransport = buildChromiumCdpTransport;

/**
 * Build the small page-context bridge used by the supported Chromium browsers.
 * Apple Events does not consistently await a Promise returned by execute or
 * do JavaScript, so the bridge returns a JSON marker synchronously and polls
 * a request-scoped slot until the Promise settles.  The strings are passed as
 * JSON argv data to the fixed JXA helper; they are never inserted into JXA.
 */
export function buildPageBridgeScripts(expression, requestId) {
  if (typeof expression !== 'string' || !expression.trim()) {
    throw new TypeError('page expression must be non-empty');
  }
  if (typeof requestId !== 'string' || !requestId.trim()) {
    throw new TypeError('page bridge request id must be non-empty');
  }
  const keySource = JSON.stringify(`__baox_read_${requestId}`);
  const start = '(function(){const k=' + keySource + ';try{const v=(' + expression
    + ');if(v&&typeof v.then===\'function\'){window[k]={state:\'pending\'};Promise.resolve(v).then('
    + 'x=>{if(Object.prototype.hasOwnProperty.call(window,k))window[k]={state:\'fulfilled\',value:x===undefined?null:x};},'
    + 'e=>{if(Object.prototype.hasOwnProperty.call(window,k))window[k]={state:\'rejected\',message:String(e&&e.message||e)};});'
    + 'return JSON.stringify({state:\'pending\'});}return JSON.stringify({state:\'fulfilled\',value:v===undefined?null:v});'
    + '}catch(e){return JSON.stringify({state:\'rejected\',message:String(e&&e.message||e)});}})()';
  const poll = '(function(){const v=window[' + keySource + '];return JSON.stringify(v||{state:\'missing\'});})()';
  const cleanup = '(function(){try{delete window[' + keySource + '];}catch(e){}return JSON.stringify(null);})()';
  return { start, poll, cleanup, key: `__baox_read_${requestId}` };
}

// This script is intentionally fixed.  Values that can contain user/page data
// are passed in one JSON argv item and are never interpolated into JXA source.
// It only reads browser metadata or asks the selected tab to evaluate a caller
// supplied read expression; it has no navigation, click, form, cookie, or
// password operation.
export const DEFAULT_BROWSER_JXA = String.raw`
ObjC.import('Foundation');
ObjC.import('CoreServices');
ObjC.import('AppKit');

const processArguments = () => {
  const args = $.NSProcessInfo.processInfo.arguments;
  const out = [];
  for (let i = 0; i < args.count; i += 1) out.push(ObjC.unwrap(args.objectAtIndex(i)));
  return out;
};

const input = JSON.parse(processArguments().at(-1) || '{}');
const valueOf = (read) => {
  try {
    const value = read();
    return value === undefined || value === null ? null : value;
  } catch {
    return null;
  }
};
const textOf = (read) => {
  const value = valueOf(read);
  return value === null ? null : String(value);
};
const safeUrl = (value) => {
  const raw = String(value ?? '');
  const match = raw.match(/^(https?):\/\/([^/?#]+)(\/[^?#]*)?/i);
  if (!match) return raw.split(/[?#]/, 1)[0];
  const protocol = match[1].toLowerCase();
  let authority = match[2].toLowerCase();
  if (protocol === 'http' && authority.endsWith(':80')) authority = authority.slice(0, -3);
  if (protocol === 'https' && authority.endsWith(':443')) authority = authority.slice(0, -4);
  return protocol + '://' + authority + (match[3] || '/');
};
const originOf = (value) => {
  const match = String(value ?? '').match(/^(https?):\/\/([^/?#]+)/i);
  if (!match) return null;
  const protocol = match[1].toLowerCase();
  let authority = match[2].toLowerCase();
  if (protocol === 'http' && authority.endsWith(':80')) authority = authority.slice(0, -3);
  if (protocol === 'https' && authority.endsWith(':443')) authority = authority.slice(0, -4);
  return protocol + '://' + authority;
};
const sameOrigin = (left, right) => {
  const a = originOf(left);
  const b = originOf(right);
  return !!a && !!b && a === b;
};
const fail = (code, message) => {
  const error = new Error(message);
  error.code = code;
  throw error;
};
const browser = input.browser || {};
const app = () => Application(browser.bundleId);

const defaultBrowser = () => {
  const scheme = input.scheme === 'http' || input.scheme === 'https' ? input.scheme : 'https';
  const ref = $.LSCopyDefaultHandlerForURLScheme($(scheme));
  return ref ? ObjC.unwrap(ObjC.castRefToObject(ref)) : null;
};

const browserWindows = () => {
  const running = $.NSRunningApplication.runningApplicationsWithBundleIdentifier($(browser.bundleId));
  if (!running || running.count === 0) {
    fail('DEFAULT_BROWSER_NOT_RUNNING', '系统默认浏览器当前没有运行');
  }
  try {
    return app().windows();
  } catch (error) {
    throw error;
  }
};

const listTabs = () => {
  const out = [];
  for (const [windowIndex, window] of browserWindows().entries()) {
    const windowId = textOf(() => window.id()) ?? String(windowIndex);
    const tabs = window.tabs();
    const activeId = textOf(() => window.activeTab().id());
    for (const [tabIndex, tab] of tabs.entries()) {
      const tabId = textOf(() => tab.id());
      const url = textOf(() => tab.url()) ?? '';
      const inScope = !input.origin || sameOrigin(url, input.origin);
      if (input.origin && !inScope) continue;
      // Do not return metadata from unrelated user pages when the caller
      // supplied an ERP origin.  URL metadata is only used for this local
      // origin gate.
      const title = inScope
        ? textOf(() => tab.title())
        : null;
      out.push({ windowId, tabId, index: tabIndex, url: safeUrl(url), title,
        active: tabId !== null && tabId === activeId });
    }
  }
  return out;
};

const findWindow = (expected) => {
  const windows = browserWindows();
  const window = windows.find((candidate, index) => {
    const id = textOf(() => candidate.id()) ?? String(index);
    return String(id) === String(expected.windowId);
  });
  if (!window) fail('DEFAULT_BROWSER_PAGE_NOT_FOUND', '系统默认浏览器中找不到目标窗口');
  return window;
};

const findTab = (window, expected) => {
  const tabs = window.tabs();
  const tab = tabs.find((candidate) => textOf(() => candidate.id()) === String(expected.tabId));
  if (!tab) fail('DEFAULT_BROWSER_PAGE_NOT_FOUND', '系统默认浏览器中找不到目标标签页');

  const currentUrl = textOf(() => tab.url()) ?? '';
  if (!sameOrigin(currentUrl, input.origin)) {
    fail('DEFAULT_BROWSER_ORIGIN_MISMATCH', '目标标签页已经离开原 origin，拒绝求值');
  }
  if (expected.url && safeUrl(currentUrl) !== expected.url) {
    fail('DEFAULT_BROWSER_PAGE_IDENTITY_MISMATCH', '目标标签页 URL 已变化，拒绝猜测标签身份');
  }
  return tab;
};

const invokePageJavaScript = (tab, source) => tab.execute({ javascript: source });

const evaluate = () => {
  if (typeof input.expression !== 'string' || !input.expression.trim()) {
    fail('DEFAULT_BROWSER_EVALUATION_FAILED', '页面求值表达式不能为空');
  }
  if (!input.origin) fail('DEFAULT_BROWSER_ORIGIN_REQUIRED', '页面求值必须带 origin 闸');
  const tab = findTab(findWindow(input.page), input.page);
  const scripts = input.pageScripts || {};
  if (typeof scripts.start !== 'string' || typeof scripts.poll !== 'string'
    || typeof scripts.cleanup !== 'string') {
    fail('DEFAULT_BROWSER_EVALUATION_FAILED', '页面异步求值脚本不完整');
  }
  const toState = (value) => {
    if (typeof value !== 'string') return value;
    try { return JSON.parse(value); } catch { return value; }
  };
  let state = toState(invokePageJavaScript(tab, scripts.start));
  if (state?.state === 'fulfilled') return state.value === undefined ? null : state.value;
  if (state?.state === 'rejected') fail('DEFAULT_BROWSER_EVALUATION_FAILED', state.message || '页面求值失败');
  if (state?.state !== 'pending') fail('DEFAULT_BROWSER_EVALUATION_FAILED', '页面异步求值没有返回受控状态');

  const timeoutMs = Math.max(1, Number(input.timeoutMs) || 15_000);
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      $.NSThread.sleepForTimeInterval(0.05);
      state = toState(invokePageJavaScript(findTab(findWindow(input.page), input.page), scripts.poll));
      if (state?.state === 'fulfilled') return state.value === undefined ? null : state.value;
      if (state?.state === 'rejected') {
        fail('DEFAULT_BROWSER_EVALUATION_FAILED', state.message || '页面异步求值失败');
      }
      if (state?.state !== 'pending') {
        fail('DEFAULT_BROWSER_EVALUATION_FAILED', '页面异步求值状态丢失');
      }
    }
    fail('DEFAULT_BROWSER_EVALUATION_TIMEOUT', '页面求值超过 ' + timeoutMs + 'ms 没有返回');
  } finally {
    try {
      const currentTab = findTab(findWindow(input.page), input.page);
      invokePageJavaScript(currentTab, scripts.cleanup);
    } catch {}
  }
};

let result;
try {
  let value;
  if (input.operation === 'default-browser') value = defaultBrowser();
  else if (input.operation === 'list-tabs') value = listTabs();
  else if (input.operation === 'evaluate') value = evaluate();
  else fail('DEFAULT_BROWSER_EVALUATION_FAILED', '未知只读操作 ' + String(input.operation));
  result = { ok: true, value: value === undefined ? null : value };
} catch (error) {
  result = { ok: false, error: { code: error && error.code ? String(error.code) : null,
    message: error && error.message ? String(error.message) : String(error) } };
}
JSON.stringify(result);
`;

const nativeErrorCode = (text, fallback = DEFAULT_BROWSER_EVALUATION_FAILED) => {
  const value = String(text ?? '');
  if (/Allow JavaScript from Apple Events|Executing JavaScript through AppleScript is turned off|enable[^\n]*JavaScript[^\n]*Apple Events|JavaScript[^\n]*(?:turned off|disabled)/i.test(value)) {
    return DEFAULT_BROWSER_JAVASCRIPT_PERMISSION_REQUIRED;
  }
  if (/not authorized to send Apple Events|not authorised to send Apple Events|permission denied|(-1743|-1744)|Apple Events[^\n]*(?:not allowed|denied|permission)/i.test(value)) {
    return DEFAULT_BROWSER_AUTOMATION_PERMISSION_REQUIRED;
  }
  return fallback;
};

const parseNativeResult = (stdout, stderr = '') => {
  const lines = String(stdout ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const line = lines.at(-1);
  if (!line) throw errorWithCode(nativeErrorCode(stderr, 'DEFAULT_BROWSER_PROTOCOL_ERROR'),
    `osascript 没有返回受控结果${stderr ? `：${stderr.trim()}` : ''}`);
  let result;
  try {
    result = JSON.parse(line);
  } catch (error) {
    throw errorWithCode(nativeErrorCode(stderr || line, 'DEFAULT_BROWSER_PROTOCOL_ERROR'),
      `osascript 返回结果不是 JSON：${error.message}`, error);
  }
  if (!result || result.ok !== true) {
    const rawCode = typeof result?.error?.code === 'string' ? result.error.code : '';
    const code = /^DEFAULT_BROWSER_[A-Z0-9_]+$/.test(rawCode)
      ? rawCode : nativeErrorCode(`${result?.error?.message || ''}\n${stderr}`);
    throw errorWithCode(code, result?.error?.message || '系统默认浏览器只读脚本失败');
  }
  return result.value;
};

/** Run the fixed native helper. `payload` is one JSON argv value. */
export function runNativeBrowserScript(payload, {
  command = 'osascript',
  timeoutMs = DEFAULT_TIMEOUT_MS,
  spawnImpl = spawn,
  platform = process.platform,
} = {}) {
  if (platform !== MACOS) {
    return Promise.reject(errorWithCode(DEFAULT_BROWSER_UNSUPPORTED,
      '系统默认浏览器只读适配目前只支持 macOS'));
  }
  let encoded;
  try {
    encoded = JSON.stringify(payload);
  } catch (error) {
    return Promise.reject(errorWithCode(DEFAULT_BROWSER_PROTOCOL_ERROR,
      `只读浏览器参数无法编码：${error.message}`, error));
  }
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(command, ['-l', 'JavaScript', '-', encoded], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(errorWithCode('DEFAULT_BROWSER_HELPER_UNAVAILABLE',
        `无法启动 osascript：${error.message}`, error));
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGTERM'); } catch {}
      reject(errorWithCode('DEFAULT_BROWSER_TIMEOUT', `osascript 超过 ${timeoutMs}ms 没有返回`));
    }, timeoutMs);
    timer.unref?.();
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => finish(reject, errorWithCode(
      error.code === 'ENOENT' ? 'DEFAULT_BROWSER_HELPER_UNAVAILABLE' : 'DEFAULT_BROWSER_PROTOCOL_ERROR',
      `osascript 执行失败：${error.message}`, error)));
    child.once('close', (code, signal) => {
      if (settled) return;
      try {
        finish(resolve, parseNativeResult(stdout, stderr));
      } catch (error) {
        if (code !== 0 && error.code === 'DEFAULT_BROWSER_PROTOCOL_ERROR' && stderr.trim()) {
          error.code = nativeErrorCode(stderr, error.code);
        }
        error.nativeExit = { code, signal };
        finish(reject, error);
      }
    });
    try {
      child.stdin?.end(`${DEFAULT_BROWSER_JXA}\n`);
    } catch (error) {
      finish(reject, errorWithCode('DEFAULT_BROWSER_PROTOCOL_ERROR',
        `无法向 osascript 写入只读脚本：${error.message}`, error));
    }
  });
}

export async function defaultBrowserInfo({
  origin = null,
  scheme = null,
  platform = process.platform,
  run = runNativeBrowserScript,
} = {}) {
  if (platform !== MACOS) {
    throw errorWithCode(DEFAULT_BROWSER_UNSUPPORTED,
      '系统默认浏览器只读适配目前只支持 macOS');
  }
  const expectedOrigin = normalizeOrigin(origin);
  const selectedScheme = scheme ?? (expectedOrigin ? new URL(expectedOrigin).protocol.slice(0, -1) : 'https');
  if (selectedScheme !== 'http' && selectedScheme !== 'https') {
    throw errorWithCode(DEFAULT_BROWSER_UNSUPPORTED,
      `系统默认浏览器解析只支持 http/https，收到 ${JSON.stringify(selectedScheme)}`);
  }
  const result = await run({ operation: 'default-browser', scheme: selectedScheme });
  const bundleId = typeof result === 'string' ? result : result?.bundleId;
  return browserInfoForBundleId(bundleId);
}

const defaultPageId = (tab) => String(tab.tabId ?? `${tab.windowId}:${tab.index}`);

/** Convert a native or ego tab descriptor into a stable page context. */
export function browserPage(tab, { origin = null, browser = null } = {}) {
  if (tab?.transport === 'ego') {
    return {
      ...tab,
      transport: 'ego',
      tabId: tab.tabId ?? tab.id ?? tab.targetId,
      url: safeUrl(tab.url),
    };
  }
  const browserBundleId = tab?.browserBundleId ?? tab?.bundleId ?? browser?.bundleId;
  const info = browserInfoForBundleId(browserBundleId);
  const pageOrigin = normalizeOrigin(origin ?? tab?.origin);
  return {
    transport: 'default',
    browserBundleId: info.bundleId,
    browserName: info.name,
    browserFamily: info.family,
    windowId: tab?.windowId === undefined || tab?.windowId === null ? null : String(tab.windowId),
    tabId: tab?.tabId === undefined || tab?.tabId === null ? null : String(tab.tabId),
    index: Number.isInteger(tab?.index) ? tab.index : null,
    url: safeUrl(tab?.url),
    title: tab?.title ?? null,
    active: tab?.active === true,
    origin: pageOrigin,
    // A diagnostic-only identity label. It is never used to locate a page.
    pageId: defaultPageId({ windowId: tab?.windowId, tabId: tab?.tabId, index: tab?.index }),
  };
}

export function isDefaultBrowserPage(page) {
  if (page?.transport !== 'default') return false;
  if (typeof page.browserBundleId !== 'string' || !browserById.has(page.browserBundleId)) return false;
  if (page.windowId === null || page.windowId === undefined) return false;
  const hasChromiumTabId = page.browserFamily === 'chromium' && page.tabId;
  return !!hasChromiumTabId;
}

export const isBrowserPage = (page) => page?.transport === 'ego'
  ? isEgoPage(page) : isDefaultBrowserPage(page);

export async function listBrowserTabs({
  origin = null,
  transport = browserTransport(),
  platform = process.platform,
  run = runNativeBrowserScript,
  browser = null,
  targetsFn,
} = {}) {
  const kind = typeof transport === 'string' ? transport : transport?.kind ?? transport?.transport;
  const expectedOrigin = normalizeOrigin(origin);
  if (kind === 'ego') {
    const tabs = await listEgoTabs();
    return tabs
      .filter((tab) => !expectedOrigin || sameOrigin(tab.url, expectedOrigin))
      .map((tab) => ({ ...egoPage({ tabId: tab.id, url: tab.url, title: tab.title }),
        title: tab.title ?? null, origin: normalizeOrigin(tab.url) }));
  }
  if (kind === CHROMIUM_CDP_TRANSPORT) {
    return (await listChromiumPages({ origin: expectedOrigin, port: transport?.cdpPort, targetsFn }))
      .filter((page) => !expectedOrigin || sameOrigin(page.url, expectedOrigin));
  }
  if (kind !== 'default') {
    throw errorWithCode(BROWSER_TRANSPORT_UNSUPPORTED, `未知浏览器传输 ${String(kind)}`);
  }
  const info = browser ?? await defaultBrowserInfo({ origin: expectedOrigin, platform, run });
  const tabs = await run({ operation: 'list-tabs', browser: info, origin: expectedOrigin });
  if (!Array.isArray(tabs)) {
    throw errorWithCode('DEFAULT_BROWSER_PROTOCOL_ERROR', '系统默认浏览器返回的标签列表不是数组');
  }
  return tabs
    .filter((tab) => !expectedOrigin || sameOrigin(tab.url, expectedOrigin))
    .map((tab) => browserPage(tab, { origin: expectedOrigin, browser: info }));
}

const pageError = (code, message) => errorWithCode(code, message);

/** Read a selected page. A default-browser page must carry an origin gate. */
export async function evaluateBrowserPage(page, expression, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  origin = null,
  platform = process.platform,
  run = runNativeBrowserScript,
  browser = null,
} = {}) {
  if (typeof expression !== 'string' || !expression.trim()) {
    throw new TypeError('page expression must be non-empty');
  }
  if (page?.automation === 'cdp') {
    return evaluateChromiumPage(page, expression, { timeoutMs });
  }
  if (page?.transport === 'ego') {
    // Keep the existing ego ownership/assignment error unchanged.  In
    // particular, do not fall back to the system browser after it is raised.
    if (!isEgoPage(page)) {
      throw pageError('EGO_PAGE_REQUIRED', 'ERP 页面句柄不是 ego task-space page context');
    }
    try {
      return await evaluateEgoPage(page, expression, { timeoutMs });
    } catch (error) {
      if (isEgoControlError(error)) throw error;
      throw error;
    }
  }
  if (platform !== MACOS) {
    throw pageError(DEFAULT_BROWSER_UNSUPPORTED, '系统默认浏览器只读适配目前只支持 macOS');
  }
  if (!isDefaultBrowserPage(page)) {
    throw pageError('DEFAULT_BROWSER_PAGE_REQUIRED',
      '系统默认 Chromium 浏览器只读需要带有 bundle、window 和 tab 的页面句柄');
  }
  const expectedOrigin = normalizeOrigin(origin ?? page.origin);
  if (!expectedOrigin) throw pageError(DEFAULT_BROWSER_ORIGIN_REQUIRED,
    '系统默认浏览器页面求值必须带 http(s) origin 闸');
  if (page.origin && !sameOrigin(page.origin, expectedOrigin)) {
    throw pageError(DEFAULT_BROWSER_ORIGIN_MISMATCH, '页面句柄 origin 与本次求值 origin 不一致');
  }
  const info = browser ?? browserInfoForBundleId(page.browserBundleId);
  if (info.bundleId !== page.browserBundleId) {
    throw pageError(DEFAULT_BROWSER_PAGE_IDENTITY_MISMATCH,
      '页面句柄所属浏览器已经变化，拒绝把求值发给另一浏览器');
  }
  const requestId = randomUUID();
  return run({ operation: 'evaluate', browser: info,
    origin: expectedOrigin, expression, requestId, timeoutMs,
    pageScripts: buildPageBridgeScripts(expression, requestId),
    page: { windowId: page.windowId, tabId: page.tabId, index: page.index, url: page.url } },
  { timeoutMs: timeoutMs + NATIVE_CLEANUP_GRACE_MS });
}

export const defaultBrowserWriteUnsupported = () => {
  throw errorWithCode(DEFAULT_BROWSER_WRITE_UNSUPPORTED,
    'ERP 写入需要当前系统默认 Chromium 页面具备 CDP 自动化连接');
};

export const isEgoBrowserControlError = isEgoControlError;
