import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { taskDir } from './workspace.mjs';

// Preparation is the boundary between local fact collection and ERP work.  This
// module deliberately has no browser or ERP imports: its output is a portable,
// immutable handoff bundle and its first result may be an incomplete draft.

export const PREPARATION_SCHEMA_VERSION = 1;
export const PREPARATION_PHASE = 'pre-erp';

const SUPPORTED_FORMATS = new Set(['pdf', 'png', 'jpg']);
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const HASH_RE = /^[a-f0-9]{64}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const ERP_INVOICE_TYPES = new Set(['普通发票', '增值税发票']);
const ORDINARY_INVOICE_TYPE_SOURCE = 'save-contract:invoice-type-ordinary';
const TRUSTED_INVOICE_TYPE_SOURCES = new Set([
  'save-contract:vat_special',
  ORDINARY_INVOICE_TYPE_SOURCE,
]);
const TRUSTED_INVOICE_TYPE_BY_KIND = new Map([
  ['save-contract:vat_special', { kind: 'vat_special', value: '增值税发票' }],
  [ORDINARY_INVOICE_TYPE_SOURCE, { kind: null, value: '普通发票' }],
]);

const text = (value) => typeof value === 'string' && value.trim() && !CONTROL_RE.test(value)
  ? value.trim() : null;

const own = (value, key) => Object.prototype.hasOwnProperty.call(value ?? {}, key);

function portable(value, key = '') {
  if (value === undefined) return null;
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    // Absolute paths are process-local and make a handoff package non-portable.
    return path.isAbsolute(value) ? '<absolute-path-omitted>' : value;
  }
  if (Array.isArray(value)) return value.map((item) => portable(item, key));
  if (typeof value !== 'object') return String(value);
  const result = {};
  for (const name of Object.keys(value).sort()) {
    const child = value[name];
    if (/^(?:path|root|sourcePages|pagesDir|artifactPath|markdownPath|numberedMarkdownPath|templatePath|candidatePath|candidateRecordPath|reextractPath)$/i.test(name)) {
      continue;
    }
    result[name] = portable(child, name);
  }
  return result;
}

function stableValue(value) {
  return JSON.stringify(portable(value));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function digestValue(value) {
  return sha256(stableValue(value));
}

function issue(problems, code, message, details = {}, blocking = true) {
  problems.push({ code, message, blocking, ...portable(details) });
}

function identityOf(value) {
  const account = text(value?.account);
  const tenant = text(value?.tenant);
  return account && tenant ? { account, tenant } : null;
}

function sameIdentity(left, right) {
  return !!left && !!right && left.account === right.account && left.tenant === right.tenant;
}

function validDate(value) {
  const match = DATE_RE.exec(text(value) ?? '');
  if (!match) return false;
  const [, year, month, day] = match.map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function dateValue(value) {
  return validDate(value) ? text(value) : null;
}

function centsFrom(value, assumeCents = false) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'object' && own(value, 'cents')) return centsFrom(value.cents, true);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    if (!Number.isSafeInteger(value)) return null;
    return assumeCents ? value : Math.round(value * 100);
  }
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/[¥￥,\s]/g, '');
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(normalized)) return null;
  const number = Number(normalized);
  if (!Number.isFinite(number)) return null;
  const result = Math.round(number * 100);
  return Number.isSafeInteger(result) ? result : null;
}

function amountText(cents) {
  return cents === null || cents === undefined ? null : (cents / 100).toFixed(2);
}

function validCents(value) {
  return Number.isSafeInteger(value) && Number.isFinite(value) && value >= 0;
}

function relativePath(value, label = 'relative path') {
  if (typeof value !== 'string' || !value.trim() || CONTROL_RE.test(value)) {
    throw new TypeError(`${label} must be non-empty text`);
  }
  const rel = value.trim().replaceAll('\\', '/');
  const normalized = path.posix.normalize(rel);
  if (normalized === '.' || normalized.startsWith('../') || normalized.startsWith('/')
    || /^[A-Za-z]:\//.test(normalized) || normalized !== rel) {
    throw new TypeError(`${label} must stay inside the material root: ${value}`);
  }
  return normalized;
}

function formatOf(material) {
  const raw = text(material?.format)?.toLowerCase().replace('jpeg', 'jpg');
  return SUPPORTED_FORMATS.has(raw) ? raw : null;
}

function sourceMappingPath(role, material) {
  const format = formatOf(material);
  return `${role === 'primary_voucher' ? 'invoices' : 'evidence'}/${material.materialId}.${format ?? 'bin'}`;
}

function sourceRelPathOf(material) {
  try { return relativePath(material?.relPath, 'source relative path'); } catch { return null; }
}

function recordMap(value) {
  if (Array.isArray(value)) {
    return new Map(value.map((record) => [
      text(record?.code ?? record?.number ?? record?.projectCode ?? record?.expenseItemCode),
      record,
    ]).filter(([key]) => key));
  }
  if (value && typeof value === 'object') {
    return new Map(Object.entries(value).map(([key, record]) => [key, record]));
  }
  return new Map();
}

function recordOf(container, code, keys = []) {
  const sources = [container, ...(keys.map((key) => container?.[key]))];
  for (const source of sources) {
    const hit = recordMap(source).get(code);
    if (hit) return { ...hit, code: text(hit.code ?? hit.number ?? code) ?? code };
  }
  return null;
}

function recordName(record) {
  return text(record?.name ?? record?.erpName ?? record?.projectName);
}

function confirmedRecord(record) {
  return !!record && (record.verdict === 'confirmed' || record.status === 'confirmed'
    || record.confirmed === true);
}

function lineDigestBasis(lines) {
  return lines.map((line) => [
    text(line?.lineId),
    text(line?.voucherMaterialId),
    text(line?.date),
    text(line?.endDate ?? line?.checkOut),
    text(line?.city),
    text(line?.totalAmount),
  ].join('|'));
}

function lineDigest(lines) {
  return sha256(JSON.stringify(lineDigestBasis(lines))).slice(0, 32);
}

function sourceValue(line, event, field, fallback = null) {
  return text(line?.fieldSources?.[field])
    ?? text(event?.fieldSources?.[field])
    ?? text(line?.[`${field}Source`])
    ?? text(event?.[`${field}Source`])
    ?? fallback;
}

function fieldEvidenceOf(result, field) {
  const sources = result?.candidateSources?.fieldEvidence?.[field]
    ?? result?.fieldEvidence?.[field]
    ?? result?.evidence?.[field]
    ?? null;
  return portable(sources);
}

function fieldSourceOf(result, field) {
  return text(result?.fieldSources?.[field])
    ?? text(result?.candidateSources?.fieldSources?.[field])
    ?? (fieldEvidenceOf(result, field) ? 'material_evidence' : null);
}

function candidateFieldValue(result, field) {
  if (own(result?.fields, field)) return result.fields[field];
  const candidate = (result?.candidates ?? []).find((item) => item?.field === field);
  return candidate?.value ?? null;
}

function candidateSegmentOf(result, index) {
  const candidate = (result?.candidates ?? []).find((item) => item?.field === 'segments');
  const segments = Array.isArray(candidate?.value) ? candidate.value : result?.segments;
  return (segments ?? []).find((segment) => Number(segment?.index) === Number(index)) ?? null;
}

function candidateSegmentEvidenceKeyOf(result, index, field) {
  const segment = (result?.candidateSources?.segments ?? [])
    .find((item) => Number(item?.index) === Number(index));
  const aliases = field === 'date' ? ['date', 'travelDate']
    : field === 'checkIn' ? ['checkIn']
      : field === 'checkOut' ? ['checkOut'] : [field];
  return aliases.find((name) => segment?.fieldEvidence?.[name]) ?? null;
}

function candidateSourceOf(result, field, index = null) {
  const materialId = text(result?.materialId);
  if (!materialId) return null;
  if (index !== null && index !== undefined) {
    const segment = candidateSegmentOf(result, index);
    const aliases = field === 'date' ? ['date', 'travelDate']
      : field === 'checkIn' ? ['checkIn']
        : field === 'checkOut' ? ['checkOut'] : [field];
    const evidenceName = candidateSegmentEvidenceKeyOf(result, index, field);
    if (evidenceName) {
      return `material:${materialId}:candidateSources.segments[${index}].fieldEvidence.${evidenceName}`;
    }
    const valueName = aliases.find((name) => segment && own(segment, name));
    if (valueName) {
      return `material:${materialId}:candidates.segments[${index}].${valueName}`;
    }
    return null;
  }
  if (fieldEvidenceOf(result, field)) return `material:${materialId}:fieldEvidence.${field}`;
  if (own(result?.fields, field)
    && result.fields[field] !== null && result.fields[field] !== undefined) {
    return `material:${materialId}:fields.${field}`;
  }
  if ((result?.candidates ?? []).some((item) => item?.field === field
    && item?.value !== null && item?.value !== undefined)) {
    return `material:${materialId}:candidates.${field}`;
  }
  return fieldSourceOf(result, field) ? `material:${materialId}:fields.${field}` : null;
}

function candidateSegmentValueOf(result, field, index) {
  const segment = candidateSegmentOf(result, index);
  if (segment && own(segment, field)) return segment[field];
  const aliases = field === 'date' ? ['travelDate'] : [];
  for (const alias of aliases) {
    if (segment && own(segment, alias)) return segment[alias];
  }
  return null;
}

function referenceProjection(references, event) {
  const index = Number.isSafeInteger(event?.index) ? event.index : 1;
  const projected = {};
  for (const reference of references) {
    const isRide = reference?.kind === 'ride_itinerary';
    const segmentCandidate = (reference?.candidates ?? [])
      .find((item) => item?.field === 'segments');
    const hasRideSegments = isRide && (Array.isArray(reference?.segments)
      || Array.isArray(segmentCandidate?.value));
    const fields = isRide
      ? { date: 'date', city: 'city', origin: 'origin', destination: 'destination', route: 'route' }
      : reference?.kind === 'hotel_folio'
        ? { date: 'checkIn', endDate: 'checkOut', city: 'city' }
        : {};
    for (const [target, sourceField] of Object.entries(fields)) {
      if (projected[target]?.value !== undefined && projected[target]?.value !== null) continue;
      const flatField = sourceField === 'date' ? 'travelDate' : sourceField;
      const value = hasRideSegments
        ? candidateSegmentValueOf(reference, sourceField, index)
        : candidateFieldValue(reference, isRide ? flatField : sourceField);
      const normalized = target === 'date' || target === 'endDate' ? dateValue(value) : text(value);
      if (normalized === null || normalized === undefined) continue;
      const source = hasRideSegments
        ? candidateSourceOf(reference, sourceField, index)
        : candidateSourceOf(reference, isRide ? flatField : sourceField);
      projected[target] = { value: normalized, source };
    }
  }
  if (!projected.route?.value && projected.origin?.value && projected.destination?.value) {
    projected.route = {
      value: `${projected.origin.value} → ${projected.destination.value}`,
      source: projected.origin.source && projected.destination.source
        ? `${projected.origin.source}+${projected.destination.source}` : null,
    };
  }
  return projected;
}

function railProjection(voucher) {
  const origin = text(voucher?.fields?.railFrom);
  const destination = text(voucher?.fields?.railTo);
  const originSource = candidateSourceOf(voucher, 'railFrom');
  const destinationSource = candidateSourceOf(voucher, 'railTo');
  return {
    origin: origin ? { value: origin, source: originSource } : null,
    destination: destination ? { value: destination, source: destinationSource } : null,
    route: origin && destination ? {
      value: `${origin} → ${destination}`,
      source: originSource && destinationSource ? `${originSource}+${destinationSource}` : null,
    } : null,
  };
}

function identityFor(result) {
  const identity = result?.identity;
  if (identity?.scheme && identity?.key) return portable(identity);
  const code = text(identity?.code ?? result?.fields?.invoiceCode);
  const number = text(identity?.number ?? result?.fields?.invoiceNumber);
  if (/^(?:\d{10}|\d{12})$/.test(code ?? '') && /^\d{8}$/.test(number ?? '')) {
    return { scheme: 'vat-legacy', key: `vat-legacy:${code}:${number}`, code, number };
  }
  if (/^\d{20}$/.test(number ?? '')) {
    return { scheme: 'einvoice-20', key: `einvoice-20:${number}`, number };
  }
  return null;
}

function identityIsNative(identity) {
  if (!identity || !text(identity.key) || !text(identity.scheme)) return false;
  if (identity.scheme === 'vat-legacy') {
    return /^(?:\d{10}|\d{12})$/.test(identity.code ?? '')
      && /^\d{8}$/.test(identity.number ?? '')
      && identity.key === `vat-legacy:${identity.code}:${identity.number}`;
  }
  if (identity.scheme === 'einvoice-20') {
    return /^\d{20}$/.test(identity.number ?? '')
      && identity.key === `einvoice-20:${identity.number}`;
  }
  return false;
}

function invoiceTypeFor(result, line, event, problems, at) {
  const provided = text(line?.invoiceType ?? line?.invoiceTypeLabel
    ?? event?.invoiceType ?? event?.invoiceTypeLabel);
  const providedSource = text(line?.invoiceTypeSource ?? event?.invoiceTypeSource);
  const trustedMapping = TRUSTED_INVOICE_TYPE_BY_KIND.get(providedSource);
  if (provided && ERP_INVOICE_TYPES.has(provided)
    && TRUSTED_INVOICE_TYPE_SOURCES.has(providedSource)
    && trustedMapping?.value === provided
    && (!trustedMapping.kind || trustedMapping.kind === result?.kind)) {
    return { value: provided, source: providedSource, basis: 'provided_confirmed_mapping' };
  }
  if (provided || providedSource) {
    issue(problems, 'invoice_type_source_untrusted',
      `凭证 ${at.materialId} 的 ERP 发票类型出处不在可信映射白名单中`, at);
  }

  // Expense categories (local/remote transport, long-distance transport, and
  // accommodation) are not ERP invoice types.  Only a positively identified
  // VAT invoice gets the VAT type; all other recognized documents use the
  // ordinary invoice type.
  if (result?.kind === 'rail_eticket') {
    return { value: '普通发票', source: ORDINARY_INVOICE_TYPE_SOURCE, basis: 'contract_default' };
  }
  if (result?.kind === 'vat_special') {
    return { value: '增值税发票', source: 'save-contract:vat_special', basis: 'recognized_vat' };
  }
  return { value: '普通发票', source: ORDINARY_INVOICE_TYPE_SOURCE, basis: 'contract_default' };
}

function normalizeReceiptFacts(receiptFacts) {
  if (!receiptFacts || typeof receiptFacts !== 'object'
    || receiptFacts.fresh !== true || !Array.isArray(receiptFacts.rows)) return [];
  return receiptFacts.rows.map((row) => ({
    ...portable(row),
    materialId: text(row?.voucherMaterialId),
    contentHash: text(row?.contentHash),
    identityKey: text(row?.identityKey),
    invoiceNumber: text(row?.invoiceNumber),
    receiptNumber: text(row?.receiptNumber),
    source: text(row?.source),
    netCents: centsFrom(row?.netAmount),
    taxCents: centsFrom(row?.taxAmount),
    totalCents: centsFrom(row?.grossAmount),
  })).filter((record) => record.materialId);
}

function materialFacts(material, result, role, targetPath = null) {
  const fields = result?.fields ?? {};
  const amount = (key) => centsFrom(fields[key]);
  return {
    materialId: material?.materialId ?? result?.materialId ?? null,
    role,
    sourceRelPath: sourceRelPathOf(material),
    fileName: material?.fileName ?? result?.fileName ?? null,
    format: formatOf(material) ?? formatOf(result),
    size: Number.isSafeInteger(material?.size) ? material.size : null,
    contentHash: text(material?.contentHash ?? result?.contentHash),
    targetPath,
    kind: result?.kind ?? null,
    kindLabel: result?.kindLabel ?? null,
    identity: identityFor(result),
    fields: {
      invoiceCode: text(fields.invoiceCode),
      invoiceNumber: text(fields.invoiceNumber),
      issueDate: dateValue(fields.issueDate),
      netCents: amount('netAmount'),
      taxCents: amount('taxAmount'),
      totalCents: amount('totalAmount'),
    },
    fieldSources: Object.fromEntries(Object.keys(fields).sort()
      .map((field) => [field, fieldSourceOf(result, field)])),
    fieldEvidence: Object.fromEntries(Object.keys(fields).sort()
      .map((field) => [field, fieldEvidenceOf(result, field)])),
    parseStatus: result?.parseStatus ?? null,
    source: result?.source ?? null,
  };
}

function evidenceFacts(material, result, targetPath = null) {
  const fields = result?.fields ?? {};
  const candidates = Array.isArray(result?.candidates) ? result.candidates : [];
  return {
    materialId: material?.materialId ?? result?.materialId ?? null,
    role: 'reference',
    sourceRelPath: sourceRelPathOf(material),
    fileName: material?.fileName ?? result?.fileName ?? null,
    format: formatOf(material) ?? formatOf(result),
    size: Number.isSafeInteger(material?.size) ? material.size : null,
    contentHash: text(material?.contentHash ?? result?.contentHash),
    targetPath,
    kind: result?.kind ?? null,
    kindLabel: result?.kindLabel ?? null,
    fields: portable(fields),
    candidates: portable(candidates),
    evidence: portable(result?.evidence ?? {}),
    fieldSources: portable(result?.fieldSources ?? result?.candidateSources?.fieldSources ?? {}),
    fieldEvidence: portable(result?.fieldEvidence ?? result?.candidateSources?.fieldEvidence ?? {}),
    source: result?.source ?? null,
  };
}

function selectedProjectCode(line, selection) {
  return text(line?.projectCode ?? line?.project ?? selection?.projects?.[line?.lineId]);
}

function normalizedLine(line, event, voucher, references, selection, catalog, problems) {
  const materialId = text(line?.voucherMaterialId ?? event?.voucherMaterialId);
  const lineId = text(line?.lineId ?? event?.eventId);
  const eventId = text(line?.eventId ?? event?.eventId);
  const kind = text(line?.kind ?? event?.kind ?? voucher?.kind);
  const category = text(line?.category);
  const referenceFacts = referenceProjection(references, event);
  const railFacts = kind === 'rail_eticket' ? railProjection(voucher) : {};
  const date = dateValue(line?.date ?? event?.date ?? referenceFacts.date?.value);
  const checkOut = dateValue(line?.endDate ?? line?.checkOut ?? event?.checkOut
    ?? referenceFacts.endDate?.value);
  let origin = text(line?.origin ?? event?.origin)
    ?? railFacts.origin?.value ?? referenceFacts.origin?.value;
  let destination = text(line?.destination ?? event?.destination)
    ?? railFacts.destination?.value ?? referenceFacts.destination?.value;
  const route = text(line?.route ?? event?.route)
    ?? railFacts.route?.value ?? referenceFacts.route?.value
    ?? (origin && destination ? `${origin} → ${destination}` : null);

  const conflicts = [
    ['date', date, referenceFacts.date?.value],
    ['endDate', checkOut, referenceFacts.endDate?.value],
    ['city', text(line?.city ?? event?.city), referenceFacts.city?.value],
    ['origin', text(line?.origin ?? event?.origin),
      kind === 'rail_eticket' ? railFacts.origin?.value : referenceFacts.origin?.value],
    ['destination', text(line?.destination ?? event?.destination),
      kind === 'rail_eticket' ? railFacts.destination?.value : referenceFacts.destination?.value],
  ];
  for (const [field, supplied, projected] of conflicts) {
    if (supplied && projected && supplied !== projected) {
      issue(problems, 'reference_field_conflict', `明细 ${lineId ?? '?'} 的 ${field} 与参考材料候选不一致`, {
        lineId, eventId, materialId, field, supplied, projected,
      });
    }
  }

  const eventAmounts = event?.amounts ?? {};
  let netCents = centsFrom(eventAmounts.netCents, true);
  let taxCents = centsFrom(eventAmounts.taxCents, true);
  let totalCents = centsFrom(eventAmounts.totalCents, true);
  if (netCents === null) netCents = centsFrom(line?.netCents ?? line?.netAmount, own(line ?? {}, 'netCents'));
  if (taxCents === null) taxCents = centsFrom(line?.taxCents ?? line?.taxAmount, own(line ?? {}, 'taxCents'));
  if (totalCents === null) totalCents = centsFrom(line?.totalCents ?? line?.totalAmount, own(line ?? {}, 'totalCents'));
  let amountSource = text(line?.amountSource ?? event?.amountSource);
  if (kind === 'rail_eticket' && totalCents !== null) {
    netCents = totalCents;
    taxCents = 0;
    amountSource = 'rail_total_tax_zero_rule';
  }

  const projectCode = selectedProjectCode(line, selection);
  const projectRecord = projectCode ? recordOf(catalog, projectCode, ['projects']) : null;
  const projectName = text(line?.projectName) ?? recordName(projectRecord);
  const expenseItemCode = text(line?.expenseItemCode);
  const expenseRecord = expenseItemCode
    ? recordOf(catalog, expenseItemCode, ['expenseItems', 'expenseItemCatalog']) : null;
  const expenseItemName = text(line?.expenseItemName) ?? recordName(expenseRecord);
  const invoiceType = invoiceTypeFor(voucher, line, event, problems, { materialId, lineId, eventId });
  const sourceRefs = [
    { materialId, role: 'primary_voucher', fields: ['identity', 'issueDate', 'amounts', 'invoiceType'] },
    ...references.map((reference) => ({
      materialId: reference.materialId,
      role: 'reference',
      fields: reference.kind === 'hotel_folio'
        ? ['checkIn', 'checkOut', 'totalAmount']
        : ['date', 'city', 'origin', 'destination', 'amount'],
    })),
  ];
  const fieldSources = {
    date: sourceValue(line, event, 'date', referenceFacts.date?.source
      ?? (date ? (event?.dateEvidence ?? null) : null)),
    endDate: sourceValue(line, event, 'endDate', referenceFacts.endDate?.source
      ?? (checkOut ? (event?.dateEvidence ?? null) : null)),
    city: sourceValue(line, event, 'city', referenceFacts.city?.source ?? null),
    origin: sourceValue(line, event, 'origin', railFacts.origin?.source
      ?? referenceFacts.origin?.source ?? null),
    destination: sourceValue(line, event, 'destination', railFacts.destination?.source
      ?? referenceFacts.destination?.source ?? null),
    route: sourceValue(line, event, 'route', railFacts.route?.source
      ?? referenceFacts.route?.source ?? null),
    amounts: amountSource,
    project: text(line?.projectSource ?? selection?.projectSource),
    expenseItem: text(line?.expenseItemSource ?? expenseRecord?.source),
    invoiceType: invoiceType.source,
  };
  return {
    lineId,
    eventId,
    voucherMaterialId: materialId,
    kind,
    kindLabel: text(line?.kindLabel ?? event?.kindLabel ?? voucher?.kindLabel),
    category,
    categoryLabel: text(line?.categoryLabel),
    date,
    checkOut,
    endDate: checkOut,
    city: text(line?.city ?? event?.city) ?? referenceFacts.city?.value ?? null,
    origin,
    destination,
    route,
    routeComplete: line?.routeComplete ?? event?.routeComplete ?? null,
    netCents,
    taxCents,
    totalCents,
    netAmount: amountText(netCents),
    taxAmount: amountText(taxCents),
    totalAmount: amountText(totalCents),
    amountSource,
    projectCode,
    projectName,
    projectSource: text(line?.projectSource ?? selection?.projectSource),
    projectsFrom: text(line?.projectsFrom ?? selection?.projectsFrom),
    expenseItemCode,
    expenseItemName,
    expenseItemSource: text(line?.expenseItemSource ?? expenseRecord?.source),
    invoiceType: invoiceType.value ?? null,
    invoiceTypeSource: invoiceType.source ?? null,
    purpose: text(line?.purpose ?? selection?.purpose),
    referenceMaterialIds: references.map((reference) => reference.materialId),
    sourceRefs,
    fieldSources,
    fieldEvidence: {
      date: portable(line?.fieldEvidence?.date ?? event?.dateEvidence ?? null),
      amounts: portable(line?.fieldEvidence?.amounts ?? amountSource),
      route: portable(line?.fieldEvidence?.route
        ?? referenceFacts.route?.source ?? railFacts.route?.source ?? null),
    },
    receiptFact: null,
  };
}

function hasExplicitSource(value) {
  return typeof value === 'string' && value.trim() && !CONTROL_RE.test(value);
}

function checkLineFacts(line, event, voucher, references, problems) {
  const at = { lineId: line.lineId, eventId: line.eventId, materialId: line.voucherMaterialId };
  if (!line.lineId || !line.eventId || !line.voucherMaterialId) {
    issue(problems, 'line_identity_missing', '费用明细缺少 lineId、eventId 或主要凭证 materialId', at);
    return;
  }
  if (!dateValue(line.date)) issue(problems, 'line_date_invalid', `明细 ${line.lineId} 缺少真实费用日期`, at);
  const accommodation = line.category === 'accommodation'
    || line.kind === 'hotel_folio' || line.kind === 'hotel';
  if (accommodation) {
    if (!dateValue(line.endDate)) issue(problems, 'accommodation_end_date_missing',
      `住宿明细 ${line.lineId} 缺少真实离店日期`, at);
    else if (line.endDate < line.date) issue(problems, 'accommodation_date_order_invalid',
      `住宿明细 ${line.lineId} 的离店日期早于入住日期`, at);
    if (!line.city) issue(problems, 'accommodation_city_missing',
      `住宿明细 ${line.lineId} 缺少真实发生城市`, at);
    else if (!hasExplicitSource(line.fieldSources?.city)) issue(problems,
      'accommodation_city_source_missing', `住宿明细 ${line.lineId} 缺少发生城市来源`, at);
  }
  const transport = line.kind === 'rail_eticket' || line.kind === 'passenger_transport'
    || ['local_city_transport', 'remote_city_transport', 'long_distance'].includes(line.category);
  if (transport) {
    if (!line.origin || !line.destination || !line.route) {
      issue(problems, 'transport_route_missing', `交通明细 ${line.lineId} 缺少完整起点、终点或路线`, at);
    }
    if (line.routeComplete === false) issue(problems, 'transport_route_incomplete',
      `交通明细 ${line.lineId} 的路线证据不完整`, at);
  }
  for (const field of ['date', 'amounts', 'project', 'expenseItem', 'invoiceType']) {
    if (!hasExplicitSource(line.fieldSources?.[field])) {
      issue(problems, 'field_source_missing', `明细 ${line.lineId} 缺少 ${field} 的明确来源`, { ...at, field });
    }
  }
  if (transport && (!hasExplicitSource(line.fieldSources?.origin)
    || !hasExplicitSource(line.fieldSources?.destination)
    || !hasExplicitSource(line.fieldSources?.route))) {
    issue(problems, 'route_source_missing', `交通明细 ${line.lineId} 缺少起终点/路线来源`, at);
  }
  if (accommodation && !hasExplicitSource(line.fieldSources?.endDate)) {
    issue(problems, 'accommodation_date_source_missing', `住宿明细 ${line.lineId} 缺少入住/离店日期来源`, at);
  }
  for (const [name, value] of [['netCents', line.netCents], ['taxCents', line.taxCents], ['totalCents', line.totalCents]]) {
    if (!validCents(value)) issue(problems, 'line_amount_invalid',
      `明细 ${line.lineId} 的 ${name} 不是真实有限金额（分）`, { ...at, field: name });
  }
  if ([line.netCents, line.taxCents, line.totalCents].every(validCents)
    && line.netCents + line.taxCents !== line.totalCents) {
    issue(problems, 'line_amount_not_conserved', `明细 ${line.lineId} 的净额、税额和价税合计不守恒`, at);
  }
  if (line.referenceMaterialIds.some((id) => !references.some((reference) => reference.materialId === id))) {
    issue(problems, 'reference_association_missing', `明细 ${line.lineId} 关联了不存在的参考材料`, at);
  }
  if (!line.sourceRefs.some((reference) => reference.materialId === line.voucherMaterialId)) {
    issue(problems, 'source_reference_missing', `明细 ${line.lineId} 缺少主要凭证来源引用`, at);
  }
}

function digestDocument(document) {
  const withoutDigest = { ...document };
  delete withoutDigest.digest;
  return digestValue(withoutDigest);
}

function jsonSafe(value) {
  return JSON.parse(JSON.stringify(portable(value)));
}

function sourceMaterialsFor(document) {
  return [...(document.invoices ?? []), ...(document.evidence ?? [])]
    .map((material) => ({
      materialId: material.materialId,
      role: material.role,
      sourceRelPath: material.sourceRelPath,
      targetPath: material.targetPath,
      contentHash: material.contentHash,
      size: material.size,
    }))
    .sort((a, b) => String(a.materialId).localeCompare(String(b.materialId)));
}

/**
 * Build a portable, source-bound preparation document.  This function is pure
 * apart from reading no files; callers can therefore display its blockers and
 * still generate a draft package for human review.
 */
export function buildPreparation({
  task = null,
  inventory = null,
  classification = null,
  built = null,
  lines = null,
  selection = null,
  catalog = null,
  classifiedConfirmed = false,
  projectCandidates = null,
  receiptFacts = null,
} = {}) {
  const problems = [];
  const taskIdentity = identityOf(task?.identity);
  const inventoryMaterials = Array.isArray(inventory?.materials) ? inventory.materials : [];
  const results = Array.isArray(classification?.results) ? classification.results : [];
  const events = Array.isArray(built?.events) ? built.events : [];
  const previewLines = Array.isArray(lines) ? lines : (Array.isArray(built?.lineItems) ? built.lineItems : []);
  const inventoryById = new Map(inventoryMaterials.map((material) => [material.materialId, material]));
  const resultById = new Map(results.map((result) => [result.materialId, result]));
  const eventById = new Map(events.map((event) => [event.eventId, event]));

  if (!text(task?.taskId)) issue(problems, 'task_id_missing', '任务缺少 taskId');
  if (!taskIdentity) issue(problems, 'task_identity_missing', '任务缺少已确认的 account/tenant 身份');
  if (!text(task?.currentVersionId)) issue(problems, 'task_version_missing', '任务缺少当前材料版本');
  if (!text(inventory?.versionId)) issue(problems, 'inventory_version_missing', '材料盘点缺少版本');
  if (!text(classification?.versionId)) issue(problems, 'classification_version_missing', '材料分类缺少版本');
  if (!text(built?.versionId)) issue(problems, 'events_version_missing', '事件构建缺少版本');
  const versionId = text(inventory?.versionId ?? classification?.versionId ?? built?.versionId);
  for (const [label, value] of [['task', task?.currentVersionId], ['inventory', inventory?.versionId],
    ['classification', classification?.versionId], ['events', built?.versionId]]) {
    if (value && versionId && value !== versionId) issue(problems, 'version_stale',
      `${label} 使用的材料版本不是当前版本`, { expected: versionId, actual: value });
  }
  const confirmation = classifiedConfirmed === true
    || classifiedConfirmed?.confirmed === true
    || classifiedConfirmed?.status === 'confirmed'
    || classifiedConfirmed?.verdict === 'confirmed';
  if (!confirmation) issue(problems, 'classification_not_confirmed', '材料分类尚未由用户确认');
  if (classifiedConfirmed && typeof classifiedConfirmed === 'object'
    && classifiedConfirmed.versionId && classifiedConfirmed.versionId !== versionId) {
    issue(problems, 'classification_confirmation_stale', '分类确认不属于当前材料版本');
  }
  if (!events.length) issue(problems, 'events_missing', '没有已确认费用事件');
  if (!previewLines.length) issue(problems, 'lines_missing', '没有已确认费用明细');
  if (!taskIdentity || !sameIdentity(selection?.identity, taskIdentity)) {
    issue(problems, 'selection_owner_mismatch', '任务选择身份与任务身份不一致');
  }
  if (selection?.projectSource !== 'erp_catalog_confirmed') {
    issue(problems, 'selection_project_source_unconfirmed', '项目选择没有 ERP 目录确认来源');
  }
  if (selection?.projectsFrom !== 'project_book') {
    issue(problems, 'selection_project_book_missing', '项目选择不是当前本人项目簿来源');
  }
  const taskHomeCity = text(task?.homeCity);
  const selectedHomeCity = text(selection?.homeCity);
  if (!taskHomeCity) issue(problems, 'home_city_missing', '任务缺少已确认常驻城市');
  if (!selectedHomeCity) issue(problems, 'selection_home_city_missing', '项目选择缺少常驻城市快照');
  else if (taskHomeCity && selectedHomeCity !== taskHomeCity) issue(problems,
    'selection_home_city_mismatch', '项目选择常驻城市与任务快照不一致');
  if (!text(selection?.purpose ?? task?.purpose)) issue(problems, 'purpose_missing', '缺少已确认报销事由');
  if (!text(selection?.versionId)) issue(problems, 'selection_version_missing', '项目选择缺少材料版本');
  else if (versionId && selection.versionId !== versionId) issue(problems, 'selection_version_stale',
    '项目选择版本与当前材料版本不一致');
  const expectedLinesDigest = lineDigest(previewLines);
  if (!text(selection?.linesDigest)) issue(problems, 'selection_lines_digest_missing', '项目选择缺少明细指纹');
  else if (selection.linesDigest !== expectedLinesDigest) {
    issue(problems, 'selection_lines_stale', '任务选择明细指纹与当前明细不一致');
  }
  if (!catalog || typeof catalog !== 'object') {
    issue(problems, 'catalog_missing', '缺少 ERP 主数据核验结果');
  } else {
    if (!text(catalog.versionId)) issue(problems, 'catalog_version_missing', 'ERP 目录核验缺少材料版本');
    else if (versionId && catalog.versionId !== versionId) issue(problems, 'catalog_version_stale',
      'ERP 目录核验版本与当前材料版本不一致');
    if (!text(catalog.linesDigest)) issue(problems, 'catalog_lines_digest_missing', 'ERP 目录核验缺少明细指纹');
    else if (catalog.linesDigest !== expectedLinesDigest) issue(problems, 'catalog_lines_stale',
      'ERP 目录核验明细指纹与当前明细不一致');
    if (!identityOf(catalog.identity)) issue(problems, 'catalog_identity_missing', 'ERP 目录核验缺少身份绑定');
    else if (!sameIdentity(identityOf(catalog.identity), taskIdentity)) {
      issue(problems, 'catalog_identity_mismatch', 'ERP 主数据核验身份与任务身份不一致');
    }
  }
  if (!Array.isArray(projectCandidates) && !Array.isArray(projectCandidates?.projects)) {
    issue(problems, 'project_candidates_missing', '缺少当前本人项目簿可选项目集合');
  }
  const candidateList = Array.isArray(projectCandidates) ? projectCandidates : projectCandidates?.projects;
  if (projectCandidates?.identity && !sameIdentity(identityOf(projectCandidates.identity), taskIdentity)) {
    issue(problems, 'project_candidates_owner_mismatch', '当前本人项目簿身份与任务身份不一致');
  }
  const allowedProjects = recordMap(candidateList);

  const primaryResults = results.filter((result) => result.role === 'primary_voucher');
  const referenceResults = results.filter((result) => result.role === 'reference');
  const classifiedMaterialIds = new Set([...primaryResults, ...referenceResults]
    .map((result) => result.materialId));
  for (const material of inventoryMaterials) {
    if (!classifiedMaterialIds.has(material.materialId)) {
      issue(problems, 'material_unclassified', `材料 ${material.materialId ?? '?'} 没有当前主要凭证或参考证据角色`, {
        materialId: material.materialId ?? null,
      });
    }
  }
  if (!primaryResults.length) issue(problems, 'primary_vouchers_missing', '分类结果没有主要报销凭证');
  if ((classification?.duplicates ?? []).length) {
    issue(problems, 'duplicate_invoice', '当前任务存在重复发票身份', { duplicates: classification.duplicates });
  }
  const identitySeen = new Map();
  for (const result of primaryResults) {
    const identity = identityFor(result);
    if (!identityIsNative(identity)) issue(problems, 'invoice_identity_invalid',
      `主要凭证 ${result.materialId} 缺少完整原生发票身份`, { materialId: result.materialId });
    if (identity?.key) {
      const previous = identitySeen.get(identity.key);
      if (previous) issue(problems, 'duplicate_invoice', `主要凭证 ${result.materialId} 与 ${previous} 身份重复`, {
        identityKey: identity.key, materialId: result.materialId,
      });
      identitySeen.set(identity.key, result.materialId);
    }
    const material = inventoryById.get(result.materialId);
    if (!material) issue(problems, 'invoice_material_missing', `主要凭证 ${result.materialId} 不在当前材料盘点中`, {
      materialId: result.materialId,
    });
    else if (!sourceRelPathOf(material)) issue(problems, 'invoice_source_path_invalid',
      `主要凭证 ${result.materialId} 缺少安全的相对源路径`, { materialId: result.materialId });
    if (result.parseStatus !== 'parsed') issue(problems, 'invoice_not_parsed',
      `主要凭证 ${result.materialId} 尚未完成分类解析`, { materialId: result.materialId });
    if (formatOf(material) === null || !SUPPORTED_FORMATS.has(formatOf(material))) issue(problems,
      'invoice_format_unsupported', `主要凭证 ${result.materialId} 不是 PDF/PNG/JPG`, { materialId: result.materialId });
    if (material && result.contentHash && material.contentHash !== result.contentHash) issue(problems,
      'invoice_hash_mismatch', `主要凭证 ${result.materialId} 的分类哈希与盘点不一致`, { materialId: result.materialId });
    if (material?.readStatus && material.readStatus !== 'ok') issue(problems,
      'invoice_material_unreadable', `主要凭证 ${result.materialId} 当前文件不可读`, { materialId: result.materialId });
    for (const field of ['invoiceNumber']) {
      if (!hasExplicitSource(fieldSourceOf(result, field))) issue(problems, 'invoice_field_source_missing',
        `主要凭证 ${result.materialId} 缺少 ${field} 的明确来源`, { materialId: result.materialId, field });
    }
  }
  const refsById = new Map(referenceResults.map((result) => [result.materialId, result]));
  const relatedReferenceIds = new Set();
  for (const event of events) {
    for (const id of event.referenceMaterialIds ?? []) relatedReferenceIds.add(id);
  }
  if (built?.evidence?.ambiguous?.length) issue(problems, 'evidence_association_ambiguous',
    '主要凭证与参考材料的关联存在歧义', { evidence: built.evidence.ambiguous });
  if (built?.evidence?.unlinked?.length) issue(problems, 'evidence_unlinked',
    '当前分类中有未关联的参考材料', { evidence: built.evidence.unlinked });
  for (const id of relatedReferenceIds) {
    if (!refsById.has(id)) issue(problems, 'reference_material_missing', `事件关联了不存在的参考材料 ${id}`, { materialId: id });
  }

  const normalizedReferences = referenceResults.map((result) => {
    const material = inventoryById.get(result.materialId);
    if (!material) issue(problems, 'reference_material_missing', `参考材料 ${result.materialId} 不在当前盘点中`, {
      materialId: result.materialId,
    });
    else if (!sourceRelPathOf(material)) issue(problems, 'reference_source_path_invalid',
      `参考材料 ${result.materialId} 缺少安全的相对源路径`, { materialId: result.materialId });
    if (result.parseStatus !== 'parsed') issue(problems, 'reference_not_parsed',
      `参考材料 ${result.materialId} 尚未完成解析`, { materialId: result.materialId });
    if (material && result.contentHash && material.contentHash !== result.contentHash) issue(problems,
      'reference_hash_mismatch', `参考材料 ${result.materialId} 的分类哈希与盘点不一致`, { materialId: result.materialId });
    return evidenceFacts(material, result, sourceMappingPath('reference', material ?? result));
  });
  const normalizedInvoices = primaryResults.map((result) => {
    const material = inventoryById.get(result.materialId);
    return materialFacts(material, result, 'primary_voucher', sourceMappingPath('primary_voucher', material ?? result));
  });
  const normalizedReceiptFacts = normalizeReceiptFacts(receiptFacts);
  const receiptFactsByMaterial = new Map(normalizedReceiptFacts.map((fact) => [fact.materialId, fact]));
  if (normalizedReceiptFacts.length !== receiptFactsByMaterial.size) {
    issue(problems, 'receipt_facts_duplicate', '当前收票事实包含重复的 voucherMaterialId');
  }
  const normalizedLines = [];
  for (const rawLine of previewLines) {
    const event = eventById.get(rawLine?.eventId);
    const materialId = text(rawLine?.voucherMaterialId ?? event?.voucherMaterialId);
    const voucherResult = resultById.get(materialId);
    const referenceIds = [...new Set((rawLine?.referenceMaterialIds ?? event?.referenceMaterialIds ?? [])
      .map((id) => text(id)).filter(Boolean))];
    const references = referenceIds.map((id) => refsById.get(id)).filter(Boolean);
    const line = normalizedLine(rawLine, event, voucherResult, references, selection, catalog, problems);
    normalizedLines.push(line);
    if (!event) issue(problems, 'line_event_missing', `明细 ${line.lineId ?? '?'} 没有对应事件`, { lineId: line.lineId });
    if (!voucherResult) issue(problems, 'line_voucher_missing', `明细 ${line.lineId ?? '?'} 没有对应主要凭证`, {
      lineId: line.lineId,
    });
    const projectRecord = line.projectCode ? recordOf(catalog, line.projectCode, ['projects']) : null;
    if (!line.projectCode || !line.projectName) issue(problems, 'project_missing',
      `明细 ${line.lineId ?? '?'} 缺少项目编码或名称`, { lineId: line.lineId });
    if (line.projectCode && (!allowedProjects.has(line.projectCode)
      || (recordName(allowedProjects.get(line.projectCode))
        && recordName(allowedProjects.get(line.projectCode)) !== line.projectName))) {
      issue(problems, 'project_not_currently_allowed',
        `明细 ${line.lineId ?? '?'} 的项目不在当前本人项目簿可选集合中`, {
          lineId: line.lineId, projectCode: line.projectCode,
        });
    }
    if (!confirmedRecord(projectRecord) || recordName(projectRecord) !== line.projectName) issue(problems,
      'project_catalog_unconfirmed', `明细 ${line.lineId ?? '?'} 的项目未通过 ERP 目录确认`, {
        lineId: line.lineId, projectCode: line.projectCode,
      });
    const expenseRecord = line.expenseItemCode
      ? recordOf(catalog, line.expenseItemCode, ['expenseItems', 'expenseItemCatalog']) : null;
    if (!line.expenseItemCode || !line.expenseItemName) issue(problems, 'expense_item_missing',
      `明细 ${line.lineId ?? '?'} 缺少费用项目编码或名称`, { lineId: line.lineId });
    if (!confirmedRecord(expenseRecord) || recordName(expenseRecord) !== line.expenseItemName) issue(problems,
      'expense_item_catalog_unconfirmed', `明细 ${line.lineId ?? '?'} 的费用项目未通过 ERP 目录确认`, {
        lineId: line.lineId, expenseItemCode: line.expenseItemCode,
      });
    if (!line.invoiceType || !ERP_INVOICE_TYPES.has(line.invoiceType)
      || !line.invoiceTypeSource) issue(problems, 'invoice_type_unconfirmed',
      `明细 ${line.lineId ?? '?'} 缺少可信 ERP 发票类型映射`, { lineId: line.lineId });
    checkLineFacts(line, event, voucherResult, references, problems);
  }

  const linesByMaterial = new Map();
  for (const line of normalizedLines) {
    if (!linesByMaterial.has(line.voucherMaterialId)) linesByMaterial.set(line.voucherMaterialId, []);
    linesByMaterial.get(line.voucherMaterialId).push(line);
  }
  for (const invoice of normalizedInvoices) {
    const result = resultById.get(invoice.materialId);
    const materialEvents = linesByMaterial.get(invoice.materialId) ?? [];
    if (!materialEvents.length) issue(problems, 'invoice_events_missing',
      `主要凭证 ${invoice.materialId} 没有对应费用事件`, { materialId: invoice.materialId });
    const invoiceTotal = invoice.fields.totalCents;
    const invoiceNet = invoice.kind === 'rail_eticket' && validCents(invoiceTotal)
      ? invoiceTotal : invoice.fields.netCents;
    const invoiceTax = invoice.kind === 'rail_eticket' && validCents(invoiceTotal)
      ? 0 : invoice.fields.taxCents;
    for (const [name, value] of [['netCents', invoiceNet], ['taxCents', invoiceTax], ['totalCents', invoiceTotal]]) {
      if (!validCents(value)) issue(problems, 'invoice_amount_invalid',
        `主要凭证 ${invoice.materialId} 的 ${name} 不是真实有限金额（分）`, {
          materialId: invoice.materialId, field: name,
        });
    }
    if (validCents(invoiceNet) && validCents(invoiceTax) && validCents(invoiceTotal)
      && invoiceNet + invoiceTax !== invoiceTotal) issue(problems, 'invoice_amount_not_conserved',
      `主要凭证 ${invoice.materialId} 的净额、税额和价税合计不守恒`, { materialId: invoice.materialId });
    const sum = (field) => materialEvents.reduce((total, line) => total + (line[field] ?? 0), 0);
    if (validCents(invoiceNet) && sum('netCents') !== invoiceNet) issue(problems, 'invoice_event_net_not_conserved',
      `主要凭证 ${invoice.materialId} 与费用事件净额不守恒`, { materialId: invoice.materialId });
    if (validCents(invoiceTax) && sum('taxCents') !== invoiceTax) issue(problems, 'invoice_event_tax_not_conserved',
      `主要凭证 ${invoice.materialId} 与费用事件税额不守恒`, { materialId: invoice.materialId });
    if (validCents(invoiceTotal) && sum('totalCents') !== invoiceTotal) issue(problems,
      'invoice_event_total_not_conserved', `主要凭证 ${invoice.materialId} 与费用事件价税合计不守恒`, {
        materialId: invoice.materialId,
      });
  }

  const excluded = [];
  const includedIds = new Set([...normalizedInvoices, ...normalizedReferences].map((item) => item.materialId));
  for (const material of inventoryMaterials) {
    if (includedIds.has(material.materialId)) continue;
    excluded.push({
      materialId: material.materialId ?? null,
      sourceRelPath: sourceRelPathOf(material),
      fileName: material.fileName ?? null,
      contentHash: material.contentHash ?? null,
      size: Number.isSafeInteger(material.size) ? material.size : null,
      reason: material.reason ?? material.disposition ?? 'not_in_current_preparation_scope',
    });
  }
  for (const material of inventory?.excluded ?? []) {
    if (!excluded.some((item) => item.materialId === material.materialId
      && item.sourceRelPath === material.relPath)) {
      excluded.push({
        materialId: material.materialId ?? null,
        sourceRelPath: sourceRelPathOf(material),
        fileName: material.fileName ?? null,
        contentHash: material.contentHash ?? null,
        size: Number.isSafeInteger(material.size) ? material.size : null,
        reason: material.reason ?? 'explicit_scope',
      });
    }
  }
  for (const ignored of inventory?.ignored ?? []) excluded.push({
    materialId: ignored.materialId ?? null,
    sourceRelPath: sourceRelPathOf(ignored),
    fileName: ignored.fileName ?? null,
    contentHash: ignored.contentHash ?? null,
    size: Number.isSafeInteger(ignored.size) ? ignored.size : null,
    reason: ignored.reason ?? 'ignored',
  });
  const sourceSnapshot = {
    taskId: text(task?.taskId),
    sourceKey: text(task?.sourceKey),
    versionId,
    inventoryVersionId: text(inventory?.versionId),
    classificationVersionId: text(classification?.versionId),
    classificationCandidateDigest: text(classification?.candidateDigest),
    eventsVersionId: text(built?.versionId),
    selection: portable({
      versionId: selection?.versionId,
      linesDigest: selection?.linesDigest,
      identity: selection?.identity,
      homeCity: selection?.homeCity,
      purpose: selection?.purpose,
      projects: selection?.projects,
      projectSource: selection?.projectSource,
      projectsFrom: selection?.projectsFrom,
    }),
    catalog: portable({
      versionId: catalog?.versionId,
      linesDigest: catalog?.linesDigest,
      identity: catalog?.identity,
      projects: normalizedLines.map((line) => line.projectCode
        ? recordOf(catalog, line.projectCode, ['projects']) : null),
      expenseItems: normalizedLines.map((line) => line.expenseItemCode
        ? recordOf(catalog, line.expenseItemCode, ['expenseItems', 'expenseItemCatalog']) : null),
    }),
    projectCandidates: portable(candidateList ?? []),
    scope: portable(inventory?.scope ?? task?.materialScope ?? null),
    materials: sourceMaterialsFor({ invoices: normalizedInvoices, evidence: normalizedReferences }),
    receiptFacts: portable({
      fresh: receiptFacts?.fresh === true,
      taskId: receiptFacts?.taskId ?? null,
      versionId: receiptFacts?.versionId ?? null,
      identity: receiptFacts?.identity ?? null,
      readAt: receiptFacts?.readAt ?? null,
      rows: normalizedReceiptFacts,
    }),
  };
  let document = {
    schemaVersion: PREPARATION_SCHEMA_VERSION,
    phase: PREPARATION_PHASE,
    status: problems.some((problem) => problem.blocking) ? 'draft' : 'ready_for_preparation',
    task: {
      taskId: text(task?.taskId),
      sourceKey: text(task?.sourceKey),
      sourceLabel: text(task?.sourceLabel),
      versionId,
      identity: taskIdentity,
      purpose: text(selection?.purpose ?? task?.purpose),
      homeCity: text(selection?.homeCity ?? task?.homeCity),
    },
    identity: taskIdentity,
    purpose: text(selection?.purpose ?? task?.purpose),
    homeCity: text(selection?.homeCity ?? task?.homeCity),
    invoices: normalizedInvoices.sort((a, b) => String(a.materialId).localeCompare(String(b.materialId))),
    evidence: normalizedReferences.sort((a, b) => String(a.materialId).localeCompare(String(b.materialId))),
    lines: normalizedLines,
    excluded: excluded.sort((a, b) => String(a.sourceRelPath ?? '').localeCompare(String(b.sourceRelPath ?? ''))),
    scope: portable(inventory?.scope ?? task?.materialScope ?? null),
    sourceSnapshot,
    problems: portable(problems),
    ready: !problems.some((problem) => problem.blocking),
  };
  document = jsonSafe(document);
  document.digest = digestDocument(document);
  return {
    document,
    problems,
    ready: document.ready,
    digest: document.digest,
    sourceMapping: sourceMaterialsFor(document),
  };
}

function markdownValue(value) {
  if (value === null || value === undefined || value === '') return '缺失（未提供）';
  if (Array.isArray(value)) return value.length ? value.map(markdownValue).join('；') : '缺失（未提供）';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function markdownLinkPath(targetPath) {
  if (!targetPath) return null;
  return String(targetPath).split('/').map((part) => encodeURIComponent(part)).join('/');
}

function markdownLink(material, label = null) {
  const target = markdownLinkPath(material?.targetPath);
  if (!target) return markdownValue(label ?? material?.materialId);
  return `[${markdownValue(label ?? material?.fileName ?? material?.materialId)}](${target})`;
}

function markdownMoney(cents) {
  return validCents(cents) ? `${amountText(cents)} 元` : '缺失（未提供）';
}

function markdownStatus(status) {
  return status === 'ready_for_preparation' ? '材料已备齐' : '草稿（材料不足）';
}

function markdownPhase(phase) {
  return phase === PREPARATION_PHASE ? 'ERP 前准备' : markdownValue(phase);
}

function isAccommodationLine(line) {
  return line?.category === 'accommodation' || line?.kind === 'hotel_folio' || line?.kind === 'hotel';
}

/** Render only from the canonical JSON document. */
export function renderDetailMarkdown(document) {
  const documentLines = Array.isArray(document?.lines) ? document.lines : [];
  const totalsComplete = documentLines.every((line) => validCents(line?.totalCents));
  const totalCents = totalsComplete
    ? documentLines.reduce((sum, line) => sum + line.totalCents, 0) : null;
  const invoicesById = new Map((document?.invoices ?? []).map((invoice) => [invoice.materialId, invoice]));
  const evidenceById = new Map((document?.evidence ?? []).map((evidence) => [evidence.materialId, evidence]));
  const lines = [
    '# 报销准备明细',
    '',
    `- 阶段: ${markdownPhase(document?.phase)}`,
    `- 状态: ${markdownStatus(document?.status)}`,
    `- 任务: ${markdownValue(document?.task?.taskId)}`,
    `- 身份 account: ${markdownValue(document?.identity?.account)}`,
    `- 身份 tenant: ${markdownValue(document?.identity?.tenant)}`,
    `- 报销事由: ${markdownValue(document?.purpose)}`,
    `- 常驻城市: ${markdownValue(document?.homeCity)}`,
    `- 材料版本: ${markdownValue(document?.task?.versionId)}`,
    `- 主要发票数: ${(document?.invoices ?? []).length}`,
    `- 费用明细数: ${documentLines.length}`,
    `- 明细总额: ${markdownMoney(totalCents)}`,
    '',
    '## 费用明细',
  ];
  for (const [index, line] of documentLines.entries()) {
    const invoice = invoicesById.get(line.voucherMaterialId);
    const accommodation = isAccommodationLine(line);
    const stay = accommodation
      ? (line.date && line.checkOut ? `${line.date} 至 ${line.checkOut}` : null)
      : '不适用';
    const invoiceNumber = invoice?.identity?.number ?? invoice?.fields?.invoiceNumber;
    lines.push('', `### ${index + 1}. ${markdownValue(line.lineId)}`,
      `- 事件: ${markdownValue(line.eventId)}`,
      `- 票种/费用类别: ${markdownValue(line.kindLabel ?? line.kind)} / ${markdownValue(line.categoryLabel ?? line.category)}`,
      `- 日期: ${markdownValue(line.date)}`,
      `- 入住至离店: ${markdownValue(stay)}`,
      `- 城市: ${markdownValue(line.city)}`,
      `- 路线: ${markdownValue(line.route)}`,
      `- 起点: ${markdownValue(line.origin)}`,
      `- 终点: ${markdownValue(line.destination)}`,
      `- 发票号码: ${markdownValue(invoiceNumber)}`,
      `- 原件: ${markdownLink(invoice)}`,
      `- 项目编码: ${markdownValue(line.projectCode)}`,
      `- 项目名称: ${markdownValue(line.projectName)}`,
      `- 项目来源: ${markdownValue(line.projectSource)} / ${markdownValue(line.projectsFrom)}`,
      `- 费用项目编码: ${markdownValue(line.expenseItemCode)}`,
      `- 费用项目名称: ${markdownValue(line.expenseItemName)}`,
      `- 费用项目来源: ${markdownValue(line.expenseItemSource)}`,
      `- ERP 发票类型: ${markdownValue(line.invoiceType)}`,
      `- ERP 发票类型来源: ${markdownValue(line.invoiceTypeSource)}`,
      `- 不含税金额: ${markdownMoney(line.netCents)}`,
      `- 税额: ${markdownMoney(line.taxCents)}`,
      `- 价税合计: ${markdownMoney(line.totalCents)}`,
      `- 金额来源: ${markdownValue(line.amountSource)}`,
      '- 来源材料:',
      ...(line.sourceRefs ?? []).map((reference) => {
        const material = reference.role === 'primary_voucher'
          ? invoicesById.get(reference.materialId) : evidenceById.get(reference.materialId);
        return `  - ${markdownValue(reference.role)} ${markdownLink(material, reference.materialId)}: ${markdownValue(reference.fields)}`;
      }),
    );
  }
  lines.push('', '## 主要发票', '');
  for (const invoice of document?.invoices ?? []) {
    lines.push(`- ${markdownValue(invoice.materialId)}: ${markdownValue(invoice.kindLabel ?? invoice.kind)}`,
      `  - 原生身份: ${markdownValue(invoice.identity?.key)}`,
      `  - 原生票据代码: ${markdownValue(invoice.identity?.code)}`,
      `  - 原生票据号码: ${markdownValue(invoice.identity?.number)}`,
      `  - 文件: ${markdownLink(invoice)}`,
      `  - 文件哈希: ${markdownValue(invoice.contentHash)}`);
  }
  lines.push('', '## 参考证据', '');
  for (const evidence of document?.evidence ?? []) {
    lines.push(`- ${markdownValue(evidence.materialId)}: ${markdownValue(evidence.kindLabel ?? evidence.kind)}`,
      `  - 文件: ${markdownLink(evidence)}`,
      `  - 文件哈希: ${markdownValue(evidence.contentHash)}`);
  }
  lines.push('', '## 字段来源（技术）', '');
  for (const line of documentLines) {
    lines.push(`- ${markdownValue(line.lineId)}:`);
    for (const [field, source] of Object.entries(line.fieldSources ?? {})) {
      lines.push(`  - ${field}: ${markdownValue(source)}`);
    }
  }
  lines.push('', '## 缺失与阻塞', '');
  if (!(document?.problems ?? []).length) lines.push('- 无');
  else for (const problem of document.problems) {
    lines.push(`- [${problem.blocking ? '阻塞' : '提示'}] ${markdownValue(problem.code)}: ${markdownValue(problem.message)}`);
  }
  lines.push('', `- preparation digest: ${markdownValue(document?.digest)}`, '');
  return `${lines.join('\n')}\n`;
}

function pathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function pathsOverlap(left, right) {
  return pathInside(left, right) || pathInside(right, left);
}

async function realSourceFile(root, relPath) {
  const rel = relativePath(relPath, 'source mapping path');
  const candidate = path.resolve(root, rel);
  if (!pathInside(root, candidate)) throw new Error(`source path escapes source root: ${rel}`);
  const actual = await fsp.realpath(candidate);
  if (!pathInside(root, actual)) throw new Error(`source symlink escapes source root: ${rel}`);
  const stat = await fsp.stat(actual);
  if (!stat.isFile()) throw new Error(`source is not a regular file: ${rel}`);
  return { actual, stat };
}

function payloadHash(records) {
  const hash = crypto.createHash('sha256');
  for (const record of records.sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(record.path, 'utf8');
    hash.update('\0');
    hash.update(record.bytes);
    hash.update('\0');
  }
  return hash.digest('hex');
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function ensureDirectoryNoSymlink(directory, boundary) {
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fsp.lstat(directory);
  if (stat.isSymbolicLink()) throw new Error(`output directory is a symlink: ${directory}`);
  if (!stat.isDirectory()) throw new Error(`output directory is not a directory: ${directory}`);
  // System temp directories on macOS commonly contain an OS-owned symlink
  // (for example /tmp -> /private/tmp).  Permit those ancestors, but ensure
  // the actual preparation directory still resolves inside the task root.
  if (boundary) {
    const [actual, actualBoundary] = await Promise.all([
      fsp.realpath(directory),
      fsp.realpath(boundary),
    ]);
    if (!pathInside(actualBoundary, actual)) {
      throw new Error(`output directory escapes task root: ${directory}`);
    }
  }
}

function preparationDirectory(task, digest) {
  if (!task?.createdAt || !text(task?.taskId) || !HASH_RE.test(String(digest ?? ''))) return null;
  return path.join(taskDir(task), 'preparation', digest);
}

function manifestWithoutHash(manifest) {
  const copy = { ...manifest };
  delete copy.manifestHash;
  return copy;
}

function bundleEntries(directory) {
  const entries = [];
  const walk = (current, relative = '') => {
    const stat = fs.lstatSync(current);
    if (relative) {
      entries.push({
        path: relative,
        type: stat.isSymbolicLink() ? 'symlink'
          : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other',
      });
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    for (const name of fs.readdirSync(current)) {
      const childRelative = relative ? `${relative}/${name}` : name;
      walk(path.join(current, name), childRelative);
    }
  };
  walk(directory);
  return entries;
}

function expectedBundleEntries(sourceMapping) {
  const files = new Set(['detail.json', 'detail.md', 'manifest.json']);
  const directories = new Set();
  for (const record of sourceMapping) {
    const targetPath = relativePath(record.targetPath, 'manifest target path');
    files.add(targetPath);
    let parent = path.posix.dirname(targetPath);
    while (parent && parent !== '.') {
      directories.add(parent);
      parent = path.posix.dirname(parent);
    }
  }
  return { files, directories };
}

async function verifyCurrentSources(sourceRoot, inventory, document) {
  const mappings = sourceMaterialsFor(document);
  for (const mapping of mappings) {
    const material = inventory?.materials?.find((item) => item.materialId === mapping.materialId)
      ?? inventory?.excluded?.find((item) => item.materialId === mapping.materialId);
    if (!material || sourceRelPathOf(material) !== mapping.sourceRelPath) {
      throw new Error(`preparation source mapping is not current: ${mapping.materialId}`);
    }
    if (!SUPPORTED_FORMATS.has(formatOf(material))) {
      throw new Error(`preparation source format is unsupported: ${mapping.materialId}`);
    }
    const source = await realSourceFile(sourceRoot, material.relPath);
    const bytes = await fsp.readFile(source.actual);
    const sourceHash = sha256(bytes);
    if (material.contentHash && sourceHash !== material.contentHash) {
      throw new Error(`source changed since inventory: ${material.relPath}`);
    }
    if (mapping.contentHash && sourceHash !== mapping.contentHash) {
      throw new Error(`source changed since preparation build: ${material.relPath}`);
    }
  }
}

/**
 * Materialize a preparation result outside the source directory.  Existing
 * versions are immutable: an exact valid version is reused, while a collision
 * or invalid existing directory is rejected.
 */
export async function generatePreparation({ task, sourceDir, inventory, preparation } = {}) {
  if (!preparation?.document || !preparation.digest) throw new TypeError('preparation result is required');
  if (!task?.taskId || !task?.createdAt) throw new TypeError('task with taskId and createdAt is required');
  if (typeof sourceDir !== 'string' || !sourceDir.trim()) throw new TypeError('sourceDir is required');
  if (!HASH_RE.test(String(preparation.digest))) throw new TypeError('preparation digest is invalid');
  if (preparation.document.digest !== preparation.digest
    || digestDocument(preparation.document) !== preparation.digest) {
    throw new Error('preparation document digest does not match result digest');
  }
  const sourceRootPath = path.resolve(sourceDir);
  const sourceStat = await fsp.stat(sourceRootPath).catch(() => null);
  if (!sourceStat?.isDirectory()) throw new Error(`source is not a directory: ${sourceDir}`);
  const sourceRoot = await fsp.realpath(sourceRootPath);
  const taskRoot = path.resolve(taskDir(task));
  const destination = preparationDirectory(task, preparation.digest);
  const preparationRoot = path.dirname(destination);
  await fsp.mkdir(taskRoot, { recursive: true, mode: 0o700 });
  const actualTaskRoot = await fsp.realpath(taskRoot);
  if (pathsOverlap(sourceRoot, actualTaskRoot)) {
    throw new Error('preparation output must be outside the source directory');
  }
  // Validate the source snapshot even when an existing valid bundle can be
  // reused.  A valid old bundle must not hide a changed original.
  await verifyCurrentSources(sourceRoot, inventory, preparation.document);
  await ensureDirectoryNoSymlink(preparationRoot, taskRoot);
  const existing = await fsp.lstat(destination).catch(() => null);
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      const quarantine = path.join(preparationRoot,
        `.invalid-${preparation.digest}-${Date.now()}-${crypto.randomBytes(5).toString('hex')}`);
      await fsp.rename(destination, quarantine);
    } else {
      const inspection = inspectPreparation({ task, preparation: { ...preparation, directory: destination } });
      if (inspection.ok && inspection.digest === preparation.digest) {
        return { ...preparation, directory: destination, created: false, manifest: inspection.manifest };
      }
      const quarantine = path.join(preparationRoot,
        `.invalid-${preparation.digest}-${Date.now()}-${crypto.randomBytes(5).toString('hex')}`);
      await fsp.rename(destination, quarantine);
    }
  }

  const stage = path.join(preparationRoot,
    `.staging-${preparation.digest}-${crypto.randomBytes(6).toString('hex')}`);
  await fsp.mkdir(stage, { recursive: false, mode: 0o700 });
  try {
    const mappings = sourceMaterialsFor(preparation.document);
    const payloadRecords = [];
    const materialRecords = [];
    for (const mapping of mappings) {
      const material = inventory?.materials?.find((item) => item.materialId === mapping.materialId)
        ?? inventory?.excluded?.find((item) => item.materialId === mapping.materialId);
      if (!material || sourceRelPathOf(material) !== mapping.sourceRelPath) {
        throw new Error(`preparation source mapping is not current: ${mapping.materialId}`);
      }
      if (!SUPPORTED_FORMATS.has(formatOf(material))) {
        throw new Error(`preparation source format is unsupported: ${mapping.materialId}`);
      }
      const source = await realSourceFile(sourceRoot, material.relPath);
      const bytes = await fsp.readFile(source.actual);
      const sourceHash = sha256(bytes);
      if (material.contentHash && sourceHash !== material.contentHash) {
        throw new Error(`source changed since inventory: ${material.relPath}`);
      }
      if (mapping.contentHash && sourceHash !== mapping.contentHash) {
        throw new Error(`source changed since preparation build: ${material.relPath}`);
      }
      const targetPath = relativePath(mapping.targetPath, 'target path');
      const target = path.join(stage, targetPath);
      if (!pathInside(stage, target)) throw new Error(`target path escapes preparation bundle: ${targetPath}`);
      await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await fsp.writeFile(target, bytes, { mode: 0o600, flag: 'wx' });
      payloadRecords.push({ path: targetPath, bytes });
      materialRecords.push({ ...mapping, size: bytes.length, contentHash: sourceHash });
    }

    const documentBytes = jsonBytes(preparation.document);
    const detailMarkdown = renderDetailMarkdown(JSON.parse(documentBytes.toString('utf8')));
    const markdownBytes = Buffer.from(detailMarkdown, 'utf8');
    await fsp.writeFile(path.join(stage, 'detail.json'), documentBytes, { mode: 0o600, flag: 'wx' });
    await fsp.writeFile(path.join(stage, 'detail.md'), markdownBytes, { mode: 0o600, flag: 'wx' });
    payloadRecords.push({ path: 'detail.json', bytes: documentBytes });
    payloadRecords.push({ path: 'detail.md', bytes: markdownBytes });

    const manifest = {
      schemaVersion: PREPARATION_SCHEMA_VERSION,
      kind: 'preparation_bundle',
      phase: PREPARATION_PHASE,
      digest: preparation.digest,
      taskId: task.taskId,
      sourceKey: text(task.sourceKey),
      versionId: preparation.document.task?.versionId ?? null,
      ready: preparation.ready === true,
      status: preparation.ready === true ? 'ready_for_preparation' : 'draft',
      files: {
        detailJson: { path: 'detail.json', sha256: sha256(documentBytes), size: documentBytes.length },
        detailMarkdown: { path: 'detail.md', sha256: sha256(markdownBytes), size: markdownBytes.length },
        invoices: materialRecords.filter((record) => record.role === 'primary_voucher'),
        evidence: materialRecords.filter((record) => record.role === 'reference'),
      },
      sourceMapping: materialRecords,
      excluded: preparation.document.excluded ?? [],
      bundleHash: payloadHash(payloadRecords),
    };
    manifest.manifestHash = digestValue(manifestWithoutHash(manifest));
    await fsp.writeFile(path.join(stage, 'manifest.json'), jsonBytes(manifest), { mode: 0o600, flag: 'wx' });
    await fsp.rename(stage, destination);
    return {
      ...preparation,
      directory: destination,
      files: {
        detailJson: path.join(destination, 'detail.json'),
        detailMarkdown: path.join(destination, 'detail.md'),
        manifest: path.join(destination, 'manifest.json'),
        invoices: materialRecords.filter((record) => record.role === 'primary_voucher')
          .map((record) => path.join(destination, record.targetPath)),
        evidence: materialRecords.filter((record) => record.role === 'reference')
          .map((record) => path.join(destination, record.targetPath)),
      },
      manifest,
      created: true,
    };
  } catch (error) {
    await fsp.rm(stage, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

/** Verify one immutable bundle without reading the original source directory. */
export function inspectPreparation({ task, preparation } = {}) {
  const digest = typeof preparation === 'string' ? preparation : preparation?.digest;
  const directory = typeof preparation === 'object' && preparation?.directory
    ? path.resolve(preparation.directory) : preparationDirectory(task, digest);
  if (!directory) return {
    ok: false, status: 'missing', manifest: {}, document: null,
    problems: [{ code: 'preparation_missing' }],
  };
  try {
    const rootStat = fs.lstatSync(directory);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw new Error('preparation directory is not a regular directory');
    }
    const read = (name) => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
    const manifest = read('manifest.json');
    const document = read('detail.json');
    const problems = [];
    const sourceMapping = Array.isArray(manifest.sourceMapping) ? manifest.sourceMapping : [];
    const documentMapping = sourceMaterialsFor(document);
    if (stableValue(sourceMapping) !== stableValue(documentMapping)) {
      problems.push({ code: 'manifest_source_mapping_mismatch' });
    }
    const expected = expectedBundleEntries(sourceMapping);
    const actual = bundleEntries(directory);
    const actualFiles = new Set(actual.filter((entry) => entry.type === 'file').map((entry) => entry.path));
    const actualDirectories = new Set(actual.filter((entry) => entry.type === 'directory').map((entry) => entry.path));
    const actualSymlinks = actual.filter((entry) => entry.type === 'symlink');
    if (actualSymlinks.length) problems.push({ code: 'bundle_symlink_present', paths: actualSymlinks.map((entry) => entry.path) });
    const exactFiles = actualFiles.size === expected.files.size
      && [...actualFiles].every((entry) => expected.files.has(entry));
    const exactDirectories = actualDirectories.size === expected.directories.size
      && [...actualDirectories].every((entry) => expected.directories.has(entry));
    if (!exactFiles || !exactDirectories || actualSymlinks.length
      || actual.some((entry) => entry.type === 'other')) {
      problems.push({ code: 'bundle_files_mismatch' });
    }
    if (manifest.schemaVersion !== PREPARATION_SCHEMA_VERSION) problems.push({ code: 'manifest_schema_invalid' });
    if (manifest.digest !== digestDocument(document)) problems.push({ code: 'document_digest_invalid' });
    if (digest && manifest.digest !== digest) problems.push({ code: 'preparation_stale' });
    if (manifest.manifestHash !== digestValue(manifestWithoutHash(manifest))) problems.push({ code: 'manifest_hash_invalid' });
    if (manifest.taskId !== document?.task?.taskId
      || manifest.sourceKey !== (document?.task?.sourceKey ?? null)
      || manifest.versionId !== (document?.task?.versionId ?? null)) {
      problems.push({ code: 'manifest_task_mismatch' });
    }
    const detailJson = fs.readFileSync(path.join(directory, 'detail.json'));
    const detailMarkdown = fs.readFileSync(path.join(directory, 'detail.md'));
    if (sha256(detailJson) !== manifest.files?.detailJson?.sha256) problems.push({ code: 'detail_json_hash_invalid' });
    if (sha256(detailMarkdown) !== manifest.files?.detailMarkdown?.sha256) problems.push({ code: 'detail_markdown_hash_invalid' });
    if (detailMarkdown.toString('utf8') !== renderDetailMarkdown(document)) problems.push({ code: 'detail_markdown_not_derived' });
    const seenTargets = new Set();
    const records = sourceMapping.map((record) => {
      const targetPath = relativePath(record.targetPath, 'manifest target path');
      if (seenTargets.has(targetPath)) problems.push({ code: 'manifest_target_duplicate', targetPath });
      seenTargets.add(targetPath);
      const target = path.resolve(directory, targetPath);
      if (!pathInside(directory, target)) {
        problems.push({ code: 'manifest_target_escape', targetPath });
        return null;
      }
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        problems.push({ code: 'material_file_invalid', materialId: record.materialId });
        return null;
      }
      const bytes = fs.readFileSync(target);
      if (sha256(bytes) !== record.contentHash) problems.push({ code: 'material_hash_invalid', materialId: record.materialId });
      if (bytes.length !== record.size) problems.push({ code: 'material_size_invalid', materialId: record.materialId });
      return { path: targetPath, bytes };
    }).filter(Boolean);
    records.push({ path: 'detail.json', bytes: detailJson }, { path: 'detail.md', bytes: detailMarkdown });
    if (payloadHash(records) !== manifest.bundleHash) problems.push({ code: 'bundle_hash_invalid' });
    const current = !!task && manifest.taskId === task.taskId
      && (!task.sourceKey || manifest.sourceKey === task.sourceKey)
      && (!task.currentVersionId || manifest.versionId === task.currentVersionId)
      && (!task.identity || sameIdentity(identityOf(document?.identity), identityOf(task.identity)));
    if (!current) problems.push({ code: 'preparation_not_current' });
    const documentReady = document?.ready === true
      && document?.status === 'ready_for_preparation'
      && !(Array.isArray(document?.problems) && document.problems.some((problem) => problem?.blocking === true));
    const expectedManifestStatus = documentReady ? 'ready_for_preparation' : 'draft';
    if (manifest.ready !== documentReady || manifest.status !== expectedManifestStatus) {
      problems.push({ code: 'manifest_ready_mismatch' });
    }
    return {
      ok: problems.length === 0,
      status: problems.length ? (problems.some((problem) => ['preparation_stale', 'preparation_not_current']
        .includes(problem.code)) ? 'stale' : 'invalid') : 'valid',
      digest: manifest.digest,
      ready: documentReady,
      directory,
      document,
      manifest,
      problems,
    };
  } catch (error) {
    return {
      ok: false,
      status: 'missing',
      directory,
      manifest: {},
      document: null,
      problems: [{ code: 'preparation_unreadable', message: error.message }],
    };
  }
}

export const preparationDigest = (preparation) => preparation?.digest ?? null;
