// What a resumed job re-observes before it does anything else (ADR-0020: a reconnect restores the channel, not the
// page). It answers `PageObservation` (`wire.ts`) from the page as it is, and only reads: the login probe's snippet,
// the form's own tab and 单据编号 (bill number) readers, and one look for the 发票助手 (invoice assistant) window.
// Nothing here clicks, scrolls, focuses or waits; the server compares two of these and decides.
//
// It never throws. A reading that fails is the weakest answer (no account, no form, an assistant it cannot place),
// which the server can only find different from the page the job left, never accidentally the same.

import { evalIn, type CdpSession } from './cdp';
import { formTabs } from './erpform';
import { identityFromObservation, READ_ONLY_SNIPPET, type Observation } from './probe';
import { readHeaderField } from './reader';
import type { PageObservation } from './wire';

// The assistant is a Kendo `.k-window` titled 发票无忧助手 on the ERP page, whatever its cross-origin iframe is doing.
// Counted rather than found: two of them is not a state anyone may carry on from.
const ASSISTANT_WINDOWS = `(() => {
  const vis = (n) => {
    const b = n.getBoundingClientRect();
    const s = getComputedStyle(n);
    return b.width > 0 && b.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  return [...document.querySelectorAll('.k-window')]
    .filter((n) => vis(n) && String(n.querySelector('.k-window-title')?.textContent || '').trim() === '发票无忧助手').length;
})()`;

async function erpAccount(session: CdpSession, erpOrigin: string): Promise<PageObservation['erpAccount']> {
  try {
    const verdict = identityFromObservation(await evalIn<Observation>(session, READ_ONLY_SNIPPET), { transport: 'chromium-cdp', origin: erpOrigin });
    return verdict?.status === 'matched' ? verdict.identity : null;
  } catch {
    return null;
  }
}

// The same readings the fill job records as an attempt's preconditions (`readForm`), without the grids.
async function form(session: CdpSession, targetId: string): Promise<PageObservation['form']> {
  try {
    const tabs = await formTabs(session);
    if (tabs.length !== 1) return null;
    const bill = await readHeaderField(session, 'FBILLNO');
    if (!bill.ok) return null;
    return { targetId, formInstanceId: bill.instance, formMode: tabs[0]!.mode, billNo: bill.value === '' ? null : bill.value };
  } catch {
    return null;
  }
}

async function assistant(session: CdpSession): Promise<PageObservation['assistant']> {
  try {
    const open = await evalIn<number>(session, ASSISTANT_WINDOWS);
    return open === 0 ? 'closed' : open === 1 ? 'open' : 'unrecognised';
  } catch {
    return 'unrecognised';
  }
}

/** The ERP page in `session` as it is now. `targetId` is the page's CDP target id, as the job's attempts record it. */
export async function observePage(session: CdpSession, { targetId, erpOrigin }: { targetId: string; erpOrigin: string }): Promise<PageObservation> {
  return { erpAccount: await erpAccount(session, erpOrigin), form: await form(session, targetId), assistant: await assistant(session) };
}
