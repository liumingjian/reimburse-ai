import type {
  ExtractedDocument,
  FieldCandidate,
  Money,
  OtherVoucherDocument,
  RideSegment,
  TextObservation,
} from "./types.js";

export type DocumentParseResult =
  | { kind: "document"; document: ExtractedDocument }
  | { kind: "multiple_documents" }
  | { kind: "insufficient_evidence" };

const missing = <T>(): FieldCandidate<T> => ({ evidenceState: "missing", sourceRefs: [] });

export function extractDocument(observations: readonly TextObservation[]): DocumentParseResult {
  const text = observations.map((line) => clean(line.text)).join("\n");
  if (!text.trim()) return { kind: "insufficient_evidence" };
  if ((text.match(/增值税[^\n]{0,12}发票/g) ?? []).length > 1) return { kind: "multiple_documents" };

  if (/增值税[^\n]{0,12}发票/.test(text)) return usable(vatInvoice(observations));
  if (/铁路电子客票|中国铁路|12306|(?:\b[GDCKTZ]\d{1,4}次?\b).*(?:车站|检票|车厢|乘车)/is.test(text)) {
    return usable(railTicket(observations));
  }
  if (/行程单|网约车|滴滴出行|高德打车|曹操出行|T3出行/.test(text)) {
    return usable(rideItinerary(observations));
  }
  if (/(酒店|宾馆|饭店).*(入住|离店|退房)|(入住|离店|退房).*(酒店|宾馆|饭店)/s.test(text)) {
    return usable(hotelFolio(observations));
  }
  if (/交易单号|支付成功|付款方|收款方|支付时间/.test(text)) {
    return usable(paymentSlip(observations));
  }
  if (/道路客运|汽车票|客运票|公路客票/.test(text)) {
    return usable(roadTicket(observations));
  }

  const other = otherVoucher(observations);
  if (other.fields.amount.evidenceState === "missing" && other.fields.date.evidenceState === "missing") {
    return { kind: "insufficient_evidence" };
  }
  return { kind: "document", document: other };
}

function usable(document: ExtractedDocument): DocumentParseResult {
  const present = (candidate: FieldCandidate<unknown>) => candidate.evidenceState !== "missing";
  let enough = false;
  switch (document.type) {
    case "vat_invoice":
      enough = present(document.fields.invoiceNumber) && present(document.fields.totalAmount);
      break;
    case "rail_ticket":
    case "road_passenger_ticket":
      enough = present(document.fields.travelDate) && present(document.fields.traveler)
        && present(document.fields.origin) && present(document.fields.destination) && present(document.fields.amount);
      break;
    case "ride_itinerary": {
      const segment = document.fields.segments[0];
      enough = present(document.fields.totalAmount) && !!segment && present(segment.travelDate)
        && present(segment.origin) && present(segment.destination);
      break;
    }
    case "hotel_folio":
      enough = present(document.fields.guestName) && present(document.fields.checkInDate)
        && present(document.fields.checkOutDate) && present(document.fields.totalAmount);
      break;
    case "payment_slip":
      enough = present(document.fields.payee) && present(document.fields.paidAt) && present(document.fields.amount);
      break;
    case "other_voucher":
      enough = present(document.fields.amount) || present(document.fields.date);
      break;
  }
  return enough ? { kind: "document", document } : { kind: "insufficient_evidence" };
}

function vatInvoice(lines: readonly TextObservation[]): ExtractedDocument {
  return {
    type: "vat_invoice",
    fields: {
      invoiceNumber: stringField(lines, ["发票号码", "发票号"], /[A-Z0-9]{8,20}/i),
      issueDate: dateField(lines, ["开票日期", "开票时间"]),
      netAmount: moneyField(lines, ["不含税金额", "金额"]),
      taxAmount: moneyField(lines, ["税额"]),
      totalAmount: moneyField(lines, ["价税合计", "小写"]),
      sellerName: stringField(lines, ["销售方名称", "销方名称", "销售方"], /[^\s:：]{2,60}/),
      buyerName: stringField(lines, ["购买方名称", "购方名称", "购买方"], /[^\s:：]{2,60}/),
      itemName: stringField(lines, ["项目名称", "货物或应税劳务名称"], /[^\s:：]{2,60}/),
    },
  };
}

function railTicket(lines: readonly TextObservation[]): ExtractedDocument {
  const [labeledOrigin, labeledDestination] = routeFields(lines);
  const [stationOrigin, stationDestination] = stationRoute(lines);
  return {
    type: "rail_ticket",
    fields: {
      invoiceNumber: stringField(lines, ["发票号码", "电子客票号", "票号"], /[A-Z0-9]{8,24}/i),
      travelDate: prefer(dateField(lines, ["乘车日期", "开车日期", "日期"]), anyDate(lines)),
      travelTime: prefer(timeField(lines, ["开车时间", "乘车时间", "时间"]), anyTime(lines)),
      traveler: prefer(
        stringField(lines, ["旅客", "乘车人", "姓名"], /[\p{Script=Han}A-Za-z·]{2,30}/u),
        travelerAfterIdentity(lines),
      ),
      origin: prefer(labeledOrigin, stationOrigin),
      destination: prefer(labeledDestination, stationDestination),
      trainNumber: firstMatch(lines, /\b[GDCKTZS]\d{1,4}次?\b/i, (v) => v.replace(/次$/, "").toUpperCase()),
      seat: prefer(stringField(lines, ["席别", "座位", "座号"], /[^\s:：]{2,30}/),
        firstMatch(lines, /[^\s]{1,8}(?:座|卧)/, (value) => value)),
      amount: prefer(moneyField(lines, ["票价", "金额", "合计"]), anyMoney(lines)),
    },
  };
}

function roadTicket(lines: readonly TextObservation[]): ExtractedDocument {
  const [origin, destination] = routeFields(lines);
  return {
    type: "road_passenger_ticket",
    fields: {
      ticketNumber: stringField(lines, ["票号", "客票号"], /[A-Z0-9]{6,24}/i),
      travelDate: dateField(lines, ["乘车日期", "发车日期", "日期"]),
      travelTime: timeField(lines, ["发车时间", "乘车时间", "时间"]),
      traveler: stringField(lines, ["旅客", "乘车人", "姓名"], /[\p{Script=Han}A-Za-z·]{2,30}/u),
      origin,
      destination,
      amount: moneyField(lines, ["票价", "金额", "合计"]),
    },
  };
}

function rideItinerary(lines: readonly TextObservation[]): ExtractedDocument {
  const [origin, destination] = routeFields(lines);
  const segment: RideSegment = {
    travelDate: dateField(lines, ["出发时间", "用车时间", "日期"]),
    travelTime: timeField(lines, ["出发时间", "用车时间", "时间"]),
    city: stringField(lines, ["城市", "用车城市"], /[\p{Script=Han}A-Za-z]{2,30}/u),
    origin,
    destination,
    amount: moneyField(lines, ["行程金额", "实付金额", "金额"]),
  };
  return {
    type: "ride_itinerary",
    fields: {
      traveler: stringField(lines, ["乘车人", "用车人", "姓名"], /[\p{Script=Han}A-Za-z·]{2,30}/u),
      totalAmount: moneyField(lines, ["合计金额", "总金额", "实付金额", "合计"]),
      segments: hasSegmentValue(segment) ? [segment] : [],
    },
  };
}

function hotelFolio(lines: readonly TextObservation[]): ExtractedDocument {
  const title = lines.find((line) => /酒店|宾馆|饭店/.test(line.text));
  return {
    type: "hotel_folio",
    fields: {
      hotelName: title ? explicit(title, clean(title.text), clean(title.text)) : missing(),
      guestName: stringField(lines, ["宾客姓名", "客人姓名", "入住人", "姓名"], /[\p{Script=Han}A-Za-z·]{2,30}/u),
      city: stringField(lines, ["城市", "所在城市"], /[\p{Script=Han}A-Za-z]{2,30}/u),
      checkInDate: dateField(lines, ["入住日期", "入住时间", "到店日期", "抵店"]),
      checkOutDate: dateField(lines, ["离店日期", "退房日期", "离店时间", "离店", "退房"]),
      totalAmount: moneyField(lines, ["实收金额", "应收金额", "实收", "应收", "合计金额", "消费总", "合计"]),
    },
  };
}

function paymentSlip(lines: readonly TextObservation[]): ExtractedDocument {
  return {
    type: "payment_slip",
    fields: {
      payer: stringField(lines, ["付款方", "付款人"], /[^\s:：]{2,60}/),
      payee: stringField(lines, ["收款方", "收款人", "商户全称"], /[^\s:：]{2,60}/),
      paidAt: dateTimeField(lines, ["支付时间", "交易时间", "付款时间"]),
      transactionNumber: stringField(lines, ["交易单号", "订单号", "商户单号"], /[A-Z0-9-]{8,64}/i),
      amount: moneyField(lines, ["支付金额", "付款金额", "实付", "金额"]),
    },
  };
}

function otherVoucher(lines: readonly TextObservation[]): OtherVoucherDocument {
  const title = lines.find((line) => clean(line.text).length >= 2);
  return {
    type: "other_voucher",
    fields: {
      title: title ? explicit(title, clean(title.text), clean(title.text)) : missing(),
      merchant: stringField(lines, ["商户", "商家", "收款方", "销售方"], /[^\s:：]{2,60}/),
      date: dateField(lines, ["日期", "时间", "消费时间"]),
      amount: moneyField(lines, ["合计", "实付", "金额", "应付"]),
    },
  };
}

function stringField(
  lines: readonly TextObservation[],
  labels: readonly string[],
  valuePattern: RegExp,
): FieldCandidate<string> {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) continue;
    for (const label of labels) {
      const at = clean(line.text).indexOf(label);
      if (at < 0) continue;
      const tail = clean(line.text).slice(at + label.length).replace(/^[\s:：()（）]+/, "");
      const inline = tail.match(valuePattern)?.[0];
      if (inline) return explicit(line, inline, inline.trim());
      const next = lines[index + 1];
      const adjacent = next && clean(next.text).match(valuePattern)?.[0];
      if (next && adjacent) return explicit(next, adjacent, adjacent.trim());
    }
  }
  return missing();
}

function dateField(lines: readonly TextObservation[], labels: readonly string[]): FieldCandidate<string> {
  const date = labeledMatch(lines, labels, /(20\d{2})[年/.\-](\d{1,2})[月/.\-](\d{1,2})日?/);
  if (!date) return missing();
  const [, year, month, day] = date.match;
  if (!year || !month || !day || !validDate(+year, +month, +day)) return missing();
  return explicit(date.line, date.match[0], `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`);
}

function timeField(lines: readonly TextObservation[], labels: readonly string[]): FieldCandidate<string> {
  const time = labeledMatch(lines, labels, /(?:[01]?\d|2[0-3]):[0-5]\d/);
  if (!time) return missing();
  const [hour, minute] = time.match[0].split(":");
  return explicit(time.line, time.match[0], `${hour?.padStart(2, "0")}:${minute}`);
}

function dateTimeField(lines: readonly TextObservation[], labels: readonly string[]): FieldCandidate<string> {
  const value = labeledMatch(lines, labels, /(20\d{2})[年/.\-](\d{1,2})[月/.\-](\d{1,2})日?\s+((?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?)/);
  if (!value) return missing();
  const [, year, month, day, time] = value.match;
  if (!year || !month || !day || !time || !validDate(+year, +month, +day)) return missing();
  return explicit(value.line, value.match[0], `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}T${time}`);
}

function moneyField(lines: readonly TextObservation[], labels: readonly string[]): FieldCandidate<Money> {
  const value = labeledMatch(lines, labels, /[-+]?[¥￥]?\s*\d[\d,]*(?:\.\d{1,2})?/);
  if (!value) return missing();
  const raw = value.match[0].trim();
  const number = Number(raw.replace(/[¥￥,\s]/g, ""));
  if (!Number.isFinite(number)) return missing();
  return explicit(value.line, raw, { currency: "CNY", cents: Math.round(number * 100) });
}

function routeFields(lines: readonly TextObservation[]): [FieldCandidate<string>, FieldCandidate<string>] {
  for (const line of lines) {
    const match = clean(line.text).match(/([^\s:：→>-]{2,20}(?:站|机场|酒店|大厦|小区)?)\s*(?:→|->|—|至)\s*([^\s:：→>-]{2,20}(?:站|机场|酒店|大厦|小区)?)/);
    if (match?.[1] && match[2]) return [explicit(line, match[1], match[1]), explicit(line, match[2], match[2])];
  }
  return [
    stringField(lines, ["出发地", "起点", "始发站", "出发站"], /[^\s:：]{2,40}/),
    stringField(lines, ["目的地", "终点", "到达站", "终到站"], /[^\s:：]{2,40}/),
  ];
}

function stationRoute(lines: readonly TextObservation[]): [FieldCandidate<string>, FieldCandidate<string>] {
  const stations = lines
    .filter((line) => /^[\p{Script=Han}]{2,12}站$/u.test(clean(line.text)))
    .flatMap((line) => {
      const point = center(line);
      return point ? [{ line, point }] : [];
    });
  for (const left of stations) {
    const right = stations.find((candidate) => candidate.point.x > left.point.x
      && Math.abs(candidate.point.y - left.point.y) <= 80);
    if (right) {
      return [
        explicit(left.line, clean(left.line.text), clean(left.line.text)),
        explicit(right.line, clean(right.line.text), clean(right.line.text)),
      ];
    }
  }
  return [missing(), missing()];
}

function anyDate(lines: readonly TextObservation[]): FieldCandidate<string> {
  for (const line of lines) {
    const match = clean(line.text).match(/(20\d{2})[年/.\-](\d{1,2})[月/.\-](\d{1,2})日?/);
    if (!match?.[1] || !match[2] || !match[3] || !validDate(+match[1], +match[2], +match[3])) continue;
    return explicit(line, match[0], `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`);
  }
  return missing();
}

function anyTime(lines: readonly TextObservation[]): FieldCandidate<string> {
  for (const line of lines) {
    const match = clean(line.text).match(/(?:[01]?\d|2[0-3]):[0-5]\d/);
    if (!match) continue;
    const [hour, minute] = match[0].split(":");
    return explicit(line, match[0], `${hour?.padStart(2, "0")}:${minute}`);
  }
  return missing();
}

function anyMoney(lines: readonly TextObservation[]): FieldCandidate<Money> {
  for (const line of lines) {
    const match = clean(line.text).match(/[¥￥]\s*(\d[\d,]*(?:\.\d{1,2})?)/);
    if (!match?.[1]) continue;
    return explicit(line, match[0], { currency: "CNY", cents: Math.round(Number(match[1].replaceAll(",", "")) * 100) });
  }
  return missing();
}

function travelerAfterIdentity(lines: readonly TextObservation[]): FieldCandidate<string> {
  for (const line of lines) {
    const match = clean(line.text).match(/[0-9*]{10,20}\s+([\p{Script=Han}·]{2,20})$/u);
    if (match?.[1]) return explicit(line, match[1], match[1]);
  }
  return missing();
}

function prefer<T>(first: FieldCandidate<T>, fallback: FieldCandidate<T>): FieldCandidate<T> {
  return first.evidenceState === "missing" ? fallback : first;
}

function labeledMatch(lines: readonly TextObservation[], labels: readonly string[], pattern: RegExp) {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) continue;
    const value = clean(line.text);
    for (const label of labels) {
      const at = value.indexOf(label);
      if (at < 0) continue;
      const match = value.slice(at + label.length).match(pattern);
      if (match) return { line, match };
      const next = lines[index + 1];
      const nextMatch = next && clean(next.text).match(pattern);
      if (next && nextMatch) return { line: next, match: nextMatch };
      const nearby = spatialValue(lines, line, pattern);
      if (nearby) return nearby;
    }
  }
  return undefined;
}

function spatialValue(lines: readonly TextObservation[], label: TextObservation, pattern: RegExp) {
  const labelCenter = center(label);
  if (!labelCenter) return undefined;
  const candidates = lines.flatMap((line) => {
    if (line === label) return [];
    const match = clean(line.text).match(pattern);
    const lineCenter = center(line);
    if (!match || !lineCenter || lineCenter.x <= labelCenter.x) return [];
    const vertical = Math.abs(lineCenter.y - labelCenter.y);
    if (vertical > 70) return [];
    return [{ line, match, distance: vertical * 4 + lineCenter.x - labelCenter.x }];
  });
  return candidates.sort((left, right) => left.distance - right.distance)[0];
}

function center(line: TextObservation): { x: number; y: number } | undefined {
  if (!line.polygon.length) return undefined;
  const sum = line.polygon.reduce((value, point) => ({ x: value.x + point[0], y: value.y + point[1] }), { x: 0, y: 0 });
  return { x: sum.x / line.polygon.length, y: sum.y / line.polygon.length };
}

function firstMatch<T>(
  lines: readonly TextObservation[],
  pattern: RegExp,
  normalize: (value: string) => T,
): FieldCandidate<T> {
  for (const line of lines) {
    const value = clean(line.text).match(pattern)?.[0];
    if (value) return explicit(line, value, normalize(value));
  }
  return missing();
}

function explicit<T>(line: TextObservation, raw: string, normalized: T): FieldCandidate<T> {
  return { evidenceState: "explicit", raw, normalized, sourceRefs: [line.id], recognitionScore: line.score };
}

function clean(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function validDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function hasSegmentValue(segment: RideSegment): boolean {
  return Object.values(segment).some((candidate) => candidate.evidenceState !== "missing");
}
