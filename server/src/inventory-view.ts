import { MATERIAL_KINDS, fieldAnswer, isAllocationAnswer, type ExpenseEvent, type FieldCandidate, type Inventory, type InventoryPhase, type Line, type Material, type MaterialKind, type PendingField, type PendingItem } from '@baox/contract';
import type { ParseOutcome, Recognised } from './parse/dispatch';
import { planTransport, type PlannedLine } from './allocation';
import { pairHotelStays } from './hotel-stay';
import { fieldLabel, KINDS, slotOf, type EventDraft, type Slot } from './parse/kinds';
import { chosen, EXCLUDE, givenUpOf, settle, type AnswerCheck, type Answerable, type StoredAnswers } from './pending/answers';
import { editAddress, editedValue, type Editable } from './pending/edits';
import { COMPANY_RULES, deriveCategory, type CompanyRules } from './rules/company-rules';
import { checkStayTrios, stayVoucherIds, type StayTrio, type TrioVoucher } from './stay-trio';

// The pure projection of one inventory run: uploaded materials, their parser outcomes and the stored answers in; the
// materials view, derived 待确认项 (pending items), expense events, candidate lines and inventory counts out. Nothing
// here is stored. Pending items are derived per run with stable ids `<code>.<materialId>[.<key>]`, which is the
// answer key `(kind, materialId, field|segment)`: a re-derived item meets its earlier answer (ADR-0014).
//
// Item codes: unrecognised → manual_kind → manual_fill (手工补填, manual fill), ambiguous_layout, parse_failed,
// validation_failure, missing_required, duplicate_invoice (重复发票 inside the task),
// category_city_missing (#188), stay_invoice_missing / stay_folio_missing / stay_screenshot_missing (the 住宿 trio,
// #213, `stay-trio.ts`); allocation, itinerary_ambiguous and given_up come from #184's transport plan
// (`allocation.ts`), answered generically (`pending/answers.ts`).

export type ViewMaterial = {
  materialId: string;
  batchId: string;
  fileName: string;
  contentHash: string;
  size: number;
  mediaType: 'pdf' | 'image';
  excluded: boolean;
  // Upload time: orders claims on an invoice identity (the earlier upload holds it).
  uploadedAt: string;
  // Global upload order (material rowid): breaks ties between uploads in the same second.
  uploadSeq: number;
};

// `results` is null when the current version has not been inventoried (before start-inventory, or after reopen-upload).
export type RunResults = { outcomes: ReadonlyMap<string, ParseOutcome>; startedAt: string; finishedAt: string | null } | null;

// A material's hold on an invoice identity: what 发票占用 (occupancy) compares across tasks.
export type Claim = { key: string; materialId: string; fileName: string; at: string; seq: number };

export type InventoryView = {
  materials: Material[];
  pendingItems: PendingItem[];
  events: ExpenseEvent[];
  lines: Line[];
  inventory: Inventory;
  // Included materials of the run still waiting for a parser outcome; > 0 means the job is running.
  waiting: number;
  openPendingItems: number;
  // Every derived item by id, with the check its answer must pass (`answer-pending`).
  answerables: ReadonlyMap<string, Answerable>;
  // Every editable field by edit address `edit.<materialId>.<field>`.
  editables: ReadonlyMap<string, Editable>;
  claims: Claim[];
  // The 住宿 trio of every stay, once the run has finished (`stay-trio.ts`); the print stage reads recorded absences here.
  trios: StayTrio[];
};

// The task's 常驻城市 and pinned company rules: categories are derived from them (ADR-0006).
export type CategoryContext = { homeCity: string; rules: CompanyRules };

export const INVENTORY_COPY = {
  uploaded: '待盘点',
  unrecognised: '未识别版式',
  ambiguous: '多个版式同时匹配',
  failed: '识别失败',
  excludedCheck: '已排除：不参与盘点，也不进入材料包',
  referenceCheck: '作为参考材料，不形成明细',
  manualCheck: '手工补填',
} as const;

const PHASES = { pdf: '读取 PDF 文本层与二维码', photo: '读取照片票面' } as const;

const REPLACE_HINT = '换原件请在上传页追加材料后重新盘点。';
const MANUAL_FILL = 'manual_fill';
const REFERENCE = 'reference';
const CITY_MISSING_CHECK = '取不到费用发生城市';
// A recognised material missing a required slot said nothing in the 校验 column, which rendered as 无; it now names the
// slots it could not read.
const MISSING_REQUIRED_CHECK = '缺少必填字段：';

// Titles of validation findings that are not about amounts (the default title is 金额核对不通过). A code may carry
// what it is about after a dot (`segment_field_unreadable.2.amount`) so that the message can name the leg and the
// field; the title, and the 待确认项 raised, are keyed on the part before the dot.
const VALIDATION_TITLES: Readonly<Record<string, string>> = {
  segment_rows_incomplete: '逐段明细没有完整读到',
  segment_index_unexpected: '逐段明细的序号不对',
  segment_field_unreadable: '逐段明细没有完整读到',
  route_incomplete: '行程路线没有完整读到',
};
const validationTitle = (code: string) => VALIDATION_TITLES[code.split('.')[0] ?? code] ?? '金额核对不通过';

// Line-level edits every kind with an event offers: the description is wording, the ERP invoice type a choice.
const DESCRIPTION = 'description';
const ERP_INVOICE_TYPE = 'erpInvoiceType';

type Values = Record<string, string>;
type Resolved = Omit<Recognised, 'outcome' | 'layout' | 'parserVersion'> & { layout: string | null; parserVersion: string | null };

type Worked = {
  m: ViewMaterial;
  items: PendingItem[];
  resolved: Resolved | null;
  reference: boolean;
  values: Values;
  fields: FieldCandidate[];
  notes: string[];
  kindLabel: string;
};

function choice(itemId: string, materialId: string, title: string, why: string, choices: PendingItem['choices']): PendingItem {
  return { itemId, materialId, title, why, kind: 'choice', resolver: '要你处理', fields: [], choices, allocation: null, status: 'open', answer: null };
}

function form(itemId: string, materialId: string, title: string, why: string, fields: PendingField[]): PendingItem {
  return { itemId, materialId, title, why, kind: 'form', resolver: '要你处理', fields, choices: [], allocation: null, status: 'open', answer: null };
}

const pendingField = (slot: Slot): PendingField => ({ key: slot.key, label: slot.label, placeholder: '', required: slot.required, format: slot.format });

const nonEmpty = (values: Readonly<Record<string, string>>): Values => Object.fromEntries(Object.entries(values).filter(([, value]) => value !== ''));

const isOpen = (item: PendingItem) => item.status === 'open';

// The layout's own source first; a second source (QR) only fills what the face lacks.
function valuesOf(resolved: Resolved): Values {
  const values: Values = {};
  const primary = resolved.layout ? `rule:${resolved.kind}/${resolved.layout}` : 'user';
  for (const c of resolved.candidates) if (c.source === primary && c.value !== '') values[c.key] ??= c.value;
  for (const c of resolved.candidates) if (c.value !== '') values[c.key] ??= c.value;
  return values;
}

// Per invoice materialId, the per-leg totals stored on its `allocation.<materialId>` item. `allocate` (allocation.ts)
// adopts them only when they conserve to the cent — the same `conservingLegs` rule `judgeAnswer` applies on submit.
function allocationAnswers(answers: StoredAnswers): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const [itemId, answer] of answers) {
    if (itemId.startsWith('allocation.') && isAllocationAnswer(answer) && 'amounts' in answer) found.set(itemId.slice('allocation.'.length), answer.amounts.map((amount) => amount.trim()));
  }
  return found;
}

const MANUAL_KINDS = MATERIAL_KINDS.filter((kind) => KINDS[kind].slots.length > 0);

// Derives one material's items, settling each against the stored answers as it goes: a later item exists only once the
// earlier one is answered (unrecognised → pick a kind → fill its form).
function work(m: ViewMaterial, outcome: ParseOutcome, answers: StoredAnswers, answerables: Map<string, Answerable>, editables: Map<string, Editable>): Worked {
  const id = m.materialId;
  const name = m.fileName;
  const w: Worked = { m, items: [], resolved: null, reference: false, values: {}, fields: [], notes: [], kindLabel: INVENTORY_COPY.unrecognised };
  const add = (item: PendingItem, check?: AnswerCheck): PendingItem => {
    const settled = settle(item, answers, check);
    answerables.set(item.itemId, check ? { item: settled, check } : { item: settled });
    w.items.push(settled);
    return settled;
  };

  switch (outcome.outcome) {
    case 'unrecognised': {
      const unreadable = outcome.reason === 'unreadable_document';
      w.notes.push(unreadable ? '读不出文件内容' : '没有匹配的版式');
      const first = add(
        choice(`unrecognised.${id}`, id, `认不出「${name}」`, unreadable ? '这份文件读不出内容。' : '没有任何版式匹配这份材料。', [
          EXCLUDE,
          { key: REFERENCE, label: '作为参考材料' },
          { key: MANUAL_FILL, label: '手工补填' },
        ]),
      );
      if (chosen(first) === REFERENCE) w.reference = true;
      if (chosen(first) === MANUAL_FILL) {
        const picking = add(
          choice(`manual_kind.${id}`, id, `「${name}」是哪一种材料`, '选定材料种类后，对照原件逐项填写这个种类的字段；填写的值同样要通过核对。', [
            ...MANUAL_KINDS.map((kind) => ({ key: `kind:${kind}`, label: KINDS[kind].label })),
            EXCLUDE,
          ]),
        );
        const picked = chosen(picking)?.replace(/^kind:/, '') as MaterialKind | undefined;
        if (picked && MANUAL_KINDS.includes(picked)) {
          const spec = KINDS[picked];
          const filled = add(
            form(`manual_fill.${id}`, id, `手工补填「${name}」`, `按${spec.label}的字段对照原件填写。系统不会倒算任何金额。`, spec.slots.map(pendingField)),
            (answer) => spec.check?.(nonEmpty(fieldAnswer(answer))) ?? null,
          );
          if (filled.status === 'resolved') {
            const values = nonEmpty(fieldAnswer(filled.answer));
            w.resolved = {
              kind: picked,
              layout: null,
              parserVersion: null,
              kindLabel: `${spec.label}（手工补填）`,
              candidates: Object.entries(values).map(([key, value]) => ({ key, value, source: 'user', parserVersion: '', evidence: 'explicit', refs: [] })),
              findings: [],
              missing: [],
            };
            w.notes.splice(0, w.notes.length, INVENTORY_COPY.manualCheck);
          }
        }
      }
      break;
    }
    case 'ambiguous': {
      w.kindLabel = INVENTORY_COPY.ambiguous;
      w.notes.push('同时匹配多个版式');
      const layoutOf = (key: string | undefined) => (key?.startsWith('layout:') ? outcome.layouts.find((layout) => layout.id === key.slice('layout:'.length)) : undefined);
      const first = add(
        choice(
          `ambiguous_layout.${id}`,
          id,
          `「${name}」同时匹配多个版式`,
          `同时匹配：${outcome.layouts.map((layout) => layout.label).join('、')}。系统不会替你挑一个，请选定版式或排除这份材料。`,
          [...outcome.layouts.map((layout) => ({ key: `layout:${layout.id}`, label: layout.label })), EXCLUDE],
        ),
        (answer) => {
          const key = fieldAnswer(answer)['choice'];
          return key?.startsWith('layout:') && !layoutOf(key)?.recognised ? '这次盘点没有保留这个版式的读取结果，请重新盘点后再选。' : null;
        },
      );
      const picked = layoutOf(chosen(first))?.recognised;
      if (picked) {
        w.resolved = picked;
        w.notes.length = 0;
      }
      break;
    }
    case 'failed':
      w.kindLabel = INVENTORY_COPY.failed;
      // A retryable read error is worth another run, but this item cannot start one: the only choice it offers is
      // exclude. Name the path that does work (reopen upload, then start 材料盘点 again) instead of promising a retry
      // that is not on offer here.
      w.notes.push(outcome.retryable ? '读取出错，重新打开上传后可以再盘点一次' : '读取出错');
      add(
        choice(
          `parse_failed.${id}`,
          id,
          `「${name}」识别失败`,
          outcome.retryable
            ? '读取这份材料时出错。要再试一次，请回到上传页「重新打开上传」，然后重新开始材料盘点；也可以在这里排除它。'
            : '这份材料读取出错。',
          [EXCLUDE],
        ),
      );
      break;
    case 'recognised':
      w.resolved = outcome;
      break;
  }
  if (w.resolved) recognisedItems(w, w.resolved, answers, add, editables);
  return w;
}

function recognisedItems(w: Worked, resolved: Resolved, answers: StoredAnswers, add: (item: PendingItem, check?: AnswerCheck) => PendingItem, editables: Map<string, Editable>) {
  const { m } = w;
  const id = m.materialId;
  const spec = KINDS[resolved.kind];
  w.kindLabel = resolved.kindLabel;
  const values = valuesOf(resolved);
  const sourceOf = new Map<string, { source: string; parserVersion: string | null; evidence: FieldCandidate['evidence'] }>();
  for (const c of resolved.candidates) if (!sourceOf.has(c.key) || c.source === `rule:${resolved.kind}/${resolved.layout}`) sourceOf.set(c.key, { source: c.source, parserVersion: c.source === 'user' ? null : c.parserVersion, evidence: c.evidence });
  // A face fact from a PDF text layer or QR is locked; OCR (photos), manual values and gaps are correctable. A value
  // a layout derives from other face facts (e.g. 离店日期 from 入住日期 + 天数) is a reading, not printed: correctable.
  const derived = (key: string) => /^rule:[^/]+\/[^.]+\./.test(sourceOf.get(key)?.source ?? '');
  const classOf = (key: string) => (values[key] === undefined || sourceOf.get(key)?.source === 'user' || m.mediaType === 'image' || derived(key) ? 'fact_correctable' : 'fact_locked');
  const withValue = (key: string, value: string) => spec.check?.({ ...values, [key]: value }) ?? null;

  // Slot edits: corrections of correctable facts become `user` values before anything is checked or derived.
  for (const slot of spec.slots) {
    const editable: Editable = { address: editAddress(id, slot.key), materialId: id, field: slot.key, label: slot.label, editClass: classOf(slot.key), format: slot.format, allowed: null, check: (value) => withValue(slot.key, value) };
    editables.set(editable.address, editable);
    const edited = editedValue(editable, answers.get(editable.address));
    if (edited !== null) {
      values[slot.key] = edited;
      sourceOf.set(slot.key, { source: 'user', parserVersion: null, evidence: 'explicit' });
    }
  }

  // One blocker per material and cause. A per-leg refusal reports itself in its own message — an itinerary with a gap
  // in the middle refuses every leg after it — but each of those messages would otherwise become its own 待确认项 with
  // the same title and the same single action (排除), and 待确认项 is what the user is asked to work through. Every
  // message is still kept as a note.
  const raised = new Set<string>();
  for (const finding of resolved.findings) {
    if (finding.kind === 'advisory') w.notes.push(finding.message);
    if (finding.kind === 'validation') {
      w.notes.push(finding.message);
      const cause = finding.code.split('.')[0] ?? finding.code;
      if (!raised.has(cause)) {
        raised.add(cause);
        add(choice(`validation_failure.${id}.${cause}`, id, `「${m.fileName}」${validationTitle(cause)}`, `${finding.message}票面事实不能修改。${REPLACE_HINT}`, [EXCLUDE]));
      }
    }
  }

  // Gaps of a recognised material use the manual-fill form with just the missing slots.
  const missing = resolved.missing.filter((key) => values[key] === undefined);
  if (missing.length > 0) {
    const slots = missing.map((key) => slotOf(resolved.kind, key) ?? { key, label: key, required: true, format: 'text' as const });
    const filled = add(
      form(`missing_required.${id}`, id, `「${m.fileName}」缺少字段`, '版式认出了这份材料，但有必填字段没读到，请对照原件补填。', slots.map((slot) => ({ ...pendingField(slot), required: true }))),
      (answer) => spec.check?.({ ...values, ...nonEmpty(fieldAnswer(answer)) }) ?? null,
    );
    if (filled.status === 'resolved') {
      for (const [key, value] of Object.entries(nonEmpty(fieldAnswer(filled.answer)))) {
        values[key] = value;
        sourceOf.set(key, { source: 'user', parserVersion: null, evidence: 'explicit' });
      }
      // Filled in: the gap is gone, so it is no longer what the 校验 column has to say.
    } else {
      w.notes.push(`${MISSING_REQUIRED_CHECK}${slots.map((slot) => slot.label).join('、')}`);
    }
  }

  w.values = values;
  // Every source's candidates stay visible (text layer and QR side by side); a `user` value replaces the candidates of
  // its key, since it is what counts now.
  const label = (key: string) => fieldLabel(resolved.kind, key);
  const byUser = [...sourceOf].filter(([, origin]) => origin.source === 'user').map(([key]) => key);
  w.fields = [
    ...resolved.candidates
      .filter((c) => c.source !== 'user' && !byUser.includes(c.key))
      .map((c): FieldCandidate => ({ key: c.key, label: label(c.key), value: c.value, source: c.source, parserVersion: c.parserVersion, evidence: c.evidence, editClass: classOf(c.key) })),
    ...byUser.map((key): FieldCandidate => ({ key, label: label(key), value: values[key] ?? '', source: 'user', parserVersion: null, evidence: 'explicit', editClass: 'fact_correctable' })),
  ];
}

// `answers`: the latest stored answer per item id / edit address (#187), allocation answers included — they reach
// #184's per-leg split through `planTransport`. `screenshots`: the voucher material ids that have a current 支付截图.
export function inventoryView(
  materials: readonly ViewMaterial[],
  results: RunResults,
  { homeCity, rules }: CategoryContext = { homeCity: '', rules: COMPANY_RULES },
  answers: StoredAnswers = new Map(),
  screenshots: ReadonlySet<string> = new Set(),
): InventoryView {
  const answerables = new Map<string, Answerable>();
  const editables = new Map<string, Editable>();
  let waiting = 0;
  const waitingBy = { pdf: 0, image: 0 };

  const worked: Worked[] = [];
  for (const m of materials) {
    if (m.excluded || !results) continue;
    const outcome = results.outcomes.get(m.materialId);
    if (!outcome) {
      waiting += 1;
      waitingBy[m.mediaType] += 1;
      continue;
    }
    worked.push(work(m, outcome, answers, answerables, editables));
  }

  // 重复发票 inside the task: the earlier upload holds the identity; each later one must go (exclusion), be replaced
  // (a new upload and run) or have its identity corrected (a correctable invoice number).
  const claims: Claim[] = [];
  const holder = new Map<string, Worked>();
  for (const w of worked) {
    const key = w.resolved && !w.reference ? KINDS[w.resolved.kind].identity?.(w.values) : null;
    if (!key) continue;
    const first = holder.get(key);
    if (!first) {
      holder.set(key, w);
      claims.push({ key, materialId: w.m.materialId, fileName: w.m.fileName, at: w.m.uploadedAt, seq: w.m.uploadSeq });
      continue;
    }
    const item = settle(
      choice(
        `duplicate_invoice.${w.m.materialId}`,
        w.m.materialId,
        `「${w.m.fileName}」与「${first.m.fileName}」是同一张发票`,
        `两份材料的发票身份相同（${key}）。同一张发票不能报两次：排除其中一份；${REPLACE_HINT}手工补填或照片读出的发票号码可以更正。`,
        [EXCLUDE],
      ),
      answers,
    );
    answerables.set(item.itemId, { item });
    w.items.push(item);
    w.notes.push('重复发票');
  }

  // Invoice ↔ itinerary pairing, per-leg lines and allocation items (#184), over the resolved included materials.
  const transport = planTransport(
    worked.flatMap((w) =>
      w.resolved && !w.reference ? [{ materialId: w.m.materialId, fileName: w.m.fileName, kind: w.resolved.kind, layout: w.resolved.layout ?? '', values: w.values, ok: !w.items.some(isOpen) }] : [],
    ),
    allocationAnswers(answers),
  );
  for (const w of worked) {
    for (const item of transport.items.get(w.m.materialId) ?? []) {
      // Stored per-leg amounts were already offered to `allocate`; an allocation item still derived despite them stays
      // open. Only a give-up (or a choice) settles here, leaving its blocking given_up item.
      const stored = answers.get(item.itemId);
      const settled = item.kind === 'allocation' && stored && isAllocationAnswer(stored) && 'amounts' in stored ? item : settle(item, answers);
      answerables.set(item.itemId, { item: settled });
      w.items.push(settled);
      const givenUp = givenUpOf(settled);
      if (givenUp) {
        answerables.set(givenUp.itemId, { item: givenUp });
        w.items.push(givenUp);
      }
    }
    const note = transport.notes.get(w.m.materialId);
    if (note) w.notes.push(note);
  }

  const views = new Map<string, Material>();
  const drafts: ({ material: ViewMaterial } & PlannedLine)[] = [];
  const pendingItems: PendingItem[] = [];
  const folios: TrioVoucher[] = [];
  for (const w of worked) {
    const { m, resolved } = w;
    const spec = resolved ? KINDS[resolved.kind] : null;
    if (spec && !w.items.some(isOpen) && !w.reference && spec.role === 'primary_voucher') {
      // A paired ride-hailing invoice forms one line per itinerary leg (#184); any other voucher its kind's single event.
      const planned = transport.lines.get(m.materialId);
      const single = planned ? null : spec.event(w.values);
      const candidates: PlannedLine[] = planned ?? (single ? [{ draft: single, leg: null, referenceMaterialIds: [], evidenceNote: single.evidenceNote ?? null }] : []);
      const categorised = candidates.map((line) => ({ line, derived: deriveCategory(line.draft.category, line.draft.city ?? null, homeCity, rules) }));
      if (categorised.every(({ derived }) => 'category' in derived)) {
        const allowedTypes = spec.erpInvoiceTypes?.(w.values);
        for (const { line, derived } of categorised) {
          if (!('category' in derived)) continue;
          const draft = lineEdits(m.materialId, allowedTypes ?? [line.draft.invoiceType], { ...line.draft, category: derived.category }, answers, editables);
          drafts.push({ material: m, ...line, draft });
        }
      } else {
        // Kernel category_city_missing: city transport is never put on the home city for want of its own city.
        const item = settle(
          choice(`category_city_missing.${m.materialId}`, m.materialId, `「${m.fileName}」取不到费用发生城市`, '市内交通要按费用发生城市与常驻城市比对，才能分出本地还是外地；这张发票上没有城市，不能拿常驻城市顶替。请在上传页追加它的行程单后重新盘点，或排除这份材料。', [EXCLUDE]),
          answers,
        );
        answerables.set(item.itemId, { item });
        w.items.push(item);
        w.notes.push(CITY_MISSING_CHECK);
      }
    }
    const open = w.items.some(isOpen);
    if (!open && !w.reference && resolved?.kind === 'hotel_folio') folios.push({ materialId: m.materialId, fileName: m.fileName, values: w.values });
    pendingItems.push(...w.items);
    const role = open ? 'pending' : w.reference ? 'reference' : spec ? spec.role : 'pending';
    views.set(m.materialId, {
      ...baseMaterial(m),
      kind: resolved?.kind ?? null,
      layout: resolved?.layout ?? null,
      kindLabel: w.kindLabel,
      categoryLabel: spec ? spec.categoryLabel(w.values) : null,
      role,
      status: open ? 'pending' : 'ok',
      checkText: (w.reference ? [...w.notes, INVENTORY_COPY.referenceCheck] : w.notes).join('；'),
      linkedMaterialIds: transport.links.get(m.materialId) ?? [],
      pendingItemIds: w.items.map((item) => item.itemId),
      fields: w.fields,
    });
  }

  // Business order (kernel confirmation table): local → out-of-town city transport → long distance → accommodation;
  // within a category, voucher upload order. Invoice labels follow voucher upload order.
  const rank = ['local_city_transport', 'remote_city_transport', 'long_distance', 'accommodation'];
  const ordered = [...drafts].sort((a, b) => rank.indexOf(a.draft.category.code) - rank.indexOf(b.draft.category.code));

  // The 住宿 invoices are the vouchers the print stage will compose as 住宿 pages, chosen by the same rule.
  const stayIds = stayVoucherIds(ordered.map(({ material, draft }) => ({ voucherMaterialId: material.materialId, category: draft.category })));
  const stayInvoices: TrioVoucher[] = worked.flatMap((w) => (stayIds.has(w.m.materialId) ? [{ materialId: w.m.materialId, fileName: w.m.fileName, values: w.values }] : []));

  // Pairing: a hotel invoice and its folio form one stay (`hotel-stay.ts`).
  const stays = new Map(pairHotelStays(stayInvoices, folios).map((stay) => [stay.invoiceId, stay]));
  const linked = new Map<string, string[]>([...stays.values()].flatMap((stay) => [[stay.invoiceId, [stay.folioId]], [stay.folioId, [stay.invoiceId]]]));

  // The 住宿 trio (#213), only over a finished run: a folio still being read is not yet missing.
  const trio = results && waiting === 0 ? checkStayTrios(stayInvoices, folios, [...stays.values()], screenshots, answers) : { trios: [], items: new Map<string, PendingItem[]>() };
  for (const items of trio.items.values()) {
    for (const item of items) answerables.set(item.itemId, { item });
    pendingItems.push(...items);
  }

  const materialViews = materials.map((m): Material => {
    const outcome = results?.outcomes.get(m.materialId);
    const recognised = outcome?.outcome === 'recognised' ? outcome : null;
    if (m.excluded) {
      const identity = recognised ? { kind: recognised.kind, layout: recognised.layout, kindLabel: recognised.kindLabel } : {};
      return { ...baseMaterial(m), ...identity, role: 'excluded', status: 'excluded', checkText: INVENTORY_COPY.excludedCheck };
    }
    const view = views.get(m.materialId) ?? baseMaterial(m);
    // A trio item sits on a material that is otherwise clean: it keeps its role, but is pending while the item is open.
    const trioItems = trio.items.get(m.materialId) ?? [];
    return {
      ...view,
      status: trioItems.some(isOpen) ? 'pending' : view.status,
      pendingItemIds: [...view.pendingItemIds, ...trioItems.map((item) => item.itemId)],
      linkedMaterialIds: linked.get(m.materialId) ?? view.linkedMaterialIds,
    };
  });

  const invoiceNo = new Map([...new Set(drafts.map((d) => d.material.materialId))].map((id, index) => [id, index + 1]));
  const events: ExpenseEvent[] = [];
  const lines: Line[] = [];
  ordered.forEach(({ material, draft: own, leg, referenceMaterialIds: legReferences, evidenceNote: legNote }, index) => {
    // One line per leg of a split invoice: `<materialId>.<leg>` (1-based leg).
    const key = leg === null ? material.materialId : `${material.materialId}.${leg}`;
    const eventId = `event.${key}`;
    const stay = stays.get(material.materialId);
    const draft = stay ? { ...own, date: stay.checkIn, endDate: stay.checkOut } : own;
    const referenceMaterialIds = stay ? [stay.folioId] : legReferences;
    const trip = { city: draft.city ?? null, origin: draft.origin ?? null, destination: draft.destination ?? null };
    events.push({ eventId, no: index + 1, voucherMaterialId: material.materialId, referenceMaterialIds, category: draft.category, summary: draft.summary, evidenceNote: stay?.note ?? legNote, date: draft.date, endDate: draft.endDate, ...trip, grossAmount: draft.grossAmount });
    lines.push({
      lineId: `line.${key}`,
      no: index + 1,
      voucherMaterialId: material.materialId,
      invoiceLabel: `发票${invoiceNo.get(material.materialId)}`,
      eventId,
      date: draft.date,
      endDate: draft.endDate,
      category: draft.category,
      description: draft.description,
      ...trip,
      route: draft.route ?? null,
      maskedNumber: draft.maskedNumber,
      projectCode: null,
      projectName: null,
      expenseItemCode: null,
      expenseItemName: null,
      invoiceType: draft.invoiceType,
      referenceMaterialIds,
      grossAmount: draft.grossAmount,
      netAmount: draft.netAmount,
      taxAmount: draft.taxAmount,
    });
  });

  const openPendingItems = pendingItems.filter(isOpen).length;
  const included = materialViews.filter((v) => v.status !== 'excluded');
  const grouped = new Set(events.flatMap((e) => [e.voucherMaterialId, ...e.referenceMaterialIds]));
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
          openPendingItemCount: openPendingItems,
        }
      : null,
    ungroupedMaterialIds: done ? materialViews.filter((v) => !grouped.has(v.materialId) && (v.status === 'excluded' || v.status === 'pending' || v.role !== 'primary_voucher')).map((v) => v.materialId) : [],
  };
  return { materials: materialViews, pendingItems, events: done ? events : [], lines: done ? lines : [], inventory, waiting, openPendingItems, answerables, editables, claims, trios: trio.trios };
}

// The line-level edits: a presentation value over the description (checks never read it), and the ERP invoice type
// among the allowed values.
function lineEdits(materialId: string, allowedTypes: readonly string[], draft: EventDraft, answers: StoredAnswers, editables: Map<string, Editable>): EventDraft {
  const description: Editable = { address: editAddress(materialId, DESCRIPTION), materialId, field: DESCRIPTION, label: '明细描述', editClass: 'presentation', format: 'text', allowed: null };
  const invoiceType: Editable = { address: editAddress(materialId, ERP_INVOICE_TYPE), materialId, field: ERP_INVOICE_TYPE, label: '报销系统发票类型', editClass: 'choice', format: 'text', allowed: allowedTypes };
  for (const editable of [description, invoiceType]) editables.set(editable.address, editable);
  return {
    ...draft,
    description: editedValue(description, answers.get(description.address)) ?? draft.description,
    invoiceType: editedValue(invoiceType, answers.get(invoiceType.address)) ?? draft.invoiceType,
  };
}

function baseMaterial(m: ViewMaterial): Material {
  return {
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
}
