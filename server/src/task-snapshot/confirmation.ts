import { DETAIL_CHANGED_NOTICE, PROJECT_CHANGED_NOTICE, REVIEW_INVALIDATED_NOTICE, type Confirmation, type Line } from '@baox/contract';
import { confirmationStatus, type ConfirmationDigest, type ConfirmationFact } from '../confirmation';

// The snapshot's `confirmation` section (整单明细确认, whole-list detail confirmation, #189): the derived status
// (`confirmation.ts`), the notice naming which half of the digest moved, and the counts of what was confirmed.

const cents = (amount: string) => Math.round(Number(amount) * 100);

export function confirmationView(current: ConfirmationDigest | null, latest: ConfirmationFact | null, lastReopenRevision: number | null, lines: readonly Line[]): Confirmation {
  const status = confirmationStatus(current, latest, lastReopenRevision);
  const counted = current !== null && lines.length > 0;
  let notice: string | null = null;
  if (status === 'invalidated' && latest) {
    if (!current) notice = REVIEW_INVALIDATED_NOTICE;
    else notice = current.detail === latest.detail ? PROJECT_CHANGED_NOTICE : DETAIL_CHANGED_NOTICE;
  }
  return {
    status,
    confirmedAt: status === 'confirmed' ? (latest?.confirmedAt ?? null) : null,
    digest: current?.digest ?? null,
    lineCount: counted ? lines.length : 0,
    invoiceCount: counted ? new Set(lines.map((line) => line.voucherMaterialId)).size : 0,
    grossTotal: counted ? (lines.reduce((sum, line) => sum + cents(line.grossAmount), 0) / 100).toFixed(2) : null,
    notice,
  };
}
