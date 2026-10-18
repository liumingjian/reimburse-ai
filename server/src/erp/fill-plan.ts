// From a confirmed task to one fill job (#191): the preflight that needs no ERP, the fill plan the executor runs, and
// the judge's inputs, all frozen when the job starts (`erp_job.plan`). The judge keeps the kernel shapes
// (`judge.ts`, `preview.ts`); this module is the only place that maps the app's lines onto them.
//
// The ERP account and 账套 (account set) that the executor probes become the preview identity. It is recorded, never
// compared with the app account (ADR-0016): the judge only needs one identity to scope the preview.

import { createHash } from 'node:crypto';
import type { Line, MaterialKind } from '@baox/contract';
import type { Claim } from '../inventory-view';
import type { ErpConfig } from './config';
import { isSafeKey } from '@baox/erp-executor/catalog';
import { validInvoiceTypeSource, writableInvoiceType } from '@baox/erp-executor/invoice-type';
import type { ErpJudge } from './jobs';
import { createDraftJudge, type DraftJudgeInputs } from './judge';
import { previewLinesDigest } from './preview';
import { PROTOCOL_VERSION, type ApprovedPreview, type FillPlan, type Identity, type ReadbackVerdict } from '@baox/erp-executor/protocol';
import type { ReadbackInvoice } from './readback';

// The confirmed line already carries its ERP 发票类型 and its evidence. This module must never remap a face kind or
// choose a fallback while freezing the job.

const INVOICE_KEY = /^einvoice-20:(\d{20})$/;

export type PlanMaterial = { materialId: string; kind: MaterialKind | null; fileName: string; sha256: string; mime: string };

export type FillPlanInput = {
  taskId: string;
  jobId: string;
  versionId: string;
  homeCity: string;
  purpose: string | null;
  // The confirmed line set: `snapshot.lines` while the confirmation is `confirmed` (#189).
  lines: readonly Line[];
  materials: readonly PlanMaterial[];
  // Invoice identities of the inventory (`einvoice-20:<n>`), the same keys 发票占用 uses.
  claims: readonly Claim[];
  config: ErpConfig;
};

type CatalogEntry = { code: string; name: string };

// A line in the kernel shape the preview builder reads.
export type KernelLine = {
  lineId: string; eventId: string; voucherMaterialId: string; kind: string;
  date: string; endDate: string | null; city: string | null; route: string | null; origin: string | null; destination: string | null; routeSource: string | null;
  netAmount: string | null; taxAmount: string | null; totalAmount: string; netAmountSource: string | null; taxAmountSource: string | null;
  category: string; categoryLabel: string;
  projectCode: string; projectName: string; expenseItemCode: string; expenseItemName: string; expenseItemSource: string;
  invoiceType: string; invoiceTypeSource: string; maskedNumber: string | null; referenceMaterialIds: string[];
};

export type JudgeBase = {
  taskId: string; versionId: string; homeCity: string; purpose: string;
  lines: KernelLine[]; events: Array<{ eventId: string; voucherMaterialId: string; kind: string; category: string }>;
  projects: CatalogEntry[]; expenseItems: CatalogEntry[]; invoices: ReadbackInvoice[];
};

// What `erp_job.plan` stores. `rerunOf` is an 自动重新去报销's cause (ADR-0034): the job whose unknown result it
// starts over from, that result's code, and which re-run in a row this is.
export type FrozenJob = { plan: FillPlan; judge: JudgeBase; rerunOf?: { jobId: string; code: string | null; no: number } };

/** baox's ownership marker for a job (ADR-0029): one per job, the same on every send, unguessable as its job id is. */
export const draftMarkOf = (jobId: string) => `baox-${createHash('sha256').update(`baox-draft:${jobId}`).digest('hex').slice(0, 10)}`;

/**
 * The plan as one job runs it: its id, and the ownership marker it 暂存s under, derived from that id. Every fill 暂存s
 * (ADR-0037), whichever executor runs it.
 */
export const planOfJob = (plan: FillPlan, jobId: string): FillPlan => ({ ...plan, jobId, draft: { mark: draftMarkOf(jobId) } });

const cents = (amount: string) => {
  const [whole = '0', fraction = ''] = amount.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
};

const distinct = (entries: CatalogEntry[]) => [...new Map(entries.map((entry) => [`${entry.code}\u0000${entry.name}`, entry])).values()];

// Kernel line kinds that change the preview rules: a rail e-ticket takes net/tax from the ERP receipt, a passenger
// transport line must carry a structured route.
const kernelKind = (line: Line, material: PlanMaterial | undefined) =>
  material?.kind === 'rail_ticket' ? 'rail_eticket' : line.origin && line.destination ? 'passenger_transport' : (material?.kind ?? 'invoice');

/**
 * Preflight, then the frozen job. The preflight repeats the preview rules that need no ERP, so a line the fill could
 * never write is refused before the first attempt instead of ending as ERP 写入结果未知 after the import.
 */
export function buildFillJob(input: FillPlanInput): { ok: true; job: FrozenJob } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const purpose = input.purpose?.trim() ?? '';
  if (!purpose) problems.push('缺少报销事由');
  if (input.lines.length === 0) problems.push('没有已确认的明细');
  const materials = new Map(input.materials.map((material) => [material.materialId, material]));
  const invoiceNumber = new Map<string, string>();
  for (const claim of input.claims) {
    const match = INVOICE_KEY.exec(claim.key);
    if (match?.[1]) invoiceNumber.set(claim.materialId, match[1]);
  }

  const vouchers: string[] = [];
  for (const line of input.lines) {
    const label = `明细 No.${line.no}`;
    const rail = materials.get(line.voucherMaterialId)?.kind === 'rail_ticket';
    if (!line.projectCode || !line.projectName) problems.push(`${label} 还没有项目`);
    if (!line.expenseItemCode || !line.expenseItemName) problems.push(`${label} 的费用分类「${line.category.label}」没有对应的报销系统费用项目`);
    if (line.category.code === 'accommodation' && !line.endDate) problems.push(`${label} 是住宿，缺少离店日期`);
    if (!rail && cents(line.netAmount) + cents(line.taxAmount) !== cents(line.grossAmount)) problems.push(`${label} 的不含税金额与税额加起来不等于价税合计`);
    if (!writableInvoiceType(line.invoiceType) || !validInvoiceTypeSource(line.invoiceTypeSource)) problems.push(`${label} 缺少已确认的报销系统发票类型`);
    for (const code of [line.projectCode, line.expenseItemCode]) if (code && !isSafeKey(code)) problems.push(`${label} 的编码 ${code} 含有不能安全查询的字符`);
    if (!vouchers.includes(line.voucherMaterialId)) vouchers.push(line.voucherMaterialId);
  }
  for (const materialId of vouchers) {
    const label = input.lines.find((line) => line.voucherMaterialId === materialId)?.invoiceLabel ?? '发票';
    const material = materials.get(materialId);
    if (!material) problems.push(`${label} 的原件不在这次材料里`);
    else if (!invoiceNumber.has(materialId)) problems.push(`${label}（${material.fileName}）没有 20 位全电发票号码，报销系统的发票助手不能导入它`);
  }
  if (problems.length > 0) return { ok: false, problems: [...new Set(problems)] };

  const lines: KernelLine[] = input.lines.map((line) => {
    const kind = kernelKind(line, materials.get(line.voucherMaterialId));
    const rail = kind === 'rail_eticket';
    return {
      lineId: line.lineId,
      eventId: line.eventId ?? `event.${line.lineId}`,
      voucherMaterialId: line.voucherMaterialId,
      kind,
      date: line.date,
      endDate: line.endDate,
      city: line.city,
      route: line.route,
      origin: line.origin,
      destination: line.destination,
      routeSource: line.origin && line.destination ? 'confirmed_candidate' : null,
      // A rail e-ticket states only the fare; its net and tax come from ERP's receipt (kernel rule), never a 0 tax.
      netAmount: rail ? null : line.netAmount,
      taxAmount: rail ? null : line.taxAmount,
      totalAmount: line.grossAmount,
      netAmountSource: rail ? null : 'invoice_face',
      taxAmountSource: rail ? null : 'invoice_face',
      category: line.category.code,
      categoryLabel: line.category.label,
      projectCode: line.projectCode!,
      projectName: line.projectName!,
      expenseItemCode: line.expenseItemCode!,
      expenseItemName: line.expenseItemName!,
      expenseItemSource: 'company_rules',
      invoiceType: line.invoiceType,
      invoiceTypeSource: line.invoiceTypeSource,
      maskedNumber: line.maskedNumber,
      referenceMaterialIds: [...line.referenceMaterialIds],
    };
  });
  const events = [...new Map(lines.map((line) => [line.eventId, { eventId: line.eventId, voucherMaterialId: line.voucherMaterialId, kind: line.kind, category: line.category }])).values()];
  const projects = distinct(lines.map((line) => ({ code: line.projectCode, name: line.projectName })));
  const expenseItems = distinct(lines.map((line) => ({ code: line.expenseItemCode, name: line.expenseItemName })));

  const plan: FillPlan = {
    protocolVersion: PROTOCOL_VERSION,
    kind: 'fill',
    jobId: input.jobId,
    draft: { mark: draftMarkOf(input.jobId) },
    taskId: input.taskId,
    erpOrigin: input.config.origin,
    compatibility: input.config.compatibility,
    catalog: { projects, expenseItems },
    invoices: vouchers.map((materialId) => {
      const material = materials.get(materialId)!;
      return { sha256: material.sha256, fileName: material.fileName, mime: material.mime };
    }),
    purpose,
  };
  const invoices: ReadbackInvoice[] = vouchers.map((materialId) => {
    const number = invoiceNumber.get(materialId)!;
    return { materialId, identity: { key: `einvoice-20:${number}`, number } };
  });
  return { ok: true, job: { plan, judge: { taskId: input.taskId, versionId: input.versionId, homeCity: input.homeCity, purpose, lines, events, projects, expenseItems, invoices } } };
}

/**
 * The kernel-shaped judge inputs. Projects and expense items are `confirmed` because the executor's 报销信息核对
 * runs before import and aborts on any mismatch (ADR-0014: the catalog check lives in the ERP job).
 */
export function judgeInputs(base: JudgeBase, identity: Identity | null): DraftJudgeInputs {
  const built = { versionId: base.versionId, events: base.events, lineItems: base.lines };
  const linesDigest = previewLinesDigest(built);
  const confirmed = (entries: CatalogEntry[]) => Object.fromEntries(entries.map((entry) => [entry.code, { ...entry, verdict: 'confirmed' }]));
  return {
    task: { taskId: base.taskId, currentVersionId: base.versionId, identity, homeCity: base.homeCity },
    built,
    lines: base.lines.map((line) => ({ ...line, projectSource: 'erp_catalog_confirmed', projectsFrom: 'project_book' })),
    selection: {
      versionId: base.versionId, linesDigest, identity, homeCity: base.homeCity, purpose: base.purpose,
      projects: Object.fromEntries(base.lines.map((line) => [line.lineId, line.projectCode])),
      projectSource: 'erp_catalog_confirmed', projectsFrom: 'project_book',
    },
    catalog: { versionId: base.versionId, linesDigest, identity, projects: confirmed(base.projects) },
    expenseItems: confirmed(base.expenseItems),
    invoices: base.invoices,
  };
}

// An empty 收票单号 on every detail row used to be annotated here, because it failed the read-back and the
// annotation was the only way a live run showed the cause. The read-back no longer asks for that link
// (`readback.ts`), so there is nothing to annotate: the reasons a run stops on are now about the money.

/** The server's judge for one fill job: the draft judge over the frozen inputs, scoped to the probed ERP account. */
export function taskJudge(base: JudgeBase, { onApproved }: { onApproved?: (preview: ApprovedPreview) => Promise<void> } = {}): ErpJudge {
  let inner: ErpJudge | null = null;
  return async (event, context) => {
    const account = context.erpAccount;
    inner ??= createDraftJudge(judgeInputs(base, account ? { account: account.account, tenant: account.tenant } : null));
    const verdict: ReadbackVerdict = await inner(event, context);
    if (verdict.ok && verdict.preview && onApproved) await onApproved(verdict.preview);
    return verdict;
  };
}
