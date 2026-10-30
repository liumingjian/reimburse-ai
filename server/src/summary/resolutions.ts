import { SummaryResolutionSchema, type Line, type SummaryInput, type SummaryResolution } from '@baox/contract';
import type { Db } from '../db/database';

export async function loadResolutions(db: Db, taskId: string, confirmationRevision: number): Promise<SummaryResolution> {
  const row = await db.selectFrom('summary_resolution').select('data').where('task_id', '=', taskId).where('confirmation_revision', '=', confirmationRevision).orderBy('revision', 'desc').executeTakeFirst();
  return row ? SummaryResolutionSchema.parse(JSON.parse(row.data)) : { confirmationRevision, voucherCounts: [], stayDays: [] };
}

export function summaryInputs(lines: readonly Line[], choices: SummaryResolution): SummaryInput[] {
  const inputs: SummaryInput[] = [];
  const vouchers = new Map<string, [Line, ...Line[]]>();
  for (const line of lines) {
    const group = vouchers.get(line.voucherMaterialId);
    if (group) group.push(line);
    else vouchers.set(line.voucherMaterialId, [line]);
    if (line.category.label === '住宿' && line.endDate === line.date && !choices.stayDays.some(choice => choice.lineId === line.lineId)) inputs.push({ kind: 'stay-days', lineId: line.lineId, label: line.invoiceLabel, date: line.date });
  }
  for (const [id, group] of vouchers) {
    const categories = [...new Set(group.map(line => line.category.label))];
    if (categories.length > 1 && !choices.voucherCounts.some(choice => choice.voucherMaterialId === id && categories.includes(choice.category))) inputs.push({ kind: 'voucher-count', voucherMaterialId: id, label: group[0].invoiceLabel, categories });
  }
  return inputs;
}
