import { EmployeeProfileViewSchema, SummaryDataSchema, type Line, type ReimbursementSummary } from '@baox/contract';
import type { Db } from '../db/database';
import { summaryReasons } from './data';
import { loadResolutions, summaryInputs } from './resolutions';

export async function loadSummary(db: Db, taskId: string, accountId: string, confirmation: string, confirmedRevision: number | null, lines: readonly Line[]): Promise<ReimbursementSummary> {
  if (confirmation !== 'confirmed') return { status: 'unavailable', reasons: ['请先完成整单明细确认。'] };
  const choices = await loadResolutions(db, taskId, confirmedRevision ?? 0);
  const reasons = summaryReasons(lines, choices);
  if (reasons.length) return { status: 'unavailable', reasons, confirmationRevision: confirmedRevision ?? 0, inputs: summaryInputs(lines, choices) };
  const stored = await db.selectFrom('reimbursement_summary').selectAll().where('task_id', '=', taskId).where('account_id', '=', accountId).orderBy('revision', 'desc').executeTakeFirst();
  if (!stored || stored.confirmation_revision !== confirmedRevision) return { status: 'ready' };
  const resolution = await db.selectFrom('summary_resolution').select('revision').where('task_id', '=', taskId).where('confirmation_revision', '=', confirmedRevision ?? 0).orderBy('revision', 'desc').executeTakeFirst();
  if (resolution && resolution.revision > stored.revision) return { status: 'ready' };
  const data = SummaryDataSchema.parse(JSON.parse(stored.data));
  const credential = await db.selectFrom('erp_credential').select(['employee_profile', 'erp_account']).where('account_id', '=', accountId).executeTakeFirst();
  const profile = EmployeeProfileViewSchema.parse(credential?.employee_profile ? JSON.parse(credential.employee_profile) : { status: 'missing' });
  if (profile.status !== 'ready' || profile.erpAccount !== credential?.erp_account || profile.erpAccount !== data.employeeIdentity.erpAccount || profile.tenant !== data.employeeIdentity.tenant || profile.name !== data.name || profile.department !== data.department) return { status: 'ready' };
  return { status: 'generated', data, url: `/api/tasks/${taskId}/reimbursement-summary/${stored.summary_id}`, previewUrl: `/api/tasks/${taskId}/reimbursement-summary/${stored.summary_id}/preview`, fileName: '报销汇总表.xlsx' };
}
