// Origin: kernel/src/erp-write-context.mjs. Chooses the write transport, attaches the authorised page, and
// prepares the blank form. The ego transport is dropped (ADR-0016); only Chromium over CDP remains.

import { attachChromiumPage, chromiumCdpTransport, type ChromiumPage } from './chromium';

type Env = Record<string, string | undefined>;
type Authorize = (options: { transport: ReturnType<typeof chromiumCdpTransport> }) => Promise<{ ok: boolean; page?: ChromiumPage; [extra: string]: unknown }>;

/** Ask for authorisation on the Chromium transport, then attach to that same page. */
export async function authorizeErpWritePage({ authorize, attach = attachChromiumPage, env = process.env, platform = process.platform }: {
  authorize: Authorize; attach?: (page: ChromiumPage, options: { env: Env }) => Promise<ChromiumPage>; env?: Env; platform?: string;
}) {
  if (typeof authorize !== 'function') throw new TypeError('authorize must be a function');
  const requested = chromiumCdpTransport({ env, platform });
  const result = await authorize({ transport: requested });
  if (!result?.ok || !result.page) return result;
  return { ...result, page: await attach(result.page, { env }) };
}

type Phased = Error & { phase?: string; code?: string; details?: unknown };

const withPhase = (error: unknown, phase: string): Phased => {
  const e = (error instanceof Error ? error : new Error(String(error))) as Phased;
  e.phase ??= phase;
  return e;
};

export type BlankFormReadings = {
  formMode?: { value?: string | null };
  billNo?: { value?: string | null };
  receiptsGrid?: unknown;
};

/**
 * Navigate to a new form, verify it is one blank 费用报销单-新增, open the invoice assistant, and only then mark.
 * A failure anywhere before `mark` leaves no mark: nothing was written, so the job may be retried.
 */
export async function prepareErpWrite<P, R extends BlankFormReadings, M>({ page, navigate, read, openAssistant, mark }: {
  page: P; navigate: (page: P) => Promise<unknown>; read: (page: P) => Promise<R>; openAssistant: (page: P) => Promise<unknown>; mark: () => Promise<M>;
}): Promise<{ afterOpen: R; markedTask: M }> {
  if (typeof navigate !== 'function') throw new TypeError('navigate must be a function');
  if (typeof read !== 'function') throw new TypeError('read must be a function');
  if (typeof openAssistant !== 'function') throw new TypeError('openAssistant must be a function');
  if (typeof mark !== 'function') throw new TypeError('mark must be a function');
  try { await navigate(page); } catch (error) { throw withPhase(error, 'navigate'); }
  let afterOpen: R;
  try { afterOpen = await read(page); } catch (error) { throw withPhase(error, 'preflight'); }
  const grid = afterOpen?.receiptsGrid as { rows?: Array<{ kind: string }> } | null | undefined;
  const receiptRows = grid?.rows?.filter((row) => row.kind === 'data') ?? [];
  if (afterOpen?.formMode?.value !== 'new' || afterOpen?.billNo?.value !== null || receiptRows.length !== 0) {
    const error = new Error('导航后没有读到唯一空白的费用报销单-新增') as Phased;
    error.code = 'ERP_PREFLIGHT_NOT_BLANK';
    error.phase = 'preflight';
    error.details = { formMode: afterOpen?.formMode, billNo: afterOpen?.billNo, receiptRowCount: receiptRows.length };
    throw error;
  }
  try { await openAssistant(page); } catch (error) { throw withPhase(error, 'invoice_assistant'); }
  const markedTask = await mark();
  return { afterOpen, markedTask };
}
