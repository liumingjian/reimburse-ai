// Origin: 50931a3:kernel/src/chromium-cdp.mjs. Attach, list and evaluate Chromium pages over CDP.
// The v1 executor drives the app's dedicated Chromium profile; the browser brand (Chrome, Edge) is not part of
// this seam, and there is no fallback to another transport.

import { connect as cdpConnect, enableFocusEmulation, evalIn, targets as cdpTargets, type CdpSession, type CdpTarget } from './cdp';

export const CHROMIUM_CDP_REQUIRED = 'CHROMIUM_CDP_REQUIRED';
export const CHROMIUM_CDP_AMBIGUOUS = 'CHROMIUM_CDP_AMBIGUOUS';
export const CHROMIUM_CDP_UNAVAILABLE = 'CHROMIUM_CDP_UNAVAILABLE';
export const CHROMIUM_FOCUS_EMULATION_FAILED = 'CHROMIUM_FOCUS_EMULATION_FAILED';
export const CHROMIUM_CDP_TRANSPORT = 'chromium-cdp';

const DEFAULT_PORT = 9333;

export class ExecutorError extends Error {
  constructor(readonly code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

const originOf = (value: unknown) => { try { return new URL(String(value)).origin; } catch { return null; } };
const pathOf = (value: unknown) => { try { return new URL(String(value)).pathname; } catch { return null; } };

export type ChromiumPage = {
  transport: 'default'; automation?: 'cdp'; browserFamily: 'chromium'; tabId?: string | null; index?: number | null;
  url: string; title?: string | null; active?: boolean; origin?: string | null; pageId?: string; cdpPort?: number;
  cdpTargetId?: string | null; cdpUrl?: string; session?: CdpSession; [extra: string]: unknown;
};

const samePage = (target: CdpTarget, page: { url?: string; origin?: string | null }) => {
  const targetOrigin = originOf(target?.url);
  return !!targetOrigin && targetOrigin === originOf(page?.url ?? page?.origin) && pathOf(target?.url) === pathOf(page?.url);
};

type Env = Record<string, string | undefined>;

export const cdpPortOf = (env: Env = process.env) => {
  const raw = env?.BAOX_CHROMIUM_CDP_PORT ?? env?.BAOX_CDP_PORT ?? DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ExecutorError(CHROMIUM_CDP_REQUIRED, `Chromium CDP 端口无效：${JSON.stringify(raw)}`);
  return port;
};

/** The browser-neutral transport the executor uses once ERP automation is needed. */
export function chromiumCdpTransport({ env = process.env, platform = process.platform }: { env?: Env; platform?: string } = {}) {
  return { transport: 'default' as const, kind: CHROMIUM_CDP_TRANSPORT, cdpPort: cdpPortOf(env), platform };
}

/** Drop the query and hash: K3Cloud's `_cnneptstate_` parameter is session state and must not be logged. */
export const safeUrl = (value: unknown) => {
  try { const parsed = new URL(String(value)); return parsed.origin + parsed.pathname; } catch { return String(value ?? '').split(/[?#]/, 1)[0]!; }
};

const pageContext = (target: CdpTarget, port: number): ChromiumPage => ({
  transport: 'default', automation: 'cdp', browserFamily: 'chromium',
  tabId: target.id ?? null, index: null, url: safeUrl(target.url), title: target.title ?? null, active: false,
  origin: originOf(target.url), pageId: String(target.id ?? target.url ?? ''), cdpPort: port,
  cdpTargetId: target.id ?? null, cdpUrl: target.webSocketDebuggerUrl!,
});

/** List the page targets of the dedicated (or an externally CDP-enabled) Chromium. */
export async function listChromiumPages({ port, targetsFn = cdpTargets, env = process.env }: { port?: number; targetsFn?: (port: number) => Promise<CdpTarget[]>; env?: Env } = {}) {
  const cdpPort = port ?? cdpPortOf(env);
  const available = await targetsFn(cdpPort);
  return available
    .filter((target) => target?.type === undefined || target.type === 'page')
    .filter((target) => typeof target?.webSocketDebuggerUrl === 'string' && target.webSocketDebuggerUrl.length > 0)
    .map((target) => pageContext(target, cdpPort));
}

/** Evaluate a read expression through CDP, closing only a connection opened for it. */
export async function evaluateChromiumPage<T = any>(page: ChromiumPage, expression: string, {
  timeoutMs = 15_000, connectFn = cdpConnect, evalFn = evalIn,
}: { timeoutMs?: number; connectFn?: (url: string, options: { timeout: number }) => Promise<CdpSession>; evalFn?: (session: CdpSession, expression: string, options: { timeout: number }) => Promise<any> } = {}): Promise<T> {
  if (page?.transport !== 'default' || page?.browserFamily !== 'chromium' || page?.automation !== 'cdp') {
    throw new ExecutorError(CHROMIUM_CDP_REQUIRED, 'ERP Chromium 页面没有有效的 CDP 页面上下文');
  }
  if (page.session) return evalFn(page.session, expression, { timeout: timeoutMs });
  if (!page.cdpUrl) throw new ExecutorError(CHROMIUM_CDP_REQUIRED, 'ERP Chromium 页面缺少 CDP 连接地址');
  const session = await connectFn(page.cdpUrl, { timeout: timeoutMs });
  try {
    return await evalFn(session, expression, { timeout: timeoutMs });
  } finally {
    session.close?.();
  }
}

/**
 * Attach to the already-selected Chromium tab. No target or several identical targets is a hard stop: the executor
 * never guesses another tab.
 */
export async function attachChromiumPage(page: ChromiumPage, {
  port, targetsFn = cdpTargets, connectFn = cdpConnect, env = process.env,
}: { port?: number; targetsFn?: (port: number) => Promise<CdpTarget[]>; connectFn?: (url: string, options: { timeout: number }) => Promise<CdpSession>; env?: Env } = {}): Promise<ChromiumPage & { session: CdpSession }> {
  if (page?.transport !== 'default' || page?.browserFamily !== 'chromium') {
    throw new ExecutorError(CHROMIUM_CDP_REQUIRED, 'ERP 写入需要已选中的 Chromium 页面，当前页面不是 Chrome/Edge 页面');
  }
  const cdpPort = port ?? cdpPortOf(env);
  let available: CdpTarget[];
  try {
    available = await targetsFn(cdpPort);
  } catch (error) {
    throw new ExecutorError(CHROMIUM_CDP_UNAVAILABLE, `当前 Chromium 没有可用的自动化连接（CDP ${cdpPort}）。请使用支持自动化连接的 Chrome/Edge 页面后重试`, { cause: error });
  }
  const matches = available.filter((target) => samePage(target, page) && typeof target.webSocketDebuggerUrl === 'string' && target.webSocketDebuggerUrl);
  if (matches.length === 0) throw new ExecutorError(CHROMIUM_CDP_UNAVAILABLE, '自动化连接中找不到当前已选中的 ERP 页面；不会猜测其他标签页');
  if (matches.length > 1) throw new ExecutorError(CHROMIUM_CDP_AMBIGUOUS, `自动化连接中有 ${matches.length} 个相同 ERP 页面，拒绝猜测写入目标`);
  const target = matches[0]!;
  let session: CdpSession;
  try {
    session = await connectFn(target.webSocketDebuggerUrl!, { timeout: 20_000 });
  } catch (error) {
    throw new ExecutorError(CHROMIUM_CDP_UNAVAILABLE, '已找到 ERP 页面，但无法建立 Chromium 自动化连接', { cause: error });
  }
  // Focus emulation belongs to attaching, not to any one step: an occluded window delivers no mouse event at all,
  // and this browser's window is occluded whenever the employee is doing something else (see `enableFocusEmulation`).
  // A failure here is fatal on purpose — without it every later click may be swallowed in silence, which is the
  // failure mode this line exists to remove.
  const focus = await enableFocusEmulation(session);
  if (!focus.ok) {
    session.close?.();
    throw new ExecutorError(CHROMIUM_FOCUS_EMULATION_FAILED,
      `专用浏览器不接受焦点模拟（Emulation.setFocusEmulationEnabled）：${focus.error ?? '原因未知'}。窗口被遮挡时点击会被静默丢弃，已停下。`);
  }
  return { ...page, automation: 'cdp', cdpPort, cdpTargetId: target.id ?? null, cdpUrl: target.webSocketDebuggerUrl!, session };
}

export function isCdpChromiumPage(page: unknown): page is ChromiumPage & { session: CdpSession } {
  const p = page as ChromiumPage | null | undefined;
  return p?.transport === 'default' && p?.browserFamily === 'chromium' && p?.automation === 'cdp' && !!p?.session && typeof p.session.send === 'function';
}

export function closeChromiumPage(page: ChromiumPage | null | undefined) {
  try { page?.session?.close?.(); } catch { /* already closed */ }
}
