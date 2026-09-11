import { EGO_BROWSER } from './browser-open.mjs';
import { browserTransport } from './browser-read.mjs';
import { attachChromiumPage } from './chromium-cdp.mjs';

export function egoErpWriteTransport({ platform = process.platform } = {}) {
  return { transport: EGO_BROWSER, kind: EGO_BROWSER, platform };
}

/**
 * Resolve the write connection by engine, not by browser brand.  `ego` is an
 * explicit QA connection; ordinary Chrome and Edge use the same Chromium/CDP
 * connection once the selected ERP tab is attachable.
 */
export function chromiumErpWriteTransport({ env = process.env, platform = process.platform } = {}) {
  const selected = browserTransport({ env, platform });
  if (selected.transport === EGO_BROWSER) return egoErpWriteTransport({ platform });
  return { ...selected, kind: 'chromium-cdp', engine: 'chromium', platform };
}

export async function authorizeErpTaskSpacePage({ authorize } = {}) {
  if (typeof authorize !== 'function') throw new TypeError('authorize must be a function');
  return authorize({ transport: egoErpWriteTransport() });
}

export async function authorizeErpWritePage({
  authorize,
  attach = attachChromiumPage,
  env = process.env,
  platform = process.platform,
} = {}) {
  if (typeof authorize !== 'function') throw new TypeError('authorize must be a function');
  const requested = chromiumErpWriteTransport({ env, platform });
  const result = await authorize({ transport: requested });
  if (!result?.ok || result.page?.transport === EGO_BROWSER) return result;
  return { ...result, page: await attach(result.page, { env }) };
}

export async function prepareErpWrite({ page, navigate, read, openAssistant, mark } = {}) {
  if (typeof navigate !== 'function') throw new TypeError('navigate must be a function');
  if (typeof read !== 'function') throw new TypeError('read must be a function');
  if (typeof openAssistant !== 'function') throw new TypeError('openAssistant must be a function');
  if (typeof mark !== 'function') throw new TypeError('mark must be a function');
  try { await navigate(page); } catch (error) {
    error.phase ??= 'navigate';
    throw error;
  }
  let afterOpen;
  try { afterOpen = await read(page); } catch (error) {
    error.phase ??= 'preflight';
    throw error;
  }
  const receiptRows = afterOpen?.receiptsGrid?.rows?.filter((row) => row.kind === 'data') ?? [];
  if (afterOpen?.formMode?.value !== 'new' || afterOpen?.billNo?.value !== null
    || receiptRows.length !== 0) {
    const error = new Error('导航后没有读到唯一空白的费用报销单-新增');
    error.code = 'ERP_PREFLIGHT_NOT_BLANK';
    error.phase = 'preflight';
    error.details = {
      formMode: afterOpen?.formMode,
      billNo: afterOpen?.billNo,
      receiptRowCount: receiptRows.length,
    };
    throw error;
  }
  try { await openAssistant(page); } catch (error) {
    error.phase ??= 'invoice_assistant';
    throw error;
  }
  const markedTask = await mark();
  return { afterOpen, markedTask };
}
