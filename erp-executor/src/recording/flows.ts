// The named flows `probe <flow> --record <name>` drives through the live ERP. A flow is executor code run on a
// recording session (recorder.ts), so every page it passes through is captured with the element that moved it on.
// A flow stops before any consumption boundary: it opens and reads, it never saves, submits or imports.
//
// Adding a flow: give it the smallest `allowKeys` it needs, name what it ends on in `run`, and list in `mask` any
// part of its pages that shows data rather than UI (other people's work, lists of bills).
//
// What no flow can record, because reaching it crosses the boundary: recognised rows in the 发票无忧助手 (they need
// a real invoice uploaded to a third party), the 收票信息 rows and the 处理结果 (import result) window (they need
// 发票导入单据), and 已保存 / the 提示 that refuses a save (they need 保存). The fake ERP's hand-written pages keep
// those, each under an `@unverified` marker that says so.

import { evalIn } from '../cdp';
import { leaveEdit, selectOption } from '../erpform';
import { recognisedTotal } from '../invoice-grid';
import { waitFor, type Pace } from '../pace';
import { COMPATIBILITY_SNIPPET } from '../probe';
import { protocolReadings, readForm } from '../reader';
import { closeInvoiceAssistant, openInvoiceAssistant, openNewReimbursement, openUploadView, type WritePage } from '../steps';
import type { MaskRule } from './redact';
import type { RecordingSession } from './recorder';

export type Fingerprint = { erpBuild: string | null; formIds: string[]; activePanels: number };

export type Flow = {
  description: string;
  /** Whether the flow types. The recorder refuses every key otherwise. */
  allowKeys: boolean;
  mask: readonly MaskRule[];
  /**
   * Captions of ERP tabs the recorder closes before and after the flow (as well as every unsaved 新增), so that a
   * recording starts from the same page whatever the last run left open. Without it a 我的费用报销 list tab left
   * over from one run shortens the next run's menu path, and the recording depends on history.
   */
  closeTabs: readonly RegExp[];
  /** Drive the page, then `snapshot` the page the flow ends on. What it returns is written into the manifest. */
  run(page: { session: RecordingSession; pace: Pace }): Promise<Record<string, unknown>>;
};

/** A new form whose compatibility fingerprint has settled: the start of every flow. */
async function newForm(page: WritePage): Promise<Fingerprint> {
  await openNewReimbursement(page);
  // A fingerprint read the instant the tab opens is a race (probe.ts): wait until exactly one form id answers.
  const fingerprint = await waitFor(() => evalIn<Fingerprint>(page.session, COMPATIBILITY_SNIPPET), (read) => read?.formIds?.length === 1, 30_000, 500);
  if (fingerprint?.formIds?.length !== 1) throw new Error(`the new form's fingerprint did not settle: ${JSON.stringify(fingerprint)}`);
  return fingerprint;
}

const closeTabs = [/^我的费用报销$/];

export const FLOWS: Readonly<Record<string, Flow>> = {
  'new-form': {
    description: 'The logged-in console (login fingerprint), then 我的费用报销 -> 新增 up to an open, empty 费用报销单-新增 whose compatibility fingerprint has settled. Nothing is typed or saved; the 新增单 is discarded with its tab.',
    allowKeys: false,
    mask: [],
    closeTabs,
    async run({ session, pace }) {
      const fingerprint = await newForm({ session, pace });
      await session.snapshot('new-form');
      return { fingerprint };
    },
  },
  'detail-row': {
    description: 'A new 费用报销单 and the 费用明细行 it opens with: 发票类型 opened and set to 普通发票 (the value the row already has), and edit left through the 明细信息 anchor. The form the strict read-back reads, with one 费用明细行 and no 收票行. Nothing is typed or saved; the 新增单 is discarded with its tab.',
    allowKeys: false,
    mask: [],
    closeTabs,
    async run({ session, pace }) {
      const page = { session, pace };
      await newForm(page);
      const option = await selectOption(session, { column: '发票类型', option: '普通发票', pace });
      if (!option.ok) throw new Error(`发票类型 was not set: ${option.reason}`);
      const left = await leaveEdit(session, { pace });
      if (!left.ok || left.stillEditing !== false) throw new Error(`the row did not leave edit: ${JSON.stringify(left)}`);
      const readings = protocolReadings(await readForm(session));
      await session.snapshot('detail-row');
      return {
        invoiceTypes: option.options,
        detailColumns: readings.detailGrid.ok ? readings.detailGrid.columns.map((c) => c.label) : readings.detailGrid,
        receiptColumns: readings.receiptsGrid.ok ? readings.receiptsGrid.columns.map((c) => c.label) : readings.receiptsGrid,
      };
    },
  },
  'invoice-assistant': {
    description: 'A new 费用报销单, 收票信息 -> 选择发票 ▾ -> 不生成费用明细, which opens the 发票无忧助手 (invoice assistant) on its entry menu, then 电脑端选取 up to its empty upload view. Nothing is uploaded, ticked or imported; the assistant is closed and the 新增单 discarded with its tab.',
    allowKeys: false,
    mask: [],
    closeTabs,
    async run({ session, pace }) {
      const page: WritePage = { session, pace };
      await newForm(page);
      const opened = await openInvoiceAssistant(page);
      const assistant = await openUploadView(page);
      const recognised = await recognisedTotal(assistant);
      await session.snapshot('upload-view');
      session.stop();
      const closed = await closeInvoiceAssistant(page);
      if (!closed.ok) throw new Error('the assistant would not close');
      return { mode: opened.mode, menuItemIds: opened.menuItemIds, recognised };
    },
  },
};
