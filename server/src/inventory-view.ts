import type { ExpenseEvent, Inventory, InventoryPhase, Line, Material, PendingField, PendingItem } from '@baox/contract';
import type { ParseOutcome, Recognised } from './parse/dispatch';
import { KINDS, slotOf } from './parse/kinds';

// The pure projection of one inventory run: uploaded materials plus their parser outcomes in; the materials view,
// derived 待确认项 (pending items), expense events, candidate lines and inventory counts out. Nothing here is stored.
// Pending items are derived per run with stable ids `<code>.<materialId>[.<key>]`, so answers (#187) can be keyed
// `(kind, materialId, field)` and carried over between runs.

export type ViewMaterial = {
  materialId: string;
  batchId: string;
  fileName: string;
  contentHash: string;
  size: number;
  mediaType: 'pdf' | 'image';
  excluded: boolean;
};

// `results` is null when the current version has not been inventoried (before start-inventory, or after reopen-upload).
export type RunResults = { outcomes: ReadonlyMap<string, ParseOutcome>; startedAt: string; finishedAt: string | null } | null;

export type InventoryView = {
  materials: Material[];
  pendingItems: PendingItem[];
  events: ExpenseEvent[];
  lines: Line[];
  inventory: Inventory;
  // Included materials of the run still waiting for a parser outcome; > 0 means the job is running.
  waiting: number;
  openPendingItems: number;
};

export const INVENTORY_COPY = {
  uploaded: '待盘点',
  unrecognised: '未识别版式',
  ambiguous: '多个版式同时匹配',
  failed: '识别失败',
  excludedCheck: '已排除：不参与盘点，也不进入材料包',
} as const;

const PHASES = { pdf: '读取 PDF 文本层与二维码', photo: '读取照片票面' } as const;

const EXCLUDE = { key: 'exclude', label: '排除这份材料' };
const REPLACE_HINT = '换原件请在上传页追加材料后重新盘点。';

function choice(itemId: string, materialId: string, title: string, why: string, choices: PendingItem['choices']): PendingItem {
  return { itemId, materialId, title, why, kind: 'choice', resolver: '要你处理', fields: [], choices, allocation: null, status: 'open', answer: null };
}

// The 待确认项 an outcome raises, and the material's check text.
function itemsOf(material: ViewMaterial, outcome: ParseOutcome): { items: PendingItem[]; checkText: string } {
  const id = material.materialId;
  const name = material.fileName;
  switch (outcome.outcome) {
    case 'unrecognised':
      return {
        items: [
          choice(`unrecognised.${id}`, id, `认不出「${name}」`, outcome.reason === 'unreadable_document' ? '这份文件读不出内容。' : '没有任何版式匹配这份材料。', [
            EXCLUDE,
            { key: 'reference', label: '作为参考材料' },
            { key: 'manual_fill', label: '手工补填' },
          ]),
        ],
        checkText: outcome.reason === 'unreadable_document' ? '读不出文件内容' : '没有匹配的版式',
      };
    case 'ambiguous':
      return {
        items: [
          choice(
            `ambiguous_layout.${id}`,
            id,
            `「${name}」同时匹配多个版式`,
            `同时匹配：${outcome.layouts.map((layout) => layout.label).join('、')}。系统不会替你挑一个，请选定版式或排除这份材料。`,
            [...outcome.layouts.map((layout) => ({ key: `layout:${layout.id}`, label: layout.label })), EXCLUDE],
          ),
        ],
        checkText: '同时匹配多个版式',
      };
    case 'failed':
      return {
        items: [choice(`parse_failed.${id}`, id, `「${name}」识别失败`, outcome.retryable ? '读取时出错，重新盘点可以再试一次。' : '这份材料读取出错。', [EXCLUDE])],
        checkText: outcome.retryable ? '读取出错，可重新盘点再试' : '读取出错',
      };
    case 'recognised':
      return recognisedItems(material, outcome);
  }
}

function recognisedItems(material: ViewMaterial, outcome: Recognised): { items: PendingItem[]; checkText: string } {
  const id = material.materialId;
  const items: PendingItem[] = [];
  const notes: string[] = [];
  for (const finding of outcome.findings) {
    if (finding.kind === 'advisory') notes.push(finding.message);
    if (finding.kind === 'validation') {
      notes.push(finding.message);
      items.push(choice(`validation_failure.${id}.${finding.code}`, id, `「${material.fileName}」金额核对不通过`, `${finding.message}票面事实不能修改。${REPLACE_HINT}`, [EXCLUDE]));
    }
    if (finding.kind === 'conflict') {
      const label = slotOf(outcome.kind, finding.key)?.label ?? finding.key;
      const [face, other] = finding.values;
      const message = `二维码与票面不一致：${label} 票面 ${face?.value ?? ''}，二维码 ${other?.value ?? ''}`;
      notes.push(message);
      items.push(choice(`qr_conflict.${id}.${finding.key}`, id, `「${material.fileName}」${label}与二维码不一致`, `${message}。票面事实不能修改。${REPLACE_HINT}`, [EXCLUDE]));
    }
  }
  if (outcome.missing.length > 0) {
    const fields: PendingField[] = outcome.missing.map((key) => {
      const slot = slotOf(outcome.kind, key);
      // `money` joins PendingField.format with #187; until then it is a text field.
      return { key, label: slot?.label ?? key, placeholder: '', required: true, format: slot?.format === 'date' ? 'date' : 'text' };
    });
    items.push({ itemId: `missing_required.${id}`, materialId: id, title: `「${material.fileName}」缺少字段`, why: '版式认出了这份材料，但有必填字段没读到，请对照原件补填。', kind: 'form', resolver: '要你处理', fields, choices: [], allocation: null, status: 'open', answer: null });
  }
  return { items, checkText: notes.join('；') };
}

const valuesOf = (outcome: Recognised): Record<string, string> => {
  const values: Record<string, string> = {};
  // The layout's own source first; a second source (QR) only fills what the face lacks.
  const primary = `rule:${outcome.kind}/${outcome.layout}`;
  for (const c of outcome.candidates) if (c.source === primary) values[c.key] ??= c.value;
  for (const c of outcome.candidates) values[c.key] ??= c.value;
  return values;
};

export function inventoryView(materials: readonly ViewMaterial[], results: RunResults): InventoryView {
  const pendingItems: PendingItem[] = [];
  const drafts: { material: ViewMaterial; draft: NonNullable<ReturnType<(typeof KINDS)['vat_invoice']['event']>> }[] = [];
  let waiting = 0;
  const waitingBy = { pdf: 0, image: 0 };

  const views = materials.map((m): Material => {
    const base: Material = {
      materialId: m.materialId,
      batchId: m.batchId,
      fileName: m.fileName,
      contentHash: m.contentHash,
      size: m.size,
      kind: null,
      layout: null,
      kindLabel: INVENTORY_COPY.uploaded,
      categoryLabel: null,
      role: 'uploaded',
      shape: m.mediaType === 'image' ? 'photo' : 'portrait',
      mediaType: m.mediaType,
      status: 'uploaded',
      checkText: '',
      linkedMaterialIds: [],
      pendingItemIds: [],
      originalUrl: null,
      previewUrl: null,
      fields: [],
    };
    const outcome = results?.outcomes.get(m.materialId);
    const recognised = outcome?.outcome === 'recognised' ? outcome : null;
    const identity = recognised ? { kind: recognised.kind, layout: recognised.layout, kindLabel: recognised.kindLabel } : {};
    if (m.excluded) return { ...base, ...identity, role: 'excluded', status: 'excluded', checkText: INVENTORY_COPY.excludedCheck };
    if (!results) return base;
    if (!outcome) {
      waiting += 1;
      waitingBy[m.mediaType] += 1;
      return base;
    }
    const { items, checkText } = itemsOf(m, outcome);
    pendingItems.push(...items);
    const status = items.length > 0 ? 'pending' : 'ok';
    if (!recognised) {
      const kindLabel = outcome.outcome === 'ambiguous' ? INVENTORY_COPY.ambiguous : outcome.outcome === 'failed' ? INVENTORY_COPY.failed : INVENTORY_COPY.unrecognised;
      return { ...base, kindLabel, role: 'pending', status: 'pending', checkText, pendingItemIds: items.map((item) => item.itemId) };
    }
    const spec = KINDS[recognised.kind];
    const values = valuesOf(recognised);
    if (status === 'ok' && spec.role === 'primary_voucher') {
      const draft = spec.event(values);
      if (draft) drafts.push({ material: m, draft });
    }
    return {
      ...base,
      ...identity,
      categoryLabel: spec.categoryLabel(values),
      role: status === 'ok' ? spec.role : 'pending',
      status,
      checkText,
      pendingItemIds: items.map((item) => item.itemId),
      fields: recognised.candidates.map((c) => ({ key: c.key, label: slotOf(recognised.kind, c.key)?.label ?? c.key, value: c.value, source: c.source, parserVersion: c.parserVersion, evidence: c.evidence })),
    };
  });

  // Business order (kernel confirmation table): local → out-of-town city transport → long distance → accommodation;
  // within a category, voucher upload order. Invoice labels follow voucher upload order.
  const rank = ['local_city_transport', 'city_transport', 'remote_city_transport', 'long_distance', 'accommodation'];
  const ordered = [...drafts].sort((a, b) => rank.indexOf(a.draft.category.code) - rank.indexOf(b.draft.category.code));
  const invoiceNo = new Map(drafts.map((d, index) => [d.material.materialId, index + 1]));
  const events: ExpenseEvent[] = [];
  const lines: Line[] = [];
  ordered.forEach(({ material, draft }, index) => {
    const eventId = `event.${material.materialId}`;
    events.push({ eventId, no: index + 1, voucherMaterialId: material.materialId, referenceMaterialIds: [], category: draft.category, summary: draft.summary, evidenceNote: null, date: draft.date, endDate: draft.endDate, city: null, origin: null, destination: null, grossAmount: draft.grossAmount });
    lines.push({
      lineId: `line.${material.materialId}`,
      no: index + 1,
      voucherMaterialId: material.materialId,
      invoiceLabel: `发票${invoiceNo.get(material.materialId)}`,
      eventId,
      date: draft.date,
      endDate: draft.endDate,
      category: draft.category,
      description: draft.description,
      city: null,
      origin: null,
      destination: null,
      route: null,
      maskedNumber: draft.maskedNumber,
      projectCode: null,
      projectName: null,
      expenseItemCode: null,
      expenseItemName: null,
      invoiceType: draft.invoiceType,
      referenceMaterialIds: [],
      grossAmount: draft.grossAmount,
      netAmount: draft.netAmount,
      taxAmount: draft.taxAmount,
    });
  });

  const included = views.filter((v) => v.status !== 'excluded');
  const grouped = new Set(events.map((e) => e.voucherMaterialId));
  const phase = (key: keyof typeof PHASES, status: InventoryPhase['status']): InventoryPhase => ({ key, label: PHASES[key], status });
  const hasImages = materials.some((m) => !m.excluded && m.mediaType === 'image');
  const phases = !results
    ? []
    : [
        phase('pdf', waitingBy.pdf > 0 ? 'running' : 'done'),
        ...(hasImages ? [phase('photo', waitingBy.pdf > 0 ? 'todo' : waitingBy.image > 0 ? 'running' : 'done')] : []),
      ];
  const done = results !== null && waiting === 0;
  const inventory: Inventory = {
    status: !results ? 'not_started' : done ? 'done' : 'running',
    versionId: null,
    phases,
    finishedAt: done ? (results?.finishedAt ?? results?.startedAt ?? null) : null,
    summary: done
      ? {
          materialCount: included.length,
          okCount: included.filter((v) => v.status === 'ok').length,
          pendingMaterialCount: included.filter((v) => v.status === 'pending').length,
          voucherCount: included.filter((v) => v.role === 'primary_voucher').length,
          referenceCount: included.filter((v) => v.role === 'reference').length,
          openPendingItemCount: pendingItems.length,
        }
      : null,
    ungroupedMaterialIds: done ? views.filter((v) => !grouped.has(v.materialId) && (v.status === 'excluded' || v.status === 'pending' || v.role !== 'primary_voucher')).map((v) => v.materialId) : [],
  };
  return { materials: views, pendingItems, events: done ? events : [], lines: done ? lines : [], inventory, waiting, openPendingItems: pendingItems.length };
}
