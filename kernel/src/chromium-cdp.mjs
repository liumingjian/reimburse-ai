import { connect, evalIn, targets } from './chrome.mjs';

export const CHROMIUM_CDP_REQUIRED = 'CHROMIUM_CDP_REQUIRED';
export const CHROMIUM_CDP_AMBIGUOUS = 'CHROMIUM_CDP_AMBIGUOUS';
export const CHROMIUM_CDP_UNAVAILABLE = 'CHROMIUM_CDP_UNAVAILABLE';
export const CHROMIUM_CDP_TRANSPORT = 'chromium-cdp';

const DEFAULT_PORT = 9333;

const errorWithCode = (code, message, cause = undefined) => {
  const error = new Error(message);
  error.code = code;
  if (cause !== undefined) error.cause = cause;
  return error;
};

const originOf = (value) => {
  try { return new URL(value).origin; } catch { return null; }
};

const pathOf = (value) => {
  try { return new URL(value).pathname; } catch { return null; }
};

const samePage = (target, page) => {
  const targetOrigin = originOf(target?.url);
  const pageOrigin = originOf(page?.url ?? page?.origin);
  const targetPath = pathOf(target?.url);
  const pagePath = pathOf(page?.url);
  return !!targetOrigin && targetOrigin === pageOrigin && targetPath === pagePath;
};

export const cdpPortOf = (env = process.env) => {
  const raw = env?.BAOX_CHROMIUM_CDP_PORT ?? env?.BAOX_CDP_PORT ?? DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw errorWithCode(CHROMIUM_CDP_REQUIRED,
      `Chromium CDP 端口无效：${JSON.stringify(raw)}`);
  }
  return port;
};

/** The browser-neutral write/read transport used after ERP automation is needed. */
export function chromiumCdpTransport({ env = process.env, platform = process.platform } = {}) {
  return {
    transport: 'default',
    kind: CHROMIUM_CDP_TRANSPORT,
    cdpPort: cdpPortOf(env),
    platform,
  };
}

const safeUrl = (value) => {
  try {
    const parsed = new URL(value);
    return parsed.origin + parsed.pathname;
  } catch {
    return String(value ?? '').split(/[?#]/, 1)[0];
  }
};

const pageContext = (target, port) => ({
  // Keep the normal system-browser page shape so the rest of the ERP adapters
  // can share their origin and Chromium-family gates. `automation: 'cdp'`
  // selects the protocol evaluator before the Apple Events evaluator runs.
  transport: 'default',
  automation: 'cdp',
  browserFamily: 'chromium',
  tabId: target.id ?? null,
  index: null,
  url: safeUrl(target.url),
  title: target.title ?? null,
  active: false,
  origin: originOf(target.url),
  pageId: String(target.id ?? target.url ?? ''),
  cdpPort: port,
  cdpTargetId: target.id ?? null,
  cdpUrl: target.webSocketDebuggerUrl,
});

/** List the selected ERP pages from the managed or externally CDP-enabled Chromium. */
export async function listChromiumPages({ origin = null, port, targetsFn = targets,
  env = process.env } = {}) {
  const cdpPort = port ?? cdpPortOf(env);
  const available = await targetsFn(cdpPort);
  return available
    .filter((target) => target?.type === undefined || target.type === 'page')
    .filter((target) => typeof target?.webSocketDebuggerUrl === 'string'
      && target.webSocketDebuggerUrl.length > 0)
    .map((target) => pageContext(target, cdpPort));
}

/** Evaluate a read expression through CDP, closing only a temporary connection. */
export async function evaluateChromiumPage(page, expression, {
  timeoutMs = 15_000, connectFn = connect, evalFn = evalIn,
} = {}) {
  if (page?.transport !== 'default' || page?.browserFamily !== 'chromium'
    || page?.automation !== 'cdp') {
    throw errorWithCode(CHROMIUM_CDP_REQUIRED, 'ERP Chromium 页面没有有效的 CDP 页面上下文');
  }
  if (page.session) return evalFn(page.session, expression, { timeout: timeoutMs });
  if (!page.cdpUrl) throw errorWithCode(CHROMIUM_CDP_REQUIRED, 'ERP Chromium 页面缺少 CDP 连接地址');
  const session = await connectFn(page.cdpUrl, { timeout: timeoutMs });
  try {
    return await evalFn(session, expression, { timeout: timeoutMs });
  } finally {
    session.close?.();
  }
}

const isChromiumPageContext = (page) => page?.transport === 'default'
  && page?.browserFamily === 'chromium';

/**
 * Attach to the already-selected Chromium tab through one browser-neutral
 * protocol. Chrome and Edge both expose the same CDP page target shape; the
 * browser brand is intentionally not part of this seam.
 */
export async function attachChromiumPage(page, {
  port,
  targetsFn = targets,
  connectFn = connect,
  env = process.env,
} = {}) {
  if (!isChromiumPageContext(page)) {
    throw errorWithCode(CHROMIUM_CDP_REQUIRED,
      'ERP 写入需要已选中的 Chromium 页面，当前页面不是 Chrome/Edge 页面');
  }
  const cdpPort = port ?? cdpPortOf(env);
  let available;
  try {
    available = await targetsFn(cdpPort);
  } catch (error) {
    throw errorWithCode(CHROMIUM_CDP_UNAVAILABLE,
      `当前 Chromium 没有可用的自动化连接（CDP ${cdpPort}）。请使用支持自动化连接的 Chrome/Edge 页面后重试`, error);
  }
  const matches = available.filter((target) => samePage(target, page)
    && typeof target.webSocketDebuggerUrl === 'string' && target.webSocketDebuggerUrl);
  if (matches.length === 0) {
    throw errorWithCode(CHROMIUM_CDP_UNAVAILABLE,
      '自动化连接中找不到当前已选中的 ERP 页面；不会改用 ego 或猜测其他标签页');
  }
  if (matches.length > 1) {
    throw errorWithCode(CHROMIUM_CDP_AMBIGUOUS,
      `自动化连接中有 ${matches.length} 个相同 ERP 页面，拒绝猜测写入目标`);
  }
  const target = matches[0];
  let session;
  try {
    session = await connectFn(target.webSocketDebuggerUrl, { timeout: 20_000 });
  } catch (error) {
    throw errorWithCode(CHROMIUM_CDP_UNAVAILABLE,
      '已找到 ERP 页面，但无法建立 Chromium 自动化连接', error);
  }
  return {
    ...page,
    automation: 'cdp',
    cdpPort,
    cdpTargetId: target.id ?? null,
    cdpUrl: target.webSocketDebuggerUrl,
    session,
  };
}

export function isCdpChromiumPage(page) {
  return page?.transport === 'default'
    && page?.browserFamily === 'chromium'
    && page?.automation === 'cdp'
    && page?.session && typeof page.session.send === 'function';
}

export function closeChromiumPage(page) {
  try { page?.session?.close?.(); } catch {}
}
