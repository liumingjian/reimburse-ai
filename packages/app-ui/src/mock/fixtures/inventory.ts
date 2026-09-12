import {
  PENDING_CHOICE_KEY,
  fieldAnswer,
  isAllocationAnswer,
  type Blocker,
  type BlockerTask,
  type ExpenseCategory,
  type ExpenseEvent,
  type FieldCandidate,
  type Line,
  type Material,
  type PendingAnswer,
  type PendingItem,
  type TaskSnapshot,
} from '../../contract/snapshot';

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

// 示例材料的待确认项都由用户处理（内核 WHO：要你处理）。
const PENDING_TEMPLATES: Readonly<Record<string, PendingTemplate>> = {
  m09: {
    title: '补填起点与终点',
    why: '客运费明细要求结构化的起点和终点，纸质车票上没有这两项，需要你对照行程回忆填写。',
    kind: 'form',
    resolver: '要你处理',
    fields: TAXI_ROUTE_FIELDS('张江高科', '漕河泾开发区'),
    choices: [],
    allocation: null,
  },
  m10: {
    title: '下车时间不合法，并补填起点与终点',
    why: '票面上的下车时间读成了 90:60，不是合法时间。日期年份已按票面后两位补全为 2026-08-19，无需处理。',
    kind: 'form',
    resolver: '要你处理',
    fields: [{ key: 'alightTime', label: '下车时间', placeholder: '对照原件填写，如 19:06', required: true, format: 'time' }, ...TAXI_ROUTE_FIELDS('静安寺', '虹桥枢纽')],
    choices: [],
    allocation: null,
  },
  m11: {
    title: '不支持的材料类型',
    why: '第一版只处理住宿、网约车、高铁、出租车四类材料。这份发票不会被猜费用类别，请选择排除，或自行手工处理后再回来。',
    kind: 'choice',
    resolver: '要你处理',
    fields: [],
    choices: UNSUPPORTED_CHOICES,
    allocation: null,
  },
};

// 盘点里不认识的文件（不是任何示例原件）按形态分成三种，都「要你处理」：
// 空文本 PDF（0 字节或文件名含「空白」）与多页发票（文件名含「多页」）只能排除，或换原件（追加材料后重新盘点）；其余是不支持的材料类型。
type UnknownKind = 'empty_text' | 'multi_page' | 'unsupported';

function unknownKind(material: Material): UnknownKind {
  if (material.mediaType !== 'pdf') return 'unsupported';
  if (material.size === 0 || material.fileName.includes('空白')) return 'empty_text';
  if (material.fileName.includes('多页')) return 'multi_page';
  return 'unsupported';
}

const EXCLUDE_ONLY: PendingItem['choices'] = [{ key: 'exclude', label: '排除此材料' }];

const UNKNOWN_TEMPLATES: Readonly<Record<UnknownKind, PendingTemplate>> = {
  // 内核 pdf_markdown_conversion_empty（next.mjs:826-831）。
  empty_text: {
    title: '这份 PDF 没有可读取的内容',
    why: '这份 PDF 没有可读取的内容，没有票种、金额或日期可以核对。请提供电子发票原件或能正常读取文字的 PDF：在上传页追加原件后重新盘点；或者把它从本次报销中排除。',
    kind: 'choice',
    resolver: '要你处理',
    fields: [],
    choices: EXCLUDE_ONLY,
    allocation: null,
  },
  // 内核 multi_page_invoice（next.mjs:870-872）。
  multi_page: {
    title: '多页发票',
    why: '多页发票不在第一版支持范围内。请把它从本次报销中排除，或在上传页追加单页发票后重新盘点。',
    kind: 'choice',
    resolver: '要你处理',
    fields: [],
    choices: EXCLUDE_ONLY,
    allocation: null,
  },
  unsupported: {
    title: '不支持的材料类型',
    why: '这份文件的版式没有被任何规则认领，不能作为发票或参考材料使用。请选择排除，或自行手工处理后再回来。',
    kind: 'choice',
    resolver: '要你处理',
    fields: [],
    choices: UNSUPPORTED_CHOICES,
    allocation: null,
  },
};

const UNKNOWN_CHECK_TEXT: Readonly<Record<UnknownKind, string>> = {
  empty_text: 'PDF 没有可读取的文字内容',
  multi_page: '多页发票，第一版不支持',
  unsupported: UNSUPPORTED_PROFILE.checkText,
};

// `?allocation=1`：高德合并发票的行程单第 3 段读成 21.56（原件是 21.65），三段合计 69.10，和票面价税合计 69.19 对不上，
// 于是出现逐段分摊待确认项（内核 allocation_required）。行程单读数只用来预填，每段金额由用户给，mock 服务端按分判定守恒。
const AMAP_VOUCHER = 'm03';
const AMAP_TOTAL = '69.19';
const AMAP_SUGGESTED: readonly string[] = ['26.69', '20.85', '21.56'];
const AMAP_SUGGESTED_SUM = '69.10';
const ALLOCATION_CHECK = {
  voucher: `二维码核对一致；行程单 3 段合计 ${AMAP_SUGGESTED_SUM}，和价税合计 ${AMAP_TOTAL} 对不上，逐段金额待你确认`,
  itinerary: `${AMAP_SUGGESTED.join(' + ')} = ${AMAP_SUGGESTED_SUM}，和发票价税合计 ${AMAP_TOTAL} 对不上`,
  event: `逐段金额待确认：行程单 ${AMAP_SUGGESTED.join(' + ')} = ${AMAP_SUGGESTED_SUM}，票面价税合计 ${AMAP_TOTAL}`,
} as const;

// 选「这张票我认不出」的后果（服务端成句，照内核 givenUpOpenItems 的出路）：这张发票连同它的行程单移出本次报销。
export const ALLOCATION_GIVE_UP_NOTE =
  '选「这张票我认不出」后，这张发票连同它的行程单移出本次报销：不形成明细，也不进材料包。要报这张票，请补一份列了逐段金额的行程单，追加材料后重新盘点。';

function allocationTemplate(fileName: string): PendingTemplate {
  const segments = EVENTS.filter((event) => event.voucher === AMAP_VOUCHER).map((event, index) => ({
    index: index + 1,
    date: event.date,
    route: `${event.origin ?? ''} → ${event.destination ?? ''}`,
    suggested: AMAP_SUGGESTED[index] ?? null,
  }));
  return {
    title: '合并交通发票逐段金额',
    why:
      `${fileName} 是一张合并的交通发票：票面只有一个合计 ${AMAP_TOTAL} 元，但行程单上是 ${segments.length} 段行程，而逐段金额加起来和票面对不上。` +
      `各段的价税合计需要你确认：加起来必须正好是 ${AMAP_TOTAL} 元，不会平均、不会按比例，也不会把差额随手加到某一段上。差额落在哪一段，只有你知道。`,
    kind: 'allocation',
    resolver: '要你处理',
    fields: [],
    choices: [],
    allocation: { segments, total: AMAP_TOTAL, giveUpNote: ALLOCATION_GIVE_UP_NOTE },
  };
}

// 原型里各待确认项的既定答复（`?seed=project` 及之后的阶段使用）。
export const SEED_ANSWERS: Readonly<Record<string, PendingAnswer>> = {
  m09: { origin: '张江高科', destination: '漕河泾开发区' },
  m10: { alightTime: '19:06', origin: '静安寺', destination: '虹桥枢纽' },
  m11: { [PENDING_CHOICE_KEY]: 'exclude' },
  // 仅在 `?fault=unsupported-material` 下存在的待确认项。
  m06: { [PENDING_CHOICE_KEY]: 'exclude' },
  // 仅在 `?allocation=1` 下存在的逐段分摊：按原件给出，明细与默认相同。
  m03: { amounts: ['26.69', '20.85', '21.65'] },
};

export type InventoryResult = {
  materials: Material[];
  events: ExpenseEvent[];
  pendingItems: PendingItem[];
};

// 上传的文件名对到识别档案：业务文件名（全季酒店_发票.pdf）与示例原件文件名（m01-hotel-invoice.pdf，即 dist-mock/fixtures/ 里的名字）都认。
// dist-mock/sample-materials/ 里的示例材料就是原件按业务文件名复制的一份（对照表见 fixtures/sample-materials.json）。
const FILE_TO_FIXTURE = new Map(Object.entries(PROFILES).flatMap(([id, profile]) => [[profile.fileName, id] as const, [profile.file, id] as const]));

// 把一批已接收的材料按文件名对到识别档案，生成盘点结果。unsupportedFault 让曹操行程单（m06）变成不支持的版式；
// allocationRequired（`?allocation=1`）让高德合并发票需要逐段分摊。
export function inventoryResult(uploaded: readonly Material[], unsupportedFault: boolean, allocationRequired = false): InventoryResult {
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
    const unknown = fixtureId ? null : unknownKind(material);
    const splitting = allocationRequired && fixtureId === AMAP_VOUCHER;
    const template = splitting ? allocationTemplate(material.fileName) : fixtureId ? PENDING_TEMPLATES[fixtureId] : UNKNOWN_TEMPLATES[unknown ?? 'unsupported'];
    const pendingItemIds: string[] = [];
    if (template) {
      const itemId = `p${pendingItems.length + 1}`;
      pendingItems.push({ itemId, materialId: material.materialId, status: 'open', answer: null, ...template });
      pendingItemIds.push(itemId);
      pendingIdOf.set(material.materialId, itemId);
    }
    const linked = p.linked.map((id) => actualOf.get(id)).filter((id): id is string => Boolean(id));
    let checkText = unknown ? UNKNOWN_CHECK_TEXT[unknown] : p.checkText;
    if (fixtureId === 'm05' && unsupportedFault) checkText = '二维码核对一致；没有找到可配对的行程单，按发票 1 段';
    if (splitting) checkText = ALLOCATION_CHECK.voucher;
    if (allocationRequired && fixtureId === 'm04') checkText = ALLOCATION_CHECK.itinerary;
    return {
      ...material,
      kindLabel: p.kindLabel,
      categoryLabel: p.categoryLabel,
      role: p.role,
      shape: source ? source.shape : material.shape,
      mediaType: source ? source.mediaType : material.mediaType,
      status: splitting ? 'pending' : p.status,
      checkText,
      linkedMaterialIds: linked,
      pendingItemIds,
      originalUrl: source ? `${FIXTURE_URL_BASE}${source.file}` : null,
      previewUrl: source ? `${FIXTURE_URL_BASE}${source.file}` : null,
      fields: p.fields.map((f) => ({ ...f })),
    };
  });
  const events: ExpenseEvent[] = [];
  let amapSegment = 0;
  EVENTS.forEach((template, index) => {
    const voucherMaterialId = actualOf.get(template.voucher);
    if (!voucherMaterialId) return;
    const refs = template.refs.map((id) => actualOf.get(id)).filter((id): id is string => Boolean(id));
    let evidenceNote = template.evidenceNote;
    if (template.voucher === 'm05' && refs.length === 0) evidenceNote = '没有找到可配对的行程单，按发票 1 段计一次费用';
    // 逐段分摊之前，高德各段先按行程单读数记（第 3 段读错）；答复后换成用户给的金额。
    let grossAmount = template.gross;
    if (allocationRequired && template.voucher === AMAP_VOUCHER) {
      grossAmount = AMAP_SUGGESTED[amapSegment] ?? template.gross;
      amapSegment += 1;
      if (evidenceNote) evidenceNote = ALLOCATION_CHECK.event;
    }
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
      grossAmount,
    });
  });
  // 统一业务序号（mock 服务端给出，页面不排序）：本地市内交通 → 外地市内交通 → 长途交通 → 住宿，同一分类内保持事件顺序。
  events.sort((a, b) => categoryRank(a.category.code) - categoryRank(b.category.code));
  events.forEach((event, index) => {
    event.no = index + 1;
  });
  return { materials, events, pendingItems };
}

// 采用一条答复：材料字段来源改为 user（服务端记录，页面不显示来源），费用事件补上起终点或逐段金额，待确认项标记已处理。
export function applyPendingAnswer(result: InventoryResult, item: PendingItem, answer: PendingAnswer): void {
  const material = result.materials.find((m) => m.materialId === item.materialId);
  if (!material) throw new Error(`待确认项 ${item.itemId} 指向不存在的材料 ${item.materialId}`);
  item.status = 'resolved';
  item.answer = structuredClone(answer);
  if (item.kind === 'allocation') {
    applyAllocation(result, item, material, answer);
    return;
  }
  const values = fieldAnswer(answer);
  if (item.kind === 'choice') {
    const choice = values[PENDING_CHOICE_KEY];
    material.role = 'excluded';
    material.status = 'excluded';
    material.checkText = choice === 'manual' ? '已标记为自行手工处理：你会在 ERP 里另行补录，应用不碰它' : '已排除：不进入明细，也不上传 ERP';
    return;
  }
  for (const f of item.fields) {
    const value = values[f.key] ?? '';
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
    if (values.origin !== undefined) event.origin = values.origin;
    if (values.destination !== undefined) event.destination = values.destination;
    if (event.origin && event.destination) {
      event.summary = `出租车 · ${event.origin} → ${event.destination}`;
      event.evidenceNote = event.evidenceNote ? '纸质车票无参考材料；起点与终点由你补填' : null;
    }
  }
}

// 逐段分摊的答复（服务端已判定按分守恒）：各段价税合计换成用户给的金额；
// 「认不出」：这张发票连同它的行程单移出本次报销，费用事件去掉后重新编号（仍按分类排序）。
function applyAllocation(result: InventoryResult, item: PendingItem, voucher: Material, answer: PendingAnswer): void {
  const own = result.events.filter((event) => event.voucherMaterialId === voucher.materialId);
  const referenceIds = new Set(own.flatMap((event) => event.referenceMaterialIds));
  if (isAllocationAnswer(answer) && 'amounts' in answer) {
    own.forEach((event, index) => {
      const amount = answer.amounts[index];
      if (amount) event.grossAmount = amount;
    });
    const expression = `${answer.amounts.join(' + ')} = ${item.allocation?.total ?? ''}`;
    voucher.status = 'ok';
    voucher.checkText = `二维码核对一致；逐段金额由你确认：${expression}，按分守恒`;
    const first = own[0];
    if (first) first.evidenceNote = `打车发票与行程单配对：逐段金额由你确认，${expression}，按分守恒`;
    for (const material of result.materials) if (referenceIds.has(material.materialId)) material.checkText = `${expression}，按分守恒（逐段金额由你确认）`;
    return;
  }
  const removed = new Set([voucher.materialId, ...referenceIds]);
  for (const material of result.materials) {
    if (!removed.has(material.materialId)) {
      material.linkedMaterialIds = material.linkedMaterialIds.filter((id) => !removed.has(id));
      continue;
    }
    material.role = 'excluded';
    material.status = 'excluded';
    material.linkedMaterialIds = [];
    material.checkText = material.materialId === voucher.materialId ? '逐段金额认不出：这张发票移出本次报销，不形成明细' : '随发票一起移出本次报销：不关联明细，也不进入材料包';
  }
  for (let index = result.events.length - 1; index >= 0; index -= 1) {
    if (result.events[index]?.voucherMaterialId === voucher.materialId) result.events.splice(index, 1);
  }
  result.events.forEach((event, index) => {
    event.no = index + 1;
  });
}

// `?duplicate=1`：跨任务查重（按发票身份）命中。铁路电子客票_0809.pdf 这张发票在已完成的任务里也在，整批停。
export const DUPLICATE_FIXTURE_ID = 'm07';

export function duplicateBlockers(materials: Material[], hit: BlockerTask): Blocker[] {
  const material = materials.find((candidate) => FILE_TO_FIXTURE.get(candidate.fileName) === DUPLICATE_FIXTURE_ID);
  if (!material) return [];
  material.status = 'pending';
  material.checkText = `与报销任务「${hit.name}」里的发票重复`;
  return [
    {
      kind: 'duplicate_across_tasks',
      materialId: material.materialId,
      fileName: material.fileName,
      reason: `这张发票在报销任务「${hit.name}」里也在，那个任务已经写入报销系统，它还占着这张发票。同一张发票不能报两次：请把它从本次材料里移出。`,
      resolver: '要你处理',
      tasks: [{ ...hit }],
    },
  ];
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
  const splits = splitOverrides(result.events);
  return result.events.map((event) => {
    const factsIndex = Number(event.eventId.slice(3)) - 1;
    const template = LINE_FACTS.get(factsIndex) ?? { net: event.grossAmount, tax: '0.00', invoiceType: '普通发票' };
    const facts = { ...template, ...splits.get(event.eventId) };
    let groupId = groupOf.get(event.voucherMaterialId);
    if (!groupId) {
      groupId = `g${groupOf.size + 1}`;
      groupOf.set(event.voucherMaterialId, groupId);
    }
    const pendingItem = result.pendingItems.find((item) => item.materialId === event.voucherMaterialId && item.kind === 'form');
    const expense = EXPENSE_ITEMS[event.category.code] ?? null;
    const voucher = result.materials.find((material) => material.materialId === event.voucherMaterialId);
    const invoiceNumber = PROFILES[FILE_TO_FIXTURE.get(voucher?.fileName ?? '') ?? '']?.fields.find((field) => field.key === 'invoiceNumber')?.value ?? null;
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
      // 内核 events.mjs：起点与终点都有才有路线；票号照内核 maskNumber 脱敏（铁路电子客票夹具没有发票号码，为 null）。
      route: event.origin && event.destination ? `${event.origin} → ${event.destination}` : null,
      maskedNumber: invoiceNumber === null ? null : maskNumber(invoiceNumber),
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

// 内核 parse.mjs maskNumber：长于 8 位留首尾各 4 位，5-8 位留首尾各 2 位，其余中间打星号。
export function maskNumber(value: string): string {
  if (value.length > 8) return `${value.slice(0, 4)}${'*'.repeat(value.length - 8)}${value.slice(-4)}`;
  return value.length > 4 ? `${value.slice(0, 2)}${'*'.repeat(value.length - 4)}${value.slice(-2)}` : value;
}

// 逐段金额被用户改过的凭证（逐段分摊）：照内核 splitTax 的做法重拆税额（按比例取整，余数归最大段），不含税金额 = 价税合计 - 税额。
// 各段与夹具相同的凭证不重拆。
function splitOverrides(events: readonly ExpenseEvent[]): Map<string, { net: string; tax: string }> {
  const cents = (value: string) => Math.round(Number(value) * 100);
  const yuan = (value: number) => (value / 100).toFixed(2);
  const out = new Map<string, { net: string; tax: string }>();
  for (const voucher of new Set(events.map((event) => event.voucherMaterialId))) {
    const group = events.filter((event) => event.voucherMaterialId === voucher);
    const templates = group.map((event) => EVENTS[Number(event.eventId.slice(3)) - 1]);
    if (group.every((event, index) => templates[index]?.gross === event.grossAmount)) continue;
    const taxTotal = templates.reduce((sum, template) => sum + cents(template?.tax ?? '0.00'), 0);
    const gross = group.map((event) => cents(event.grossAmount));
    const grossTotal = gross.reduce((sum, value) => sum + value, 0);
    const taxes = gross.map((value) => (grossTotal > 0 ? Math.floor((taxTotal * value) / grossTotal) : 0));
    const largest = gross.indexOf(Math.max(...gross));
    taxes[largest] = (taxes[largest] ?? 0) + taxTotal - taxes.reduce((sum, value) => sum + value, 0);
    group.forEach((event, index) => {
      const tax = taxes[index] ?? 0;
      out.set(event.eventId, { net: yuan((gross[index] ?? 0) - tax), tax: yuan(tax) });
    });
  }
  return out;
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
