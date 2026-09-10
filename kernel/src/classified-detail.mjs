import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { taskDir } from './workspace.mjs';
import { writeJsonAtomic } from './paths.mjs';
import { validHomeCity } from './home-city.mjs';
import { FIELD_LABELS, FIELD_RULES, loadReading } from './vision.mjs';

const confirmationFile = (task) => path.join(taskDir(task), 'classified-detail-confirmation.json');

const identityOf = (identity) => identity?.account && identity?.tenant
  ? { account: identity.account, tenant: identity.tenant } : null;

const sameIdentity = (left, right) => !!left && !!right
  && left.account === right.account && left.tenant === right.tenant;

const validDate = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime())
    && date.toISOString().slice(0, 10) === value;
};

const hotelDatesValid = (line) => {
  // 票种不能决定费用类别：普通 VAT 交通发票和住宿发票都可能是
  // `vat_common`。离店日期只属于已经由酒店结账单证据推导为住宿的明细。
  if (line?.category !== 'accommodation' && line?.categoryLabel !== '住宿') return true;
  const start = line?.date;
  const end = line?.endDate ?? line?.checkOut;
  if (!validDate(start) || !validDate(end)) return false;
  return end >= start;
};

const sorted = (value) => {
  if (Array.isArray(value)) return value.map(sorted);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])]));
};

const lineFacts = (line) => ({
  lineId: line.lineId ?? null,
  eventId: line.eventId ?? null,
  voucherMaterialId: line.voucherMaterialId ?? null,
  maskedNumber: line.maskedNumber ?? null,
  kind: line.kind ?? null,
  date: line.date ?? null,
  checkOut: line.checkOut ?? line.endDate ?? null,
  endDate: line.endDate ?? line.checkOut ?? null,
  city: line.city ?? null,
  route: line.route ?? null,
  netAmount: line.netAmount ?? null,
  taxAmount: line.taxAmount ?? null,
  totalAmount: line.totalAmount ?? null,
  amountSource: line.amountSource ?? null,
  referenceMaterialIds: line.referenceMaterialIds ?? [],
  category: line.category ?? null,
  categoryLabel: line.categoryLabel ?? null,
  categoryBasis: line.categoryBasis ?? null,
  expenseItemCode: line.expenseItemCode ?? null,
  expenseItemName: line.expenseItemName ?? null,
});

const evidenceFacts = (evidence) => (evidence ?? []).map((item) => ({
  materialId: item.materialId ?? null,
  contentHash: item.contentHash ?? null,
  role: item.role ?? null,
  kind: item.kind ?? null,
  parseStatus: item.parseStatus ?? null,
  documentType: item.documentType ?? null,
  source: item.source ?? null,
  markdownHash: item.markdownHash ?? item.candidateSources?.markdownHash ?? item.source?.markdownHash ?? null,
  fields: item.fields ?? null,
  candidates: item.candidates ?? null,
  segments: item.segments ?? null,
  fieldEvidence: item.fieldEvidence ?? null,
  fieldStatus: item.fieldStatus ?? null,
  candidateSources: item.candidateSources ?? null,
  unreadable: item.unreadable ?? [],
  issues: item.issues ?? [],
}));

/**
 * 分类确认只绑定材料和费用事实。项目、项目来源、事由故意不进摘要：换项目不要求
 * 用户重新确认已经看过的材料明细。
 */
export function classifiedDetailDigest(preview = {}) {
  const shape = sorted({
    versionId: preview.versionId ?? null,
    homeCity: preview.homeCity ?? null,
    lines: (preview.lines ?? []).map(lineFacts),
    evidence: evidenceFacts(preview.evidence),
  });
  return crypto.createHash('sha256').update(JSON.stringify(shape), 'utf8').digest('hex');
}

export function classifiedDetailComplete(preview = {}) {
  const lines = Array.isArray(preview.lines) ? preview.lines : [];
  return validHomeCity(preview.homeCity)
    && lines.length > 0
    && lines.every((line) => line && line.date && line.category && line.expenseItemCode
      && line.totalAmount && line.voucherMaterialId && hotelDatesValid(line));
}

export function classifiedDetailConfirmed(task, preview, identity = task?.identity) {
  if (!task?.taskId || !classifiedDetailComplete(preview)) return false;
  const currentIdentity = identityOf(identity);
  if (!sameIdentity(task.identity, currentIdentity)) return false;
  try {
    const record = JSON.parse(fs.readFileSync(confirmationFile(task), 'utf8'));
    return record.taskId === task.taskId
      && sameIdentity(record.identity, currentIdentity)
      && record.digest === classifiedDetailDigest(preview);
  } catch {
    return false;
  }
}

export function confirmClassifiedDetail(task, preview, identity = task?.identity) {
  if (!task?.taskId || !classifiedDetailComplete(preview)) return null;
  const currentIdentity = identityOf(identity);
  if (!sameIdentity(task.identity, currentIdentity)) return null;
  const record = {
    taskId: task.taskId,
    identity: currentIdentity,
    versionId: preview.versionId ?? null,
    digest: classifiedDetailDigest(preview),
    confirmedAt: new Date().toISOString(),
  };
  writeJsonAtomic(confirmationFile(task), record);
  return record;
}

/**
 * Vision readings enter the existing dispute flow. Markdown candidates use a separate
 * same-hash re-extraction request: user input never becomes a PDF fact and never
 * pretends to be a second vision reading.
 */
export function classifiedCorrectionOptions(task, preview = {}) {
  return (preview.evidence ?? []).map((item) => {
    if (item.source === 'agent_from_markdown'
      || item.candidateSources?.source === 'agent_from_markdown') {
      const fields = Object.entries(item.candidateSources?.fieldStatus ?? {})
        .filter(([, status]) => ['explicit', 'derived', 'ambiguous'].includes(status))
        .map(([field]) => field);
      return {
        materialId: item.materialId,
        fields,
        labels: fields.map((key) => FIELD_LABELS[key] ?? key),
        action: 'reextract_same_hash',
        markdownHash: item.markdownHash ?? item.candidateSources?.markdownHash ?? null,
        reextractPath: item.paths?.reextractPath ?? null,
        reason: null,
      };
    }
    const reading = loadReading(task, item.materialId);
    if (!reading || reading.contentHash !== item.contentHash) {
      return { materialId: item.materialId, fields: [], labels: [],
        reason: `材料 ${item.materialId} 当前没有与本版 hash 匹配的看图读数；请替换原材料后重新解析` };
    }
    const fields = Object.keys(reading.fields ?? {}).filter((key) => key in FIELD_RULES);
    if (!fields.length) {
      return { materialId: item.materialId, fields: [], labels: [],
        reason: `材料 ${item.materialId} 的看图读数没有可纠正字段；请替换原材料后重新解析` };
    }
    return { materialId: item.materialId, fields, labels: fields.map((key) => FIELD_LABELS[key] ?? key),
      reason: null };
  });
}

export { confirmationFile };
