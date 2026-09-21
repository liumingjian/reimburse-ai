// The server's judgement over a fill job's read-backs (ADR-0016: server owns judgement, executor only observes).
// After import it turns the fresh receipt grid into the approved draft preview (kernel bin/baox.mjs erp-write:
// buildReceiptReadback -> buildErpDraftPreview -> write approval); later read-backs get the strict line match.
// The inputs keep the kernel's shapes; slice #191 wires them from task facts.

import type { ErpJudge } from './jobs';
import { buildErpDraftPreview, type PreviewInput } from './preview';
import type { ApprovedPreview, FreshGate, ReadbackVerdict } from '@baox/erp-executor/protocol';
import { buildReceiptReadback, judgeReadings, type ReadbackInvoice } from './readback';

export type DraftJudgeInputs = Omit<PreviewInput, 'receiptCheck' | 'receiptReadback' | 'freshGate'> & { invoices: ReadbackInvoice[] };

const reasonsOf = (problems: Array<{ code: string; message: string }>) => problems.map((p) => `${p.code}: ${p.message}`);

export function createDraftJudge(inputs: DraftJudgeInputs, { now = () => new Date() }: { now?: () => Date } = {}): ErpJudge {
  let approved: ApprovedPreview | null = null;
  return (event): ReadbackVerdict => {
    if (event.stage === 'after_import') {
      const taskId = inputs.task?.taskId ?? null;
      const versionId = inputs.built?.versionId ?? null;
      const identity = inputs.task?.identity ?? null;
      const receipts = buildReceiptReadback({ grid: event.readings.receiptsGrid as never, invoices: inputs.invoices, taskId, versionId, identity, readAt: now().toISOString() });
      if (!receipts.ok) return { ok: false, reasons: reasonsOf(receipts.problems) };
      const freshGate: FreshGate = { status: 'matched', fresh: true, taskId, versionId, identity, scope: { taskId, versionId, identity } };
      const draft = buildErpDraftPreview({ ...inputs, receiptCheck: receipts.receiptCheck, receiptReadback: receipts.receiptReadback, freshGate });
      if (!draft.ready) return { ok: false, reasons: reasonsOf(draft.problems) };
      approved = draft.expectedPreview;
      return { ok: true, preview: approved, approval: { digest: approved.previewDigest!, preview: structuredClone(approved) }, freshGate };
    }
    if (!approved) return { ok: false, reasons: ['没有已批准的 ERP 草稿预览，不能判定回读'] };
    const match = judgeReadings(event.readings, approved);
    return match.ok ? { ok: true } : { ok: false, reasons: match.reasons };
  };
}
