// HTML 模板：每份材料一个片段 { id, width, height, css, body }，由 generate.mjs 包成完整文档交给 headless Chrome。
// 尺寸按 96dpi 像素：A4 纵向 794x1123，横向 1123x794。样式只服务夹具外观，与应用的 DESIGN.md 无关。
import {
  AMAP_INVOICE,
  AMAP_ITINERARY,
  BUNDLED_FEE_INVOICE,
  AMAP_ITINERARY_GAP,
  AMAP_ITINERARY_WRAPPED,
  BUYER,
  CAOCAO_INVOICE,
  CAOCAO_ITINERARY,
  HOTEL_FOLIO,
  HOTEL_INVOICE,
  OTHER_INVOICE,
  PRINT_PAGES,
  PRINT_VARIANTS,
  RAIL_0809,
  RAIL_0822,
  RAIL_SPLIT_RUNS,
  SPACED_TITLE_INVOICE,
  TRANSPORT_INVOICE,
  SPLIT_NUMBER_INVOICE,
  TAXI_0815,
  TAXI_0819,
  headerOf,
} from './data.mjs';

export const A4 = { width: 794, height: 1123 };
export const A4_LANDSCAPE = { width: 1123, height: 794 };
export const PHOTO = { width: 900, height: 1200 };

// 字体决定文本层能否被原样抽回：PingFang / Songti / Hiragino 的 ToUnicode 会把「入日子金」等映射成康熙部首码位，
// STHeiti / Yuanti SC / Arial Unicode MS / LiSong Pro 在 Chrome 152 下抽回的是正常汉字（fixtures/scripts/verify.mjs 会校验）。
const FONT = '"STHeiti", "Yuanti SC", "Arial Unicode MS", "LiSong Pro", sans-serif';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ---- 全电发票（专票/普票共用版式，只换标题与颜色）----
function invoice(data, accent) {
  const css = `
.inv { width: 794px; height: 1123px; padding: 56px 48px; font-family: ${FONT}; color: #222; font-size: 13px; position: relative; background: #fff; }
.inv .title { text-align: center; font-size: 26px; color: ${accent}; letter-spacing: 6px; border-bottom: 2px solid ${accent}; padding-bottom: 6px; margin: 0 120px 8px; }
.inv .title-under { margin: 0 120px 18px; border-bottom: 1px solid ${accent}; }
.inv .meta { text-align: right; font-size: 13px; line-height: 1.8; margin-bottom: 10px; }
.inv .meta .apart { margin-left: 4px; }
.inv .title .beside { font-size: 13px; letter-spacing: 0; margin-left: 24px; }
.inv .qr { position: absolute; left: 48px; top: 48px; width: 82px; height: 82px; border: 2px solid #333; display: grid; place-items: center; font-size: 11px; color: #555; }
.inv table { width: 100%; border-collapse: collapse; margin-top: 12px; }
.inv th, .inv td { border: 1px solid ${accent}; padding: 7px 8px; text-align: left; font-weight: 400; }
.inv th { color: ${accent}; }
.inv td.num { text-align: right; font-variant-numeric: tabular-nums; }
.inv .party { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.inv .party div { border: 1px solid ${accent}; padding: 8px 10px; line-height: 1.9; }
.inv .party b { color: ${accent}; font-weight: 400; margin-right: 8px; }
.inv .total { border: 1px solid ${accent}; padding: 8px 10px; display: flex; gap: 32px; }
.inv .total b { color: ${accent}; font-weight: 400; }
.inv .foot { margin-top: 24px; display: flex; justify-content: space-between; color: #555; }
.inv .stamp { position: absolute; right: 70px; bottom: 120px; width: 150px; height: 150px; border: 3px solid rgba(200, 40, 40, 0.75); border-radius: 50%; color: rgba(200, 40, 40, 0.75); display: grid; place-items: center; font-size: 12px; text-align: center; transform: rotate(-12deg); }
`;
  const rows = data.rows
    .map(
      (r) =>
        `<tr><td>${esc(r.name)}</td><td>${esc(r.unit)}</td><td class="num">${esc(r.qty)}</td><td class="num">${esc(r.price)}</td><td class="num">${esc(r.net)}</td><td class="num">${esc(r.rate)}</td><td class="num">${esc(r.tax)}</td></tr>`,
    )
    .join('');
  // 文本串切分（#200）：逐字成串的标题、与标签分开成串的号码，都是真实发票里常见的画法。
  const titleText = data.spacedTitle ? [...data.title].map((ch) => `<span>${esc(ch)}</span>`).join('') : esc(data.title);
  // 同基线并排（#206）：标题旁印着联次，号码与开票日期共用一行，各自标签与取值分成两串。整行连起来，
  // 三个锚点一个也匹配不上——只有行内的连续片段才正好是一个字段。
  const title = data.sharedBaseline ? `${titleText}<span class="beside">发票联</span>` : titleText;
  const number = data.splitNumber || data.sharedBaseline ? `发票号码：<span class="apart">${esc(data.number)}</span>` : `发票号码：${esc(data.number)}`;
  const issued = data.sharedBaseline ? `开票日期：<span class="apart">${esc(data.date)}</span>` : `开票日期：${esc(data.date)}`;
  const meta = data.sharedBaseline ? `${number}<span class="apart">${issued}</span>` : `${number}<br>${issued}`;
  const body = `
<div class="inv">
  <div class="qr">二维码</div>
  <div class="title">${title}</div>
  <div class="title-under"></div>
  <div class="meta">${meta}</div>
  <div class="party">
    <div><b>购买方</b>名称：${esc(BUYER.name)}<br><b>信息</b>统一社会信用代码/纳税人识别号：${esc(BUYER.taxNo)}</div>
    <div><b>销售方</b>名称：${esc(data.seller.name)}<br><b>信息</b>统一社会信用代码/纳税人识别号：${esc(data.seller.taxNo)}</div>
  </div>
  <table>
    <tr><th>项目名称</th><th>单位</th><th>数量</th><th>单价</th><th>金额</th><th>税率/征收率</th><th>税额</th></tr>
    ${rows}
    <tr><td>合计</td><td></td><td></td><td></td><td class="num">¥${esc(data.net)}</td><td></td><td class="num">¥${esc(data.tax)}</td></tr>
  </table>
  <div class="total"><span><b>价税合计（大写）</b>${esc(data.grossWords)}</span><span><b>（小写）</b>¥${esc(data.gross)}</span></div>
  <div class="foot"><span>备注：本发票由夹具生成器生成，人物与数字均为虚构。</span><span>开票人：某某</span></div>
  <div class="stamp">上海某某<br>发票专用章<br>（示例）</div>
</div>`;
  return { id: data.id, ...A4, css, body };
}

// ---- 酒店结账单 ----
function folio(data) {
  const css = `
.folio { width: 794px; height: 1123px; padding: 64px 72px; font-family: ${FONT}; color: #222; font-size: 13px; background: #fff; }
.folio h1 { font-size: 22px; font-weight: 600; margin: 0 0 4px; }
.folio .sub { color: #666; margin-bottom: 24px; }
.folio .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 24px; line-height: 1.8; margin-bottom: 20px; }
.folio table { width: 100%; border-collapse: collapse; }
.folio th, .folio td { border-bottom: 1px solid #ccc; padding: 6px 4px; text-align: left; font-weight: 400; }
.folio th { color: #666; font-size: 12px; }
.folio td.num, .folio th.num { text-align: right; font-variant-numeric: tabular-nums; }
.folio .sum { margin-top: 16px; display: grid; grid-template-columns: 1fr auto; gap: 6px 32px; font-size: 14px; }
.folio .sum b { font-weight: 600; }
.folio .note { margin-top: 32px; color: #777; font-size: 12px; }
`;
  const nights = Number(data.nights);
  const start = new Date(`${data.checkIn}T00:00:00Z`);
  const rows = [];
  for (let i = 0; i < nights; i += 1) {
    const d = new Date(start.getTime() + i * 86400000).toISOString().slice(0, 10);
    rows.push(`<tr><td>${d}</td><td>房费 · 高级大床房</td><td class="num">${esc(data.rate)}</td></tr>`);
  }
  const body = `
<div class="folio">
  <h1>结账单 GUEST FOLIO</h1>
  <div class="sub">${esc(data.hotel)}</div>
  <div class="grid">
    <div>入住人：${esc(data.guest)}</div><div>房号：${esc(data.room)}</div>
    <div>入住日期：${esc(data.checkIn)}</div><div>离店日期：${esc(data.checkOut)}</div>
    <div>天数：${esc(data.nights)}</div><div>房价：${esc(data.rate)} / 晚</div>
  </div>
  <table>
    <tr><th>日期</th><th>项目</th><th class="num">金额</th></tr>
    ${rows.join('')}
  </table>
  <div class="sum"><span>消费合计</span><b>${esc(data.total)}</b><span>已付款（预授权结算）</span><b>${esc(data.paid)}</b><span>余额</span><b>0.00</b></div>
  <div class="note">本结账单为夹具生成器生成的示例，不是真实酒店单据。</div>
</div>`;
  return { id: data.id, ...A4, css, body };
}

// ---- 网约车行程单 ----
function itinerary(data) {
  const css = `
.itin { width: 794px; height: 1123px; padding: 64px 64px; font-family: ${FONT}; color: #222; font-size: 13px; background: #fff; }
.itin h1 { font-size: 24px; font-weight: 600; margin: 0 0 4px; letter-spacing: 2px; }
.itin .brand { color: #1a73e8; font-weight: 600; font-size: 14px; margin-bottom: 20px; }
.itin .meta { line-height: 1.9; margin-bottom: 8px; }
.itin .summary { font-size: 15px; margin: 8px 0 20px; }
.itin .summary .apart { margin-left: 3px; }
.itin table { width: 100%; border-collapse: collapse; }
.itin th, .itin td { border: 1px solid #d0d0d0; padding: 8px 6px; text-align: left; font-weight: 400; }
.itin th { background: #f2f4f7; font-size: 12px; }
.itin td.num { text-align: right; font-variant-numeric: tabular-nums; }
.itin .note { margin-top: 28px; color: #777; font-size: 12px; line-height: 1.7; }
`;
  // 文本串切分（#205）：真实行程单把上车时间画成日期一行、时刻一行，摘要行也拆成好几串。
  const rows = data.rows
    .map((r) => {
      const time = r.timeLines ? r.timeLines.map((line) => `<div>${esc(line)}</div>`).join('') : esc(r.time);
      return `<tr><td>${esc(r.no)}</td><td>${esc(r.car)}</td><td>${time}</td><td>${esc(r.city)}</td><td>${esc(r.from)}</td><td>${esc(r.to)}</td><td class="num">${esc(r.amount)}</td></tr>`;
    })
    .join('');
  const summary = data.splitSummary
    ? `<span>共计</span><span class="apart">${esc(data.count)}</span><span class="apart">单行程，合计</span><span class="apart">${esc(data.total)}</span><span class="apart">元</span>`
    : `共计${esc(data.count)}单行程，合计${esc(data.total)}元`;
  const body = `
<div class="itin">
  <h1>行程单</h1>
  <div class="brand">${esc(data.brand)}</div>
  <div class="meta">申请日期：${esc(data.applyDate)}<br>行程人手机：${esc(data.phone)}</div>
  <div class="summary">${summary}</div>
  <table>
    <tr><th>序号</th><th>车型</th><th>上车时间</th><th>城市</th><th>起点</th><th>终点</th><th>金额（元）</th></tr>
    ${rows}
  </table>
  <div class="note">行程单仅作为报销参考材料，不能替代发票。本行程单由夹具生成器生成，起终点为虚构地名。</div>
</div>`;
  return { id: data.id, ...A4, css, body };
}

// ---- 铁路电子客票（横向）----
function rail(data) {
  const css = `
.rail { width: 1123px; height: 794px; padding: 60px 80px; font-family: ${FONT}; color: #222; font-size: 15px; background: #fff; position: relative; }
.rail .title { text-align: center; font-size: 30px; color: #c0392b; letter-spacing: 8px; border-bottom: 2px solid #c0392b; padding-bottom: 8px; margin: 0 200px 6px; }
.rail .title-under { margin: 0 200px 16px; border-bottom: 1px solid #c0392b; }
.rail .meta { text-align: right; line-height: 1.9; margin-bottom: 12px; }
.rail .box { border: 1px solid #c0392b; padding: 24px 28px; line-height: 2.1; display: grid; grid-template-columns: 1fr 1fr; gap: 0 40px; }
.rail .route { font-size: 30px; font-weight: 600; grid-column: 1 / -1; margin-bottom: 8px; }
.rail .route small { font-size: 16px; font-weight: 400; margin: 0 16px; }
.rail .price { font-size: 26px; font-weight: 600; }
.rail .apart { margin-left: 6px; }
.rail .foot { margin-top: 24px; color: #666; font-size: 13px; }
`;
  // 文本串切分（#204）：车次后面再画一格座位号，「票价：」与金额分成两串 —— 真实客票就是这样画的。
  const route = data.seatOnTripRow
    ? `${esc(data.from)}<small>${esc(data.train)}</small>${esc(data.to)}<small>${esc(data.seat)}</small>`
    : `${esc(data.from)}<small>${esc(data.train)}</small>${esc(data.to)}`;
  const fare = data.splitFare ? `票价：<span class="apart">¥${esc(data.price)}</span>` : `票价：¥${esc(data.price)}`;
  const body = `
<div class="rail">
  <div class="title">电子发票（铁路电子客票）</div>
  <div class="title-under"></div>
  <div class="meta">发票号码：${esc(data.number)}<br>开票日期：${esc(data.date)}</div>
  <div class="box">
    <div class="route">${route}</div>
    <div>乘车日期：${esc(data.date)}</div><div>开车时间：${esc(data.depart)}</div>
    <div>席别：${esc(data.seatClass)}</div><div>座位：${esc(data.seat)}</div>
    <div>乘车人：${esc(data.passenger)}</div><div>证件号：${esc(data.idMasked)}</div>
    <div class="price">${fare}</div><div>购买方：${esc(BUYER.name)}</div>
  </div>
  <div class="foot">本客票由夹具生成器生成，车次、席位与人物均为虚构。</div>
</div>`;
  return { id: data.id, ...A4_LANDSCAPE, css, body };
}

// ---- 出租车车费发票（纸质长条票）----
// 单独作为条票片段（供打印页复用），照片版再把它放到桌面背景上。
export const TAXI_STRIP = { width: 300, height: 560 };
function taxiStrip(data) {
  const faded = data.faded ? 'opacity: 0.42; letter-spacing: 1px;' : '';
  const css = `
.taxi { width: 300px; height: 560px; padding: 22px 18px; font-family: "Courier New", Menlo, monospace; color: #a33; background: #fdfcf8; font-size: 13px; line-height: 1.55; }
.taxi .head { font-family: ${FONT}; text-align: center; font-size: 15px; margin-bottom: 8px; }
.taxi .row { display: flex; justify-content: space-between; align-items: center; height: 24px; }
.taxi .row span:first-child { font-family: ${FONT}; }
.taxi .amt { font-size: 20px; margin-top: 8px; height: 32px; }
.taxi .faded { ${faded} }
.taxi .tail { margin-top: 12px; font-family: ${FONT}; font-size: 11px; color: #b66; text-align: center; }
`;
  const body = `
<div class="taxi">
  <div class="head">上海市出租汽车发票<br>（示例票样）</div>
  <div class="row"><span>发票代码</span><span>${esc(data.code)}</span></div>
  <div class="row"><span>发票号码</span><span>${esc(data.number)}</span></div>
  <div class="row"><span>车号</span><span>${esc(data.plate)}</span></div>
  <div class="row"><span>日期</span><span>${esc(data.date)}</span></div>
  <div class="row"><span>上车</span><span>${esc(data.boardAt)}</span></div>
  <div class="row"><span>下车</span><span class="faded">${esc(data.alightAt)}</span></div>
  <div class="row"><span>单价</span><span>${esc(data.unitPrice)}</span></div>
  <div class="row"><span>里程</span><span>${esc(data.distance)}km</span></div>
  <div class="row"><span>等候</span><span>${esc(data.waiting)}</span></div>
  <div class="row amt"><span>金额</span><span>¥${esc(data.amount)}</span></div>
  <div class="tail">夹具生成器生成，非真实票据</div>
</div>`;
  return { id: `${data.id}-strip`, ...TAXI_STRIP, css, body };
}

// 照片：条票放在桌面上，略微倾斜并带一点透视，模拟手机拍摄。
function taxiPhoto(data) {
  const strip = taxiStrip(data);
  const css = `${strip.css}
.photo { width: 900px; height: 1200px; background: #b9a58a; position: relative; overflow: hidden; }
.photo .shade { position: absolute; inset: 0; background: rgba(60, 40, 20, 0.12); }
.photo .paper { position: absolute; left: 260px; top: 250px; transform: perspective(1400px) rotateX(6deg) rotate(-4deg) scale(1.35); transform-origin: center; box-shadow: 0 18px 40px rgba(0, 0, 0, 0.35); }
`;
  const body = `<div class="photo"><div class="shade"></div><div class="paper">${strip.body}</div></div>`;
  return { id: data.id, ...PHOTO, css, body };
}

export const DOCS = {
  m01: invoice(HOTEL_INVOICE, '#8b3a3a'),
  m02: folio(HOTEL_FOLIO),
  m03: invoice(AMAP_INVOICE, '#8b3a3a'),
  m04: itinerary(AMAP_ITINERARY),
  m05: invoice(CAOCAO_INVOICE, '#8b3a3a'),
  m06: itinerary(CAOCAO_ITINERARY),
  m07: rail(RAIL_0809),
  m08: rail(RAIL_0822),
  m09: taxiPhoto(TAXI_0815),
  m10: taxiPhoto(TAXI_0819),
  m11: invoice(OTHER_INVOICE, '#8b3a3a'),
  r01: invoice(SPLIT_NUMBER_INVOICE, '#8b3a3a'),
  r02: invoice(SPACED_TITLE_INVOICE, '#8b3a3a'),
  r201: invoice(BUNDLED_FEE_INVOICE, '#8b3a3a'),
  r206: invoice(TRANSPORT_INVOICE, '#8b3a3a'),
  r204: rail(RAIL_SPLIT_RUNS),
  m12: itinerary(AMAP_ITINERARY_GAP),
  r205: itinerary(AMAP_ITINERARY_WRAPPED),
};

// 打印页里放置的材料：出租车用裁边并透视矫正后的条票，其余用原件版式。
const PLACED = { ...DOCS, m09: taxiStrip(TAXI_0815), m10: taxiStrip(TAXI_0819) };

// ---- 打印页（A4 纵向：页眉 + 上半页主要报销凭证 + 下半页参考材料）----
function place(doc, slot, rotate) {
  const w = rotate ? doc.height : doc.width;
  const h = rotate ? doc.width : doc.height;
  const scale = Math.min(slot.width / w, slot.height / h);
  const left = (slot.width - w * scale) / 2;
  const top = (slot.height - h * scale) / 2;
  const transform = rotate
    ? `translate(${left + w * scale}px, ${top}px) rotate(90deg) scale(${scale})`
    : `translate(${left}px, ${top}px) scale(${scale})`;
  return `<div class="placed" style="transform: ${transform}">${doc.body}</div>`;
}

export function printPage(page) {
  const slot = { width: 714, height: 500 };
  const top = PLACED[page.top];
  const bottom = page.bottom ? PLACED[page.bottom] : null;
  const css = `
.sheet { width: 794px; height: 1123px; padding: 30px 40px; font-family: ${FONT}; background: #fff; color: #333; }
.sheet .hdr { font-family: "SF Mono", Menlo, monospace; font-size: 12px; color: #666; height: 24px; }
.sheet .half { position: relative; width: 714px; height: 500px; overflow: hidden; }
.sheet .half.top { border-bottom: 1px dashed #999; margin-bottom: 18px; }
.sheet .placed { position: absolute; left: 0; top: 0; transform-origin: top left; }
.sheet .blank { position: absolute; inset: 0; display: grid; place-items: center; color: #bbb; font-size: 14px; }
${top.css}
${bottom ? bottom.css : ''}
`;
  const body = `
<div class="sheet">
  <div class="hdr">${esc(headerOf(page))}</div>
  <div class="half top">${place(top, slot, page.rotateTop)}</div>
  <div class="half">${bottom ? place(bottom, slot, page.rotateBottom) : '<div class="blank">留白</div>'}</div>
</div>`;
  return { id: page.id, ...A4, css, body };
}

export const PRINT_DOCS = PRINT_PAGES.map(printPage);
export const VARIANT_DOCS = PRINT_VARIANTS.map((variant) => ({ ...printPage(variant), id: variant.file.replace(/\.png$/, '') }));

// 合并打印稿：每张页图一页 A4（210mm x 297mm，边距 0）。
export function printSheetDocument(imageUrls) {
  const pages = imageUrls.map((url) => `<img src="${esc(url)}" alt="">`).join('\n');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>print-sheet</title>
<style>
@page { size: 210mm 297mm; margin: 0; }
html, body { margin: 0; padding: 0; }
img { display: block; width: 210mm; height: 297mm; break-after: page; }
img:last-child { break-after: auto; }
</style>
</head>
<body>
${pages}
</body>
</html>`;
}

// 完整 HTML 文档：@page 尺寸与片段一致，边距 0，保证 --print-to-pdf 得到一页。
export function documentOf(doc) {
  const mm = (px) => `${((px * 25.4) / 96).toFixed(2)}mm`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${esc(doc.id)}</title>
<style>
@page { size: ${mm(doc.width)} ${mm(doc.height)}; margin: 0; }
html, body { margin: 0; padding: 0; }
body { width: ${doc.width}px; height: ${doc.height}px; overflow: hidden; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
* { box-sizing: border-box; }
${doc.css}
</style>
</head>
<body>${doc.body}</body>
</html>`;
}
