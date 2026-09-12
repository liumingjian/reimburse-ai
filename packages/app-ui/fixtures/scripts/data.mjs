// 夹具数据：全部虚构，沿用原型（林颂宜、2026-08 上海出差）的人物与数字。不含任何真实个人信息。
// 这里是模板的唯一数据来源；src/mock/fixtures 里的快照字段值与此逐一对应。

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

// 出租车票：m10 的下车时间在票面上是 19:06，但打印褪色，照片读数会读成 90:60（原型剧本）。
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

export const OTHER_INVOICE = {
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

// 打印稿页（原型 PAGES）：费用类别用内核标签。页眉是 `No.x · 日期 · 类别 · 价税合计`，范围用 ASCII 连字符。
export const PRINT_PAGES = [
  { id: 'pg1', file: 'print-pg1.png', nos: 'No.1', date: '08-09', category: '长途交通', amount: '73.00', top: 'm07', bottom: null, rotateTop: false, rotateBottom: false },
  { id: 'pg2', file: 'print-pg2.png', nos: 'No.2', date: '08-09', category: '住宿', amount: '3640.00', top: 'm01', bottom: 'm02', rotateTop: false, rotateBottom: true },
  { id: 'pg3', file: 'print-pg3.png', nos: 'No.3-5', date: '08-10', category: '外地市内交通', amount: '69.19', top: 'm03', bottom: 'm04', rotateTop: false, rotateBottom: false },
  { id: 'pg4', file: 'print-pg4.png', nos: 'No.6', date: '08-11', category: '外地市内交通', amount: '38.40', top: 'm05', bottom: 'm06', rotateTop: false, rotateBottom: false },
  { id: 'pg5', file: 'print-pg5.png', nos: 'No.7', date: '08-15', category: '外地市内交通', amount: '32.00', top: 'm09', bottom: null, rotateTop: true, rotateBottom: false },
  { id: 'pg6', file: 'print-pg6.png', nos: 'No.8', date: '08-19', category: '外地市内交通', amount: '47.00', top: 'm10', bottom: null, rotateTop: true, rotateBottom: false },
  { id: 'pg7', file: 'print-pg7.png', nos: 'No.9', date: '08-22', category: '长途交通', amount: '73.00', top: 'm08', bottom: null, rotateTop: false, rotateBottom: false },
];

export function headerOf(page) {
  return `${page.nos} · ${page.date} · ${page.category} · ${page.amount}`;
}

// 旋转变体（#104）：页面上可以把任一份放置的材料改为竖放 / 旋转 90°，mock 服务端据此换一张页图。
// 文件名后缀 `-r<上><下>`，1 = 旋转 90°，如 `print-pg3-r10.png`；与默认放置相同的组合就是 `print-pgN.png` 本身。
export function printPageFile(page, rotateTop, rotateBottom) {
  if (rotateTop === page.rotateTop && (page.bottom === null || rotateBottom === page.rotateBottom)) return page.file;
  const flags = page.bottom === null ? `${rotateTop ? 1 : 0}` : `${rotateTop ? 1 : 0}${rotateBottom ? 1 : 0}`;
  return `print-${page.id}-r${flags}.png`;
}

// 每页除默认放置外的所有旋转组合：无下半页的页 1 个，有下半页的页 3 个。
export const PRINT_VARIANTS = PRINT_PAGES.flatMap((page) => {
  const combos = page.bottom === null ? [[true, false], [false, false]] : [[false, false], [false, true], [true, false], [true, true]];
  return combos
    .map(([rotateTop, rotateBottom]) => ({ ...page, rotateTop, rotateBottom, file: printPageFile(page, rotateTop, rotateBottom) }))
    .filter((variant) => variant.file !== page.file);
});

// 合并打印稿样本：7 张默认页图按页序合成一份 A4 PDF，mock 的「下载打印稿 PDF」指向它。
export const PRINT_SHEET_FILE = 'print-sheet.pdf';
