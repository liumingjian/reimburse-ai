// Fixture data: entirely fictional, reusing the prototype's cast and numbers (林颂宜, an August 2026 Shanghai trip).
// No real personal data. This is the templates' single source of data; the snapshot field values under
// src/mock/fixtures correspond to it one by one.

export const EMPLOYEE = { name: '林颂宜', dept: '产品研发部', phoneMasked: '138****4021' };

export const BUYER = { name: '某某科技（上海）有限公司', taxNo: '91310000XXXXXXXX0A' };

export const HOTEL_INVOICE = {
  id: 'm01',
  file: 'm01-hotel-invoice.pdf',
  title: '电子发票（增值税专用发票）',
  number: '26312000000098127734',
  date: '2026年08月22日',
  seller: { name: '上海某某酒店管理有限公司', taxNo: '91310000YYYYYYYY0B' },
  rows: [{ name: '*住宿服务*住宿费', unit: '天', qty: '13', price: '264.15', net: '3433.96', rate: '6%', tax: '206.04' }],
  net: '3433.96',
  tax: '206.04',
  gross: '3640.00',
  grossWords: '叁仟陆佰肆拾圆整',
};

export const HOTEL_FOLIO = {
  id: 'm02',
  file: 'm02-hotel-folio.pdf',
  hotel: '全季酒店（上海某某店）',
  guest: EMPLOYEE.name,
  room: '1208',
  checkIn: '2026-08-09',
  checkOut: '2026-08-22',
  nights: '13',
  rate: '280.00',
  total: '3640.00',
  paid: '3640.00',
};

// Regression fixture (#212): a folio photographed on a desk. Each label and its value are separate boxes, the dates
// are printed in two shapes other than YYYY-MM-DD, and the hotel is not a chain any layout names. Its 消费合计 equals
// the m01 hotel invoice's 价税合计, so the two pair into one stay.
export const HOTEL_FOLIO_PHOTO = {
  id: 'r210',
  file: 'r210-hotel-folio-photo.jpg',
  hotel: '某某悦居酒店（上海某某店）',
  guest: EMPLOYEE.name,
  room: '0816',
  checkIn: '2026/08/09',
  checkOut: '2026年08月22日',
  nights: '13',
  total: '3640.00',
};

export const AMAP_INVOICE = {
  id: 'm03',
  file: 'm03-amap-invoice.pdf',
  title: '电子发票（普通发票）',
  number: '26312000000101557402',
  date: '2026年08月13日',
  seller: { name: '某某网约车科技（上海）有限公司', taxNo: '91310000ZZZZZZZZ0C' },
  rows: [{ name: '*运输服务*客运服务费', unit: '次', qty: '3', price: '', net: '67.18', rate: '3%', tax: '2.01' }],
  net: '67.18',
  tax: '2.01',
  gross: '69.19',
  grossWords: '陆拾玖圆壹角玖分',
};

export const AMAP_ITINERARY = {
  id: 'm04',
  file: 'm04-amap-itinerary.pdf',
  brand: '高德地图',
  applyDate: '2026-08-13',
  phone: EMPLOYEE.phoneMasked,
  count: '3',
  total: '69.19',
  rows: [
    { no: '1', car: '经济型', time: '2026-08-10 08:52', city: '上海市', from: '虹桥枢纽', to: '漕河泾', amount: '26.69' },
    { no: '2', car: '经济型', time: '2026-08-10 18:20', city: '上海市', from: '漕河泾', to: '静安寺', amount: '20.85' },
    { no: '3', car: '经济型', time: '2026-08-12 09:15', city: '上海市', from: '静安寺', to: '张江', amount: '21.65' },
  ],
};

// Regression fixture (not a sample material): a real ride-hailing invoice often prints one v1 service row beside an
// unrelated fee row (服务费 service fee, 经纪代理服务 brokerage service), and recognition must not throw the whole
// invoice away over it. The 合计 (total) row agrees with both item rows, so this fixture exercises the recognition
// gate only and leaves the conservation checks alone.
export const BUNDLED_FEE_INVOICE = {
  id: 'r201',
  file: 'r201-bundled-fee-invoice.pdf',
  title: '电子发票（普通发票）',
  number: '26312000000104412880',
  date: '2026年08月16日',
  seller: { name: '某某出行服务（上海）有限公司', taxNo: '91310000UUUUUUUU0F' },
  rows: [
    { name: '*运输服务*客运服务费', unit: '次', qty: '2', price: '', net: '41.55', rate: '3%', tax: '1.25' },
    { name: '*经纪代理服务*平台服务费', unit: '次', qty: '1', price: '5.83', net: '5.83', rate: '6%', tax: '0.35' },
  ],
  net: '47.38',
  tax: '1.60',
  gross: '48.98',
  grossWords: '肆拾捌圆玖角捌分',
};

// Regression fixture (not a sample material): a real ride-hailing invoice is issued under *交通运输服务* (transport
// services, the parent tax class) and prints several fields on one baseline — 发票号码 beside 开票日期, the 联次 (copy
// marker) beside the title — so a whole joined row matches nothing; only a contiguous run of text inside the row is
// exactly one field. The label and its value are two separate runs as well.
export const TRANSPORT_INVOICE = {
  id: 'r206',
  file: 'r206-transport-invoice.pdf',
  title: '电子发票（普通发票）',
  number: '26312000000104412906',
  date: '2026年08月17日',
  seller: { name: '某某出行科技（广州）有限公司', taxNo: '91440000TTTTTTTT0G' },
  rows: [{ name: '*交通运输服务*客运服务费', unit: '次', qty: '1', price: '26.69', net: '26.69', rate: '3%', tax: '0.80' }],
  net: '26.69',
  tax: '0.80',
  gross: '27.49',
  grossWords: '贰拾柒圆肆角玖分',
  // Fields printed side by side on one baseline, each label a run apart from its value.
  sharedBaseline: true,
};

// An itinerary whose declared leg count agrees with its parsed row count while that leg's amount cannot be read: the
// amount cell says 待结算 (settlement pending). This is the case behind the false 「对不上」 (counts disagree) message.
export const AMAP_ITINERARY_GAP = {
  id: 'r202',
  file: 'r202-amap-itinerary-gap.pdf',
  brand: '高德地图',
  applyDate: '2026-08-13',
  phone: EMPLOYEE.phoneMasked,
  count: '1',
  total: '32.50',
  rows: [{ no: '1', car: '经济型', time: '2026-08-11 19:04', city: '上海市', from: '张江', to: '浦东机场', amount: '待结算' }],
};

// Regression fixture (not a sample material): a real itinerary draws every table cell as its own text run, wraps
// 上车时间 (pick-up time) with the date on one line and HH:MM on the next, and gives the amount a unit (26.69元) or a
// currency sign (¥42.50); `共计N单行程，合计X元` is split across several runs too. Its total equals m03's 价税合计, so
// the two pair into expense events.
export const AMAP_ITINERARY_WRAPPED = {
  id: 'r205',
  file: 'r205-amap-itinerary-wrapped.pdf',
  brand: '高德地图',
  applyDate: '2026-08-13',
  phone: EMPLOYEE.phoneMasked,
  count: '2',
  total: '69.19',
  splitSummary: true,
  rows: [
    // A wrapped 上车时间: the date and the time are two lines of one cell.
    { no: '1', car: '经济型', time: '2026-08-10 08:52', timeLines: ['2026-08-10', '08:52'], city: '上海市', from: '虹桥枢纽', to: '漕河泾', amount: '26.69元' },
    { no: '2', car: '经济型', time: '2026-08-12 09:15', city: '上海市', from: '静安寺', to: '张江', amount: '¥42.50' },
  ],
};

// Regression fixture (not a sample material): the 高德行程单 that pairs with r206, the 交通运输服务 (parent tax class)
// ride invoice — the pairing no fixture covered before (#210). Three things it exercises at once: its 合计 equals
// r206's 价税合计, so a parent-class invoice has to be admitted to the pairing at all; its two legs sit in two
// different cities, so one line categorises 本地 and the other 外地 off the same invoice; and its header prints the
// 申请时间 label real itineraries use, not the 申请日期 the other fixtures print.
export const AMAP_ITINERARY_CROSS_CITY = {
  id: 'r209',
  file: 'r209-amap-itinerary-cross-city.pdf',
  brand: '高德地图',
  applyLabel: '申请时间',
  applyDate: '2026-08-17',
  phone: EMPLOYEE.phoneMasked,
  count: '2',
  total: '27.49',
  rows: [
    { no: '1', car: '经济型', time: '2026-08-16 08:40', city: '杭州市', from: '城站', to: '黄龙', amount: '12.49' },
    { no: '2', car: '经济型', time: '2026-08-17 09:30', city: '上海市', from: '虹桥枢纽', to: '漕河泾', amount: '15.00' },
  ],
};

export const CAOCAO_INVOICE = {
  id: 'm05',
  file: 'm05-caocao-invoice.pdf',
  title: '电子发票（普通发票）',
  number: '26312000000099830115',
  date: '2026年08月11日',
  seller: { name: '某某出行科技（上海）有限公司', taxNo: '91310000WWWWWWWW0D' },
  rows: [
    { name: '*运输服务*客运服务费', unit: '次', qty: '1', price: '39.22', net: '39.22', rate: '3%', tax: '1.18' },
    { name: '*运输服务*客运服务费（优惠）', unit: '', qty: '', price: '', net: '-1.94', rate: '3%', tax: '-0.06' },
  ],
  net: '37.28',
  tax: '1.12',
  gross: '38.40',
  grossWords: '叁拾捌圆肆角整',
};

export const CAOCAO_ITINERARY = {
  id: 'm06',
  file: 'm06-caocao-itinerary.pdf',
  brand: '曹操出行',
  applyDate: '2026-08-11',
  phone: EMPLOYEE.phoneMasked,
  count: '1',
  total: '38.40',
  rows: [{ no: '1', car: '舒适型', time: '2026-08-11 14:05', city: '上海市', from: '浦东机场', to: '张江', amount: '38.40' }],
};

export const RAIL_0809 = {
  id: 'm07',
  file: 'm07-rail-0809.pdf',
  number: '26312000000102200731',
  date: '2026年08月09日',
  train: 'G7522',
  from: '杭州东',
  to: '上海虹桥',
  depart: '08:30',
  seat: '05车12A号',
  seatClass: '二等座',
  price: '73.00',
  passenger: EMPLOYEE.name,
  idMasked: '3301**********0021',
};

export const RAIL_0822 = {
  ...RAIL_0809,
  id: 'm08',
  file: 'm08-rail-0822.pdf',
  number: '26312000000102200744',
  date: '2026年08月22日',
  train: 'G7539',
  from: '上海虹桥',
  to: '杭州东',
  depart: '18:05',
  seat: '07车03F号',
};

// A rail ticket drawn the way a real 铁路电子客票 face is, and the way no generated fixture was before (#204): the trip
// row carries a fourth cell (the seat), and 票价's label and amount are separate text runs beside another labelled
// field. Both break an anchor that needs one text observation.
export const RAIL_SPLIT_RUNS = {
  ...RAIL_0809,
  id: 'r204',
  file: 'r204-rail-split-runs.pdf',
  number: '26312000000102200758',
  date: '2026年08月23日',
  train: 'G1376',
  from: '广州南',
  to: '长沙南',
  depart: '09:12',
  seat: '07车05F号',
  price: '314.50',
  // A seat cell drawn after the 车次 (train number); 「票价：」 and its amount are two separate runs.
  seatOnTripRow: true,
  splitFare: true,
};

// Taxi receipts: m10's 下车时间 (drop-off time) reads 19:06 on the face, but the print has faded, so the photo is read
// as 90:60 (the prototype's script).
export const TAXI_0815 = {
  id: 'm09',
  file: 'm09-taxi-photo.jpg',
  code: '131002325021',
  number: '04213377',
  plate: '沪BX0000',
  date: '26-08-15',
  boardAt: '09:06',
  alightAt: '09:31',
  unitPrice: '3.00',
  distance: '8.6',
  waiting: '00:02:10',
  amount: '32.00',
  faded: false,
};

export const TAXI_0819 = {
  ...TAXI_0815,
  id: 'm10',
  file: 'm10-taxi-photo.jpg',
  number: '04219052',
  plate: '沪BX0001',
  date: '26-08-19',
  boardAt: '18:42',
  alightAt: '19:06',
  distance: '12.3',
  waiting: '00:05:40',
  amount: '47.00',
  faded: true,
};

export const DINING_INVOICE = {
  id: 'm11',
  file: 'm11-other-invoice.pdf',
  title: '电子发票（普通发票）',
  number: '26312000000103317790',
  date: '2026年08月14日',
  seller: { name: '上海某某餐饮有限公司', taxNo: '91310000VVVVVVVV0E' },
  rows: [{ name: '*餐饮服务*餐费', unit: '次', qty: '1', price: '226.42', net: '226.42', rate: '6%', tax: '13.58' }],
  net: '226.42',
  tax: '13.58',
  gross: '240.00',
  grossWords: '贰佰肆拾圆整',
};

export const DINING_RECEIPT = {
  id: 'm13', title: '结账单', merchant: '小河餐厅', date: '2026-08-18', time: '19:20:00', total: '240.00', paid: '240.00', discount: null,
};

export const DISCOUNTED_DINING_RECEIPT = {
  ...DINING_RECEIPT, id: 'm14', title: '消费清单', total: '300.00', discount: '60.00',
};

export const MISMATCHED_DINING_RECEIPT = {
  ...DINING_RECEIPT, id: 'm15', total: '239.99', paid: '239.99',
};

export const OFFICE_SUPPLIES_INVOICE = {
  ...DINING_INVOICE,
  id: 'm12',
  file: 'm12-office-supplies-invoice.pdf',
  number: '26312000000103317791',
  seller: { name: '上海某某办公用品有限公司', taxNo: '91310000WWWWWWWW0F' },
  rows: [{ name: '*办公用品*文具', unit: '批', qty: '1', price: '226.42', net: '226.42', rate: '6%', tax: '13.58' }],
};

// ---- Regression fixtures: the text-run splits of a real PDF (#200) ----
// The sample materials (m01…m12) draw one text run per anchor; a real invoice does not — a label and its value are
// usually two runs, and a title is often one run per glyph. These two fixtures reproduce those splits; the rest of the
// layout matches the hotel invoice, so each uploads on its own with no folio needed.

export const SPLIT_NUMBER_INVOICE = {
  id: 'r01',
  file: 'r01-einvoice-split-number.pdf',
  title: '电子发票（增值税专用发票）',
  number: '26312000000098127801',
  date: '2026年08月20日',
  seller: { name: '上海某某酒店管理有限公司', taxNo: '91310000YYYYYYYY0B' },
  rows: [{ name: '*住宿服务*住宿费', unit: '天', qty: '2', price: '264.15', net: '528.30', rate: '6%', tax: '31.70' }],
  net: '528.30',
  tax: '31.70',
  gross: '560.00',
  grossWords: '伍佰陆拾圆整',
  // 「发票号码：」 and the 20 digits are two separate runs.
  splitNumber: true,
};

export const SPACED_TITLE_INVOICE = {
  id: 'r02',
  file: 'r02-einvoice-spaced-title.pdf',
  title: '电子发票（普通发票）',
  number: '26312000000098127802',
  date: '2026年08月21日',
  seller: { name: '上海某某酒店管理有限公司', taxNo: '91310000YYYYYYYY0B' },
  rows: [{ name: '*住宿服务*住宿费', unit: '天', qty: '1', price: '264.15', net: '264.15', rate: '6%', tax: '15.85' }],
  net: '264.15',
  tax: '15.85',
  gross: '280.00',
  grossWords: '贰佰捌拾圆整',
  // The title is drawn one run per glyph.
  spacedTitle: true,
};

// Print-sheet pages: the 费用类别 (expense category) uses the kernel labels. The header reads
// `No.x · date · category · 价税合计`, with an ASCII hyphen for ranges.
// Page order and No. follow the unified business numbering (the kernel confirmation table's category order: local
// 市内交通 → out-of-town 市内交通 → 长途交通 → 住宿; within a category by event order, that is by the primary
// voucher's materialId and then by itinerary leg), matching PAGE_DEFS in src/mock/fixtures/print.ts.
export const PRINT_PAGES = [
  { id: 'pg1', file: 'print-pg1.png', nos: 'No.1-3', date: '08-10', category: '外地市内交通', amount: '69.19', top: 'm03', bottom: 'm04', rotateTop: false, rotateBottom: false },
  { id: 'pg2', file: 'print-pg2.png', nos: 'No.4', date: '08-11', category: '外地市内交通', amount: '38.40', top: 'm05', bottom: 'm06', rotateTop: false, rotateBottom: false },
  { id: 'pg3', file: 'print-pg3.png', nos: 'No.5', date: '08-15', category: '外地市内交通', amount: '32.00', top: 'm09', bottom: null, rotateTop: true, rotateBottom: false },
  { id: 'pg4', file: 'print-pg4.png', nos: 'No.6', date: '08-19', category: '外地市内交通', amount: '47.00', top: 'm10', bottom: null, rotateTop: true, rotateBottom: false },
  { id: 'pg5', file: 'print-pg5.png', nos: 'No.7', date: '08-09', category: '长途交通', amount: '73.00', top: 'm07', bottom: null, rotateTop: false, rotateBottom: false },
  { id: 'pg6', file: 'print-pg6.png', nos: 'No.8', date: '08-22', category: '长途交通', amount: '73.00', top: 'm08', bottom: null, rotateTop: false, rotateBottom: false },
  { id: 'pg7', file: 'print-pg7.png', nos: 'No.9', date: '08-09', category: '住宿', amount: '3640.00', top: 'm01', bottom: 'm02', rotateTop: false, rotateBottom: true },
];

export const DINING_PRINT_PAGES = [
  { id: 'dining', file: 'print-dining.png', nos: 'No.1', date: '08-14', category: '招待费', amount: '240.00', top: 'm11', bottom: 'm13', rotateTop: false, rotateBottom: false },
];
export const DINING_PRINT_SHEET_FILE = 'print-dining-sheet.pdf';

export function headerOf(page) {
  return `${page.nos} · ${page.date} · ${page.category} · ${page.amount}`;
}

// Rotation variants (#104): any placed material on a page can be turned upright or rotated 90°, and the mock server
// serves a different page image for it.
// The file name carries the suffix `-r<top><bottom>`, 1 = rotated 90° (`print-pg3-r10.png`); the combination that
// equals the default placement is `print-pgN.png` itself.
export function printPageFile(page, rotateTop, rotateBottom) {
  if (rotateTop === page.rotateTop && (page.bottom === null || rotateBottom === page.rotateBottom)) return page.file;
  const flags = page.bottom === null ? `${rotateTop ? 1 : 0}` : `${rotateTop ? 1 : 0}${rotateBottom ? 1 : 0}`;
  return `print-${page.id}-r${flags}.png`;
}

// Every rotation combination other than the default placement: one for a page without a bottom half, three with one.
export const PRINT_VARIANTS = [...PRINT_PAGES, ...DINING_PRINT_PAGES].flatMap((page) => {
  const combos = page.bottom === null ? [[true, false], [false, false]] : [[false, false], [false, true], [true, false], [true, true]];
  return combos
    .map(([rotateTop, rotateBottom]) => ({ ...page, rotateTop, rotateBottom, file: printPageFile(page, rotateTop, rotateBottom) }))
    .filter((variant) => variant.file !== page.file);
});

// The merged print-sheet sample: the seven default page images composed in page order into one A4 PDF, which the
// mock's 「下载打印稿 PDF」 points at.
export const PRINT_SHEET_FILE = 'print-sheet.pdf';

// Regression fixtures (#199): the goods table of a real 全电发票 (fully-digitalised VAT e-invoice) is not drawn the way
// a hand-written HTML table is. The column header is centred over a column far wider than the label, while the cell
// under it is left-aligned at the column's border, so the 项目名称 (item name) cell and the 合计 (row total) label are
// printed well left of the 项目名称 header's own left edge. Real ride-hailing faces also omit the 单位 (unit) column
// and print 单价 (unit price) before 数量 (quantity).

// The item name and the 合计 label both sit left of the header label: with the column band starting at the header's
// left edge, neither lands in a column, so the table has no item row and no 合计 row at all.
export const WIDE_COLUMN_INVOICE = {
  id: 'r207',
  file: 'r207-einvoice-wide-name-column.pdf',
  title: '电子发票（普通发票）',
  number: '26312000000104412931',
  date: '2026年08月18日',
  seller: { name: '某某出行科技（广州）有限公司', taxNo: '91440000TTTTTTTT0G' },
  rows: [{ name: '*交通运输服务*客运服务费', unit: '', qty: '1', price: '31.55', net: '31.55', rate: '3%', tax: '0.95' }],
  net: '31.55',
  tax: '0.95',
  gross: '32.50',
  grossWords: '叁拾贰圆伍角整',
  wideNameColumn: true,
};

// The same wide column with an item name too long for it: the issuer wraps the name, and its tail is printed as a row
// of its own with nothing in any other column. The first line is wide enough to be centred right of the header, so the
// name is found but cut short, while the 合计 label is still lost.
export const WRAPPED_ITEM_INVOICE = {
  id: 'r208',
  file: 'r208-einvoice-wrapped-item-name.pdf',
  title: '电子发票（普通发票）',
  number: '26312000000104412947',
  date: '2026年08月19日',
  seller: { name: '某某出行科技（广州）有限公司', taxNo: '91440000TTTTTTTT0G' },
  rows: [{ name: '*交通运输服务*客运服务费（含高速费、停车费、预约调度费）', unit: '', qty: '1', price: '46.60', net: '46.60', rate: '3%', tax: '1.40' }],
  net: '46.60',
  tax: '1.40',
  gross: '48.00',
  grossWords: '肆拾捌圆整',
  wideNameColumn: true,
};

export const DINING_RECEIPT_PHOTO = { ...DISCOUNTED_DINING_RECEIPT, id: 'm16', title: '消费小票' };
