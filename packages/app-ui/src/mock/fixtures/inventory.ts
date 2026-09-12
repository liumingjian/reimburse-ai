import { PENDING_CHOICE_KEY, type ExpenseCategory, type ExpenseEvent, type FieldCandidate, type Line, type Material, type PendingItem, type TaskSnapshot } from '../../contract/snapshot';
import type { PendingAnswer } from '../../contract/actions';

// 盘点结果夹具：11 份材料的识别结果、9 个费用事件、3 个待确认项，以及答复后的候选明细。
// 数字与人物沿用原型；文件对应 fixtures/generated/ 里由脚本生成的示例原件（fixtures/scripts/data.mjs 是同一份数据）。
// mock 服务端按文件名把上传的材料对到这里的档案；对不上的材料形成「不支持的材料类型」待确认项。

export const INVENTORY_PHASES: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'hash', label: '核对材料内容哈希' },
  { key: 'pdf', label: '读取 PDF 文本层与二维码' },
  { key: 'photo', label: '读取照片票面' },
  { key: 'link', label: '关联参考材料并核对金额守恒' },
  { key: 'events', label: '划分费用事件与待确认项' },
];

export const FIXTURE_URL_BASE = 'fixtures/';

const CATEGORY: Readonly<Record<'accommodation' | 'long_distance' | 'remote_city_transport', ExpenseCategory>> = {
  accommodation: { code: 'accommodation', label: '住宿' },
  long_distance: { code: 'long_distance', label: '长途交通' },
  remote_city_transport: { code: 'remote_city_transport', label: '外地市内交通' },
};

const field = (key: string, label: string, value: string, source: string, evidence: FieldCandidate['evidence'] = 'explicit'): FieldCandidate => ({
  key,
  label,
  value,
  source,
  evidence,
});

type Profile = {
  fileName: string;
  file: string;
  kindLabel: string;
  categoryLabel: string | null;
  role: Material['role'];
  shape: Material['shape'];
  mediaType: Material['mediaType'];
  status: Material['status'];
  checkText: string;
  linked: readonly string[];
  fields: FieldCandidate[];
};

const RULE = {
  vat: 'rule:vat_invoice',
  folio: 'rule:hotel_folio',
  passenger: 'rule:passenger_transport',
  amap: 'rule:amap_itinerary',
  caocao: 'rule:caocao_itinerary',
  rail: 'rule:rail_eticket',
  taxi: 'rule:taxi_receipt',
} as const;

// 以夹具材料 id（m01…m11）为键的识别档案。
export const PROFILES: Readonly<Record<string, Profile>> = {
  m01: {
    fileName: '全季酒店_发票.pdf',
    file: 'm01-hotel-invoice.pdf',
    kindLabel: '全电专票',
    categoryLabel: '住宿',
    role: 'primary_voucher',
    shape: 'portrait',
    mediaType: 'pdf',
    status: 'ok',
    checkText: '二维码核对一致：号码、日期、价税合计、专票',
    linked: ['m02'],
    fields: [
      field('invoiceNumber', '发票号码', '26312000000098127734', RULE.vat),
      field('issueDate', '开票日期', '2026-08-22', RULE.vat),
      field('totalAmount', '价税合计', '3640.00', RULE.vat),
      field('netAmount', '不含税金额', '3433.96', RULE.vat),
      field('taxAmount', '税额', '206.04', RULE.vat),
      field('sellerName', '销售方', '上海某某酒店管理有限公司', RULE.vat),
    ],
  },
  m02: {
    fileName: '全季酒店_结账单.pdf',
    file: 'm02-hotel-folio.pdf',
    kindLabel: '结账单（全季版式）',
    categoryLabel: '住宿',
    role: 'reference',
    shape: 'portrait',
    mediaType: 'pdf',
    status: 'ok',
    checkText: '消费合计 = 发票价税合计；13 天 = 08-09 入住至 08-22 离店',
    linked: ['m01'],
    fields: [
      field('checkIn', '入住日期', '2026-08-09', RULE.folio),
      field('checkOut', '离店日期', '2026-08-22', RULE.folio),
      field('nights', '天数', '13', RULE.folio, 'derived'),
      field('folioTotal', '消费合计', '3640.00', RULE.folio),
    ],
  },
  m03: {
    fileName: '高德打车_发票.pdf',
    file: 'm03-amap-invoice.pdf',
    kindLabel: '旅客运输电子发票（普票）',
    categoryLabel: '网约车',
    role: 'primary_voucher',
    shape: 'portrait',
    mediaType: 'pdf',
    status: 'ok',
    checkText: '二维码核对一致；与行程单价税合计一一对应',
    linked: ['m04'],
    fields: [
      field('invoiceNumber', '发票号码', '26312000000101557402', RULE.passenger),
      field('issueDate', '开票日期', '2026-08-13', RULE.passenger),
      field('totalAmount', '价税合计', '69.19', RULE.passenger),
      field('netAmount', '不含税金额', '67.18', RULE.passenger),
      field('taxAmount', '税额', '2.01', RULE.passenger),
    ],
  },
  m04: {
    fileName: '高德打车_行程单.pdf',
    file: 'm04-amap-itinerary.pdf',
    kindLabel: '高德行程单',
    categoryLabel: '网约车',
    role: 'reference',
    shape: 'portrait',
    mediaType: 'pdf',
    status: 'ok',
    checkText: '26.69 + 20.85 + 21.65 = 69.19，按分守恒',
    linked: ['m03'],
    fields: [
      field('segmentCount', '行程数', '3', RULE.amap),
      field('itineraryTotal', '金额合计', '69.19', RULE.amap),
      field('phone', '行程人手机', '138****4021', RULE.amap),
    ],
  },
  m05: {
    fileName: '曹操出行_发票.pdf',
    file: 'm05-caocao-invoice.pdf',
    kindLabel: '旅客运输电子发票（普票）',
    categoryLabel: '网约车',
    role: 'primary_voucher',
    shape: 'portrait',
    mediaType: 'pdf',
    status: 'ok',
    checkText: '二维码核对一致；金额按「价税合计（小写）」标签取值，跳过折扣行',
    linked: ['m06'],
    fields: [
      field('invoiceNumber', '发票号码', '26312000000099830115', RULE.passenger),
      field('issueDate', '开票日期', '2026-08-11', RULE.passenger),
      field('totalAmount', '价税合计', '38.40', RULE.passenger),
      field('netAmount', '不含税金额', '37.28', RULE.passenger),
      field('taxAmount', '税额', '1.12', RULE.passenger),
    ],
  },
  m06: {
    fileName: '曹操出行_行程单.pdf',
    file: 'm06-caocao-itinerary.pdf',
    kindLabel: '曹操行程单',
    categoryLabel: '网约车',
    role: 'reference',
    shape: 'portrait',
    mediaType: 'pdf',
    status: 'ok',
    checkText: '1 段行程，金额 38.40 与发票一致',
    linked: ['m05'],
    fields: [
      field('segmentCount', '行程数', '1', RULE.caocao),
      field('itineraryTotal', '金额合计', '38.40', RULE.caocao),
      field('phone', '行程人手机', '138****4021', RULE.caocao),
    ],
  },
  m07: {
    fileName: '铁路电子客票_0809.pdf',
    file: 'm07-rail-0809.pdf',
    kindLabel: '铁路电子客票',
    categoryLabel: '高铁',
    role: 'primary_voucher',
    shape: 'landscape',
    mediaType: 'pdf',
    status: 'ok',
    checkText: '全角字符已规范化；无需参考材料',
    linked: [],
    fields: [
      field('travelDate', '乘车日期', '2026-08-09', RULE.rail),
      field('trainNumber', '车次', 'G7522', RULE.rail),
      field('route', '区间', '杭州东 → 上海虹桥', RULE.rail),
      field('totalAmount', '票价', '73.00', RULE.rail),
      field('taxAmount', '税额', '0.00', RULE.rail, 'derived'),
    ],
  },
  m08: {
    fileName: '铁路电子客票_0822.pdf',
    file: 'm08-rail-0822.pdf',
    kindLabel: '铁路电子客票',
    categoryLabel: '高铁',
    role: 'primary_voucher',
    shape: 'landscape',
    mediaType: 'pdf',
    status: 'ok',
    checkText: '全角字符已规范化；无需参考材料',
    linked: [],
    fields: [
      field('travelDate', '乘车日期', '2026-08-22', RULE.rail),
      field('trainNumber', '车次', 'G7539', RULE.rail),
      field('route', '区间', '上海虹桥 → 杭州东', RULE.rail),
      field('totalAmount', '票价', '73.00', RULE.rail),
      field('taxAmount', '税额', '0.00', RULE.rail, 'derived'),
    ],
  },
  m09: {
    fileName: 'IMG_4871.jpg',
    file: 'm09-taxi-photo.jpg',
    kindLabel: '出租车车费发票（照片）',
    categoryLabel: '出租车',
    role: 'primary_voucher',
    shape: 'photo',
    mediaType: 'image',
    status: 'pending',
    checkText: '已裁边并透视矫正；票面读数清晰；城市由发票代码 131 推断为上海',
    linked: [],
    fields: [
      field('invoiceCode', '发票代码', '131002325021', RULE.taxi),
      field('invoiceNumber', '发票号码', '04213377', RULE.taxi),
      field('travelDate', '日期', '2026-08-15', RULE.taxi),
      field('boardTime', '上车时间', '09:06', RULE.taxi),
      field('alightTime', '下车时间', '09:31', RULE.taxi),
      field('distance', '里程', '8.6 km', RULE.taxi),
      field('totalAmount', '金额', '32.00', RULE.taxi),
      field('city', '城市', '上海', RULE.taxi, 'derived'),
      field('origin', '起点', '', RULE.taxi, 'missing'),
      field('destination', '终点', '', RULE.taxi, 'missing'),
    ],
  },
  m10: {
    fileName: 'IMG_4906.jpg',
    file: 'm10-taxi-photo.jpg',
    kindLabel: '出租车车费发票（照片）',
    categoryLabel: '出租车',
    role: 'primary_voucher',
    shape: 'photo',
    mediaType: 'image',
    status: 'pending',
    checkText: '票面年份「26」已补全为 2026；下车时间读数不合法',
    linked: [],
    fields: [
      field('invoiceCode', '发票代码', '131002325021', RULE.taxi),
      field('invoiceNumber', '发票号码', '04219052', RULE.taxi),
      field('travelDate', '日期', '2026-08-19', RULE.taxi, 'derived'),
      field('boardTime', '上车时间', '18:42', RULE.taxi),
      field('alightTime', '下车时间', '90:60', RULE.taxi, 'ambiguous'),
      field('distance', '里程', '12.3 km', RULE.taxi),
      field('totalAmount', '金额', '47.00', RULE.taxi),
      field('city', '城市', '上海', RULE.taxi, 'derived'),
      field('origin', '起点', '', RULE.taxi, 'missing'),
      field('destination', '终点', '', RULE.taxi, 'missing'),
    ],
  },
  m11: {
    fileName: '餐饮_发票.pdf',
    file: 'm11-other-invoice.pdf',
    kindLabel: '未识别版式',
    categoryLabel: null,
    role: 'pending',
    shape: 'portrait',
    mediaType: 'pdf',
    status: 'pending',
    checkText: '不属于住宿、网约车、高铁、出租车四类',
    linked: [],
    fields: [],
  },
};

const UNSUPPORTED_PROFILE: Profile = {
  fileName: '',
  file: '',
  kindLabel: '未识别版式',
  categoryLabel: null,
  role: 'pending',
  shape: 'portrait',
  mediaType: 'pdf',
  status: 'pending',
  checkText: '版式没有被任何规则认领',
  linked: [],
  fields: [],
};

// 费用事件模板（统一业务序号顺序）；voucher / refs 用夹具 id，生成时映射到实际材料 id。
type EventTemplate = {
  voucher: string;
  refs: readonly string[];
  category: ExpenseCategory;
  summary: string;
  evidenceNote: string | null;
  date: string;
  endDate: string | null;
  city: string | null;
  origin: string | null;
  destination: string | null;
  gross: string;
  net: string;
  tax: string;
  invoiceType: string;
};

// 费用事件按内核的事件顺序给出：先按主要报销凭证的 materialId，再按行程段（events.mjs:356-359）。
// 统一业务序号在 inventoryResult 里按内核确认表的分类排序重排（见 CATEGORY_ORDER）。
const EVENTS: readonly EventTemplate[] = [
  { voucher: 'm01', refs: ['m02'], category: CATEGORY.accommodation, summary: '全季酒店 13 晚', evidenceNote: '住宿发票 3640.00 = 结账单消费合计 3640.00；13 天 = 08-09 入住至 08-22 离店', date: '2026-08-09', endDate: '2026-08-22', city: '上海', origin: null, destination: null, gross: '3640.00', net: '3433.96', tax: '206.04', invoiceType: '增值税发票' },
  { voucher: 'm03', refs: ['m04'], category: CATEGORY.remote_city_transport, summary: '高德 · 虹桥枢纽 → 漕河泾', evidenceNote: '打车发票与行程单配对：26.69 + 20.85 + 21.65 = 69.19，按分守恒', date: '2026-08-10', endDate: null, city: '上海', origin: '虹桥枢纽', destination: '漕河泾', gross: '26.69', net: '25.92', tax: '0.77', invoiceType: '普通发票' },
  { voucher: 'm03', refs: ['m04'], category: CATEGORY.remote_city_transport, summary: '高德 · 漕河泾 → 静安寺', evidenceNote: null, date: '2026-08-10', endDate: null, city: '上海', origin: '漕河泾', destination: '静安寺', gross: '20.85', net: '20.24', tax: '0.61', invoiceType: '普通发票' },
  { voucher: 'm03', refs: ['m04'], category: CATEGORY.remote_city_transport, summary: '高德 · 静安寺 → 张江', evidenceNote: null, date: '2026-08-12', endDate: null, city: '上海', origin: '静安寺', destination: '张江', gross: '21.65', net: '21.02', tax: '0.63', invoiceType: '普通发票' },
  { voucher: 'm05', refs: ['m06'], category: CATEGORY.remote_city_transport, summary: '曹操 · 浦东机场 → 张江', evidenceNote: '打车发票与行程单配对：1 段行程 38.40 与发票一致', date: '2026-08-11', endDate: null, city: '上海', origin: '浦东机场', destination: '张江', gross: '38.40', net: '37.28', tax: '1.12', invoiceType: '普通发票' },
  { voucher: 'm07', refs: [], category: CATEGORY.long_distance, summary: 'G7522 杭州东 → 上海虹桥', evidenceNote: '一张铁路电子客票就是一次费用；无需参考材料', date: '2026-08-09', endDate: null, city: null, origin: '杭州东', destination: '上海虹桥', gross: '73.00', net: '73.00', tax: '0.00', invoiceType: '普通发票' },
  { voucher: 'm08', refs: [], category: CATEGORY.long_distance, summary: 'G7539 上海虹桥 → 杭州东', evidenceNote: '一张铁路电子客票就是一次费用；无需参考材料', date: '2026-08-22', endDate: null, city: null, origin: '上海虹桥', destination: '杭州东', gross: '73.00', net: '73.00', tax: '0.00', invoiceType: '普通发票' },
  { voucher: 'm09', refs: [], category: CATEGORY.remote_city_transport, summary: '出租车（上海）', evidenceNote: '纸质车票无参考材料；起点与终点待补填', date: '2026-08-15', endDate: null, city: '上海', origin: null, destination: null, gross: '32.00', net: '32.00', tax: '0.00', invoiceType: '普通发票' },
  { voucher: 'm10', refs: [], category: CATEGORY.remote_city_transport, summary: '出租车（上海）', evidenceNote: '纸质车票无参考材料；下车时间待修正，起点与终点待补填', date: '2026-08-19', endDate: null, city: '上海', origin: null, destination: null, gross: '47.00', net: '47.00', tax: '0.00', invoiceType: '普通发票' },
];

// 内核确认表的费用分类顺序（next.mjs:520-521）：统一业务序号按它排，同一分类内保持事件顺序（排序是稳定的）。
const CATEGORY_ORDER: readonly string[] = ['local_city_transport', 'remote_city_transport', 'long_distance', 'accommodation'];
function categoryRank(code: string): number {
  const index = CATEGORY_ORDER.indexOf(code);
  return index === -1 ? CATEGORY_ORDER.length : index;
}

// 事件模板里的 net/tax 只用于候选明细；页面不做这笔拆分（内核 splitTax 规则：按比例取整，余数归最大段）。
const LINE_FACTS = new Map(EVENTS.map((event, index) => [index, { net: event.net, tax: event.tax, invoiceType: event.invoiceType }]));

type PendingTemplate = Omit<PendingItem, 'itemId' | 'materialId' | 'status' | 'answer'>;

const TAXI_ROUTE_FIELDS = (originHint: string, destinationHint: string): PendingItem['fields'] => [
  { key: 'origin', label: '起点', placeholder: `如：${originHint}`, required: true, format: 'text' },
  { key: 'destination', label: '终点', placeholder: `如：${destinationHint}`, required: true, format: 'text' },
];

export const UNSUPPORTED_CHOICES: PendingItem['choices'] = [
  { key: 'exclude', label: '排除此材料' },
  { key: 'manual', label: '自行手工处理' },
];

const PENDING_TEMPLATES: Readonly<Record<string, PendingTemplate>> = {
  m09: {
    title: '补填起点与终点',
    why: '客运费明细要求结构化的起点和终点，纸质车票上没有这两项，需要你对照行程回忆填写。',
    kind: 'form',
    fields: TAXI_ROUTE_FIELDS('张江高科', '漕河泾开发区'),
    choices: [],
  },
  m10: {
    title: '下车时间不合法，并补填起点与终点',
    why: '票面上的下车时间读成了 90:60，不是合法时间。日期年份已按票面后两位补全为 2026-08-19，无需处理。',
    kind: 'form',
    fields: [{ key: 'alightTime', label: '下车时间', placeholder: '对照原件填写，如 19:06', required: true, format: 'time' }, ...TAXI_ROUTE_FIELDS('静安寺', '虹桥枢纽')],
    choices: [],
  },
  m11: {
    title: '不支持的材料类型',
    why: '第一版只处理住宿、网约车、高铁、出租车四类材料。这份发票不会被猜费用类别，请选择排除，或自行手工处理后再回来。',
    kind: 'choice',
    fields: [],
    choices: UNSUPPORTED_CHOICES,
  },
};

const UNSUPPORTED_TEMPLATE: PendingTemplate = {
  title: '不支持的材料类型',
  why: '这份文件的版式没有被任何规则认领，不能作为发票或参考材料使用。请选择排除，或自行手工处理后再回来。',
  kind: 'choice',
  fields: [],
  choices: UNSUPPORTED_CHOICES,
};

// 原型里各待确认项的既定答复（`?seed=review` 及之后的阶段使用）。
export const SEED_ANSWERS: Readonly<Record<string, PendingAnswer>> = {
  m09: { origin: '张江高科', destination: '漕河泾开发区' },
  m10: { alightTime: '19:06', origin: '静安寺', destination: '虹桥枢纽' },
  m11: { [PENDING_CHOICE_KEY]: 'exclude' },
  // 仅在 `?fault=unsupported-material` 下存在的待确认项。
  m06: { [PENDING_CHOICE_KEY]: 'exclude' },
};

export type InventoryResult = {
  materials: Material[];
  events: ExpenseEvent[];
  pendingItems: PendingItem[];
};

// 上传的文件名对到识别档案：业务文件名（全季酒店_发票.pdf）与示例原件文件名（m01-hotel-invoice.pdf，即 dist-mock/fixtures/ 里的名字）都认。
// dist-mock/sample-materials/ 里的示例材料就是原件按业务文件名复制的一份（对照表见 fixtures/sample-materials.json）。
const FILE_TO_FIXTURE = new Map(Object.entries(PROFILES).flatMap(([id, profile]) => [[profile.fileName, id] as const, [profile.file, id] as const]));

// 把一批已接收的材料按文件名对到识别档案，生成盘点结果。unsupportedFault 让曹操行程单（m06）变成不支持的版式。
export function inventoryResult(uploaded: readonly Material[], unsupportedFault: boolean): InventoryResult {
  const fixtureOf = new Map<string, string>();
  const actualOf = new Map<string, string>();
  for (const material of uploaded) {
    const fixtureId = FILE_TO_FIXTURE.get(material.fileName);
    if (fixtureId && !actualOf.has(fixtureId) && !(unsupportedFault && fixtureId === 'm06')) {
      fixtureOf.set(material.materialId, fixtureId);
      actualOf.set(fixtureId, material.materialId);
    }
  }
  const pendingItems: PendingItem[] = [];
  const pendingIdOf = new Map<string, string>();
  const materials: Material[] = uploaded.map((material) => {
    const fixtureId = fixtureOf.get(material.materialId);
    const profile = fixtureId ? PROFILES[fixtureId] : undefined;
    const p = profile ?? UNSUPPORTED_PROFILE;
    // 原件本身还在：即使版式没被认领（故障注入的 m06），预览仍指向它的示例文件。
    const known = PROFILES[FILE_TO_FIXTURE.get(material.fileName) ?? ''];
    const source = profile ?? known;
    const template = fixtureId ? PENDING_TEMPLATES[fixtureId] : UNSUPPORTED_TEMPLATE;
    const pendingItemIds: string[] = [];
    if (template) {
      const itemId = `p${pendingItems.length + 1}`;
      pendingItems.push({ itemId, materialId: material.materialId, status: 'open', answer: null, ...template });
      pendingItemIds.push(itemId);
      pendingIdOf.set(material.materialId, itemId);
    }
    const linked = p.linked.map((id) => actualOf.get(id)).filter((id): id is string => Boolean(id));
    let checkText = p.checkText;
    if (fixtureId === 'm05' && unsupportedFault) checkText = '二维码核对一致；没有找到可配对的行程单，按发票 1 段';
    return {
      ...material,
      kindLabel: p.kindLabel,
      categoryLabel: p.categoryLabel,
      role: p.role,
      shape: source ? source.shape : material.shape,
      mediaType: source ? source.mediaType : material.mediaType,
      status: p.status,
      checkText,
      linkedMaterialIds: linked,
      pendingItemIds,
      originalUrl: source ? `${FIXTURE_URL_BASE}${source.file}` : null,
      previewUrl: source ? `${FIXTURE_URL_BASE}${source.file}` : null,
      fields: p.fields.map((f) => ({ ...f })),
    };
  });
  const events: ExpenseEvent[] = [];
  EVENTS.forEach((template, index) => {
    const voucherMaterialId = actualOf.get(template.voucher);
    if (!voucherMaterialId) return;
    const refs = template.refs.map((id) => actualOf.get(id)).filter((id): id is string => Boolean(id));
    let evidenceNote = template.evidenceNote;
    if (template.voucher === 'm05' && refs.length === 0) evidenceNote = '没有找到可配对的行程单，按发票 1 段计一次费用';
    events.push({
      eventId: `ev-${String(index + 1).padStart(2, '0')}`,
      no: events.length + 1,
      voucherMaterialId,
      referenceMaterialIds: refs,
      category: template.category,
      summary: template.summary,
      evidenceNote,
      date: template.date,
      endDate: template.endDate,
      city: template.city,
      origin: template.origin,
      destination: template.destination,
      grossAmount: template.gross,
    });
  });
  // 统一业务序号（mock 服务端给出，页面不排序）：本地市内交通 → 外地市内交通 → 长途交通 → 住宿，同一分类内保持事件顺序。
  events.sort((a, b) => categoryRank(a.category.code) - categoryRank(b.category.code));
  events.forEach((event, index) => {
    event.no = index + 1;
  });
  return { materials, events, pendingItems };
}

// 采用一条答复：材料字段来源改为 user，费用事件补上起终点，待确认项标记已处理。返回是否还有未处理项。
export function applyPendingAnswer(result: InventoryResult, item: PendingItem, answer: PendingAnswer): void {
  const material = result.materials.find((m) => m.materialId === item.materialId);
  if (!material) throw new Error(`待确认项 ${item.itemId} 指向不存在的材料 ${item.materialId}`);
  item.status = 'resolved';
  item.answer = { ...answer };
  if (item.kind === 'choice') {
    const choice = answer[PENDING_CHOICE_KEY];
    material.role = 'excluded';
    material.status = 'excluded';
    material.checkText = choice === 'manual' ? '已标记为自行手工处理：你会在 ERP 里另行补录，应用不碰它' : '已排除：不进入明细，也不上传 ERP';
    return;
  }
  for (const f of item.fields) {
    const value = answer[f.key] ?? '';
    const existing = material.fields.find((candidate) => candidate.key === f.key);
    if (existing) {
      existing.value = value;
      existing.source = 'user';
      existing.evidence = 'explicit';
    } else {
      material.fields.push({ key: f.key, label: f.label, value, source: 'user', evidence: 'explicit' });
    }
  }
  material.status = 'ok';
  material.checkText = `${material.checkText}；${item.fields.map((f) => f.label).join('、')}由你补填`;
  for (const event of result.events) {
    if (event.voucherMaterialId !== item.materialId) continue;
    if (answer.origin !== undefined) event.origin = answer.origin;
    if (answer.destination !== undefined) event.destination = answer.destination;
    if (event.origin && event.destination) {
      event.summary = `出租车 · ${event.origin} → ${event.destination}`;
      event.evidenceNote = event.evidenceNote ? '纸质车票无参考材料；起点与终点由你补填' : null;
    }
  }
}

// 虚构的费用项目编码与名称（内核 FY0xxxxx / 名称的写法），按费用分类给出。
const EXPENSE_ITEMS: Readonly<Record<string, { code: string; name: string }>> = {
  local_city_transport: { code: 'FY010101', name: '市内交通费' },
  remote_city_transport: { code: 'FY020103', name: '外地市内交通费' },
  long_distance: { code: 'FY020101', name: '长途交通费' },
  accommodation: { code: 'FY020102', name: '住宿费' },
};

// 上传文件名对应的示例档案 ID（m01…m11）；不认识的文件为 undefined。
export function fixtureIdOfFile(fileName: string): string | undefined {
  return FILE_TO_FIXTURE.get(fileName);
}

// 排除一份参考材料（处理材料包缺项）：不再关联任何费用事件与明细，也不进材料包；明细本身不变。
export function excludeReferenceMaterial(snapshot: TaskSnapshot, materialId: string): void {
  const material = snapshot.materials.find((candidate) => candidate.materialId === materialId);
  if (!material) return;
  material.role = 'excluded';
  material.status = 'excluded';
  material.checkText = '已排除：不关联明细，也不进入材料包';
  for (const other of snapshot.materials) other.linkedMaterialIds = other.linkedMaterialIds.filter((id) => id !== materialId);
  for (const event of snapshot.events) {
    if (!event.referenceMaterialIds.includes(materialId)) continue;
    event.referenceMaterialIds = event.referenceMaterialIds.filter((id) => id !== materialId);
    if (event.referenceMaterialIds.length === 0 && event.evidenceNote) event.evidenceNote = '参考材料已排除，按发票计费用';
  }
  snapshot.lines = snapshot.lines.map((line) => ({ ...line, referenceMaterialIds: line.referenceMaterialIds.filter((id) => id !== materialId) }));
}

// 全部待确认项处理完后形成候选明细：一个费用事件一行，No. 沿用事件的统一业务序号（内核分类排序）；同一张发票的行共享 groupId。
// 发票短标签照内核：按主要发票的 materialId 顺序编号（与行序无关）。项目号在项目归属提交后才写入。
export function buildLines(result: InventoryResult): Line[] {
  const groupOf = new Map<string, string>();
  const vouchers = [...new Set(result.events.map((event) => event.voucherMaterialId))].sort((a, b) => a.localeCompare(b));
  const invoiceLabel = new Map(vouchers.map((materialId, index) => [materialId, `发票${index + 1}`]));
  return result.events.map((event) => {
    const factsIndex = Number(event.eventId.slice(3)) - 1;
    const facts = LINE_FACTS.get(factsIndex) ?? { net: event.grossAmount, tax: '0.00', invoiceType: '普通发票' };
    let groupId = groupOf.get(event.voucherMaterialId);
    if (!groupId) {
      groupId = `g${groupOf.size + 1}`;
      groupOf.set(event.voucherMaterialId, groupId);
    }
    const pendingItem = result.pendingItems.find((item) => item.materialId === event.voucherMaterialId && item.kind === 'form');
    const expense = EXPENSE_ITEMS[event.category.code] ?? null;
    return {
      lineId: `l${event.no}`,
      no: event.no,
      groupId,
      voucherMaterialId: event.voucherMaterialId,
      invoiceLabel: invoiceLabel.get(event.voucherMaterialId) ?? '发票',
      eventId: event.eventId,
      date: event.date,
      endDate: event.endDate,
      category: event.category,
      description: event.summary,
      city: event.city,
      origin: event.origin,
      destination: event.destination,
      projectCode: null,
      projectName: null,
      expenseItemCode: expense?.code ?? null,
      expenseItemName: expense?.name ?? null,
      invoiceType: facts.invoiceType,
      referenceMaterialIds: event.referenceMaterialIds,
      grossAmount: event.grossAmount,
      netAmount: facts.net,
      taxAmount: facts.tax,
      fromPendingItemId: pendingItem?.itemId ?? null,
    };
  });
}

// 还没处理的待确认项个数：只有 mock 服务端数，页面读快照里的 inventory.summary.openPendingItemCount。
export function openPendingItemCount(items: readonly PendingItem[]): number {
  return items.filter((item) => item.status === 'open').length;
}

// 服务端投影：盘点结束后，按当前材料、费用事件与待确认项写出盘点计数与「未归入费用事件」的材料；未结束时清空。
// mock 每次存快照前都调用一次，保证投影与材料状态同步（答复待确认项会改变材料状态）。
export function withInventoryProjection(snapshot: TaskSnapshot): TaskSnapshot {
  const { inventory, materials, events, pendingItems } = snapshot;
  if (inventory.status !== 'done') {
    inventory.summary = null;
    inventory.ungroupedMaterialIds = [];
    return snapshot;
  }
  const grouped = new Set(events.flatMap((event) => [event.voucherMaterialId, ...event.referenceMaterialIds]));
  const count = (test: (material: Material) => boolean) => materials.filter(test).length;
  inventory.summary = {
    materialCount: materials.length,
    okCount: count((material) => material.status === 'ok'),
    pendingMaterialCount: count((material) => material.status === 'pending'),
    voucherCount: count((material) => material.role === 'primary_voucher'),
    referenceCount: count((material) => material.role === 'reference'),
    openPendingItemCount: openPendingItemCount(pendingItems),
  };
  inventory.ungroupedMaterialIds = materials.filter((material) => !grouped.has(material.materialId)).map((material) => material.materialId);
  return snapshot;
}
