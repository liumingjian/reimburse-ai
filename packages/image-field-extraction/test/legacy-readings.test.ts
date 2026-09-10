import assert from "node:assert/strict";
import test from "node:test";

import { toLegacyReadings } from "../src/legacy-readings.js";
import type { ExtractedDocument, FieldCandidate, ImageFieldExtractionBatch, Money } from "../src/types.js";

const text = (value: string): FieldCandidate<string> => ({
  evidenceState: "explicit", raw: value, normalized: value, sourceRefs: ["o1"], recognitionScore: 0.99,
});
const money = (cents: number): FieldCandidate<Money> => ({
  evidenceState: "explicit", raw: (cents / 100).toFixed(2), normalized: { currency: "CNY", cents },
  sourceRefs: ["o1"], recognitionScore: 0.99,
});
const missing = <T>(): FieldCandidate<T> => ({ evidenceState: "missing", sourceRefs: [] });

test("酒店字段转换为内核已有的规范字段", () => {
  const readings = toLegacyReadings(batch({
    type: "hotel_folio",
    fields: {
      hotelName: text("示例酒店"), guestName: text("测试员工"), city: text("广州"),
      checkInDate: text("2026-09-01"), checkOutDate: text("2026-09-03"), totalAmount: money(120000),
    },
  })).readings;
  assert.deepEqual(readings[0]?.fields, {
    hotelName: "示例酒店", guestName: "测试员工", city: "广州",
    checkIn: "2026-09-01", checkOut: "2026-09-03", folioTotal: "1200.00",
  });
});

test("看不清的酒店字段也使用内核规范名", () => {
  const readings = toLegacyReadings(batch({
    type: "hotel_folio",
    fields: {
      hotelName: text("示例酒店"), guestName: text("测试员工"), city: text("广州"),
      checkInDate: missing(), checkOutDate: missing(), totalAmount: missing(),
    },
  })).readings;
  assert.ok(Array.isArray(readings[0]?.unreadable));
  assert.deepEqual(readings[0]?.unreadable, ["checkIn", "checkOut", "folioTotal"]);
});

test("发票 legacy 读数只保留价税合计字段", () => {
  const readings = toLegacyReadings(batch({
    type: "vat_invoice",
    fields: {
      invoiceNumber: missing(), issueDate: missing(), netAmount: missing(), taxAmount: missing(),
      totalAmount: money(1880), sellerName: missing(), buyerName: missing(), itemName: missing(),
    },
  })).readings;
  assert.deepEqual(readings[0]?.fields, { totalAmount: "18.80" });
  assert.deepEqual(readings[0]?.unreadable, []);
});

test("看不清的发票只报告价税合计缺失", () => {
  const readings = toLegacyReadings(batch({
    type: "vat_invoice",
    fields: {
      invoiceNumber: missing(), issueDate: missing(), netAmount: missing(), taxAmount: missing(),
      totalAmount: missing(), sellerName: missing(), buyerName: missing(), itemName: missing(),
    },
  })).readings;
  assert.deepEqual(readings[0]?.fields, {});
  assert.deepEqual(readings[0]?.unreadable, ["totalAmount"]);
});

test("网约车行程单保留全部逐段事实", () => {
  const readings = toLegacyReadings(batch({
    type: "ride_itinerary",
    fields: {
      traveler: missing(), totalAmount: money(3000),
      segments: [
        { travelDate: text("2026-09-01"), travelTime: text("08:30"), city: text("广州"),
          origin: text("甲"), destination: text("乙"), amount: money(1000) },
        { travelDate: text("2026-09-02"), travelTime: text("09:30"), city: text("广州"),
          origin: text("丙"), destination: text("丁"), amount: money(2000) },
      ],
    },
  })).readings;
  assert.deepEqual(readings[0]?.segments, [
    { travelDate: "2026-09-01", travelTime: "08:30", city: "广州", origin: "甲", destination: "乙", amount: "10.00" },
    { travelDate: "2026-09-02", travelTime: "09:30", city: "广州", origin: "丙", destination: "丁", amount: "20.00" },
  ]);
});

function batch(document: ExtractedDocument): ImageFieldExtractionBatch {
  return {
    contractVersion: 1,
    items: [{ status: "extracted", materialId: "m-1", contentHash: "a".repeat(64), document,
      evidence: [], provenance: { adapter: "test", engineVersion: "1", model: "test", durationMs: 1 } }],
    metrics: { durationMs: 1, peakRssBytes: null },
  };
}
