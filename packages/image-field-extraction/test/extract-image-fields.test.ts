import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { extractImageFields } from "../src/index.js";

const fixtureWorker = fileURLToPath(
  new URL("./fixtures/fake-worker.py", import.meta.url),
);
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const fengyunFixture = path.join(repoRoot, "resources/交通/fengyun-1.png");
const itineraryFixture = path.join(repoRoot, "resources/交通/行程单.png");

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0, 4, 0, 0, 0xff, 0xd9]);
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0]);

process.env.BAOX_IMAGE_WORKER = fixtureWorker;

test("批量图片按输入顺序产生只含价税合计的发票字段候选", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "image-fields-"));
  const first = path.join(dir, "first.jpg");
  const second = path.join(dir, "second.jpg");
  await Promise.all([writeFile(first, jpeg), writeFile(second, jpeg)]);
  const contentHash = createHash("sha256").update(jpeg).digest("hex");

  const result = await extractImageFields({
    contractVersion: 1,
    images: [
      { materialId: "m-second", contentHash, absPath: second },
      { materialId: "m-first", contentHash, absPath: first },
    ],
  });

  assert.deepEqual(result.items.map((item) => item.materialId), ["m-second", "m-first"]);
  const extracted = result.items[0];
  assert.equal(extracted?.status, "extracted");
  if (extracted?.status !== "extracted") return;
  assert.equal(extracted.document.type, "vat_invoice");
  assert.equal(extracted.document.fields.invoiceNumber.evidenceState, "missing");
  assert.equal(extracted.document.fields.issueDate.evidenceState, "missing");
  assert.equal(extracted.document.fields.netAmount.evidenceState, "missing");
  assert.equal(extracted.document.fields.taxAmount.evidenceState, "missing");
  assert.equal(extracted.document.fields.totalAmount.normalized?.cents, 1880);
  assert.equal(extracted.provenance.model, "fixture-v1");
  assert.equal(result.metrics.peakRssBytes, 123456);
});

test("真实电子发票布局只提取价税合计且优先读取小写合计", async () => {
  const result = await extractImageFields({
    contractVersion: 1,
    images: [{
      materialId: "fengyun-real",
      contentHash: "809ef7ad3a5d9c7970434a9ab79a7d2e1e3cf9f550c91779130686d8e08a995e",
      absPath: fengyunFixture,
    }],
  });
  const item = result.items[0];
  assert.equal(item?.status, "extracted");
  if (item?.status !== "extracted") return;
  assert.equal(item.document.type, "vat_invoice");
  assert.equal(item.document.fields.totalAmount.normalized.cents, 1880);
  assert.equal(item.document.fields.invoiceNumber.evidenceState, "missing");
  assert.equal(item.document.fields.netAmount.evidenceState, "missing");
  assert.equal(item.document.fields.taxAmount.evidenceState, "missing");
  assert.deepEqual(item.document.fields.totalAmount.sourceRefs, ["o8"]);
});

test("完整 RapidOCR 观测快照仍能提取真实发票和行程单", async () => {
  const result = await extractImageFields({
    contractVersion: 1,
    images: [
      {
        materialId: "fengyun-captured",
        contentHash: "809ef7ad3a5d9c7970434a9ab79a7d2e1e3cf9f550c91779130686d8e08a995e",
        absPath: fengyunFixture,
      },
      {
        materialId: "ride-captured",
        contentHash: "c93e54e1210e80ee3f9d5205020f1a56055a617146a918d147b4c2fc1a1582a2",
        absPath: itineraryFixture,
      },
    ],
  });

  const invoice = result.items[0];
  assert.equal(invoice?.status, "extracted");
  if (invoice?.status !== "extracted") return;
  assert.equal(invoice.document.type, "vat_invoice");
  assert.equal(invoice.document.fields.totalAmount.normalized.cents, 1880);
  assert.deepEqual(invoice.document.fields.totalAmount.sourceRefs, ["o39"]);

  const itinerary = result.items[1];
  assert.equal(itinerary?.status, "extracted");
  if (itinerary?.status !== "extracted") return;
  assert.equal(itinerary.document.type, "ride_itinerary");
  assert.equal(itinerary.document.fields.segments.length, 1);
  assert.deepEqual(itinerary.document.fields.segments[0], {
    travelDate: { evidenceState: "explicit", raw: "2026-08-22", normalized: "2026-08-22", sourceRefs: ["o19"], recognitionScore: 0.96694 },
    travelTime: { evidenceState: "explicit", raw: "17:28", normalized: "17:28", sourceRefs: ["o19"], recognitionScore: 0.96694 },
    city: { evidenceState: "explicit", raw: "广州市", normalized: "广州市", sourceRefs: ["o20"], recognitionScore: 0.99998 },
    origin: { evidenceState: "explicit", raw: "番禺广场地铁站D口", normalized: "番禺广场地铁站D口", sourceRefs: ["o21"], recognitionScore: 0.99985 },
    destination: { evidenceState: "explicit", raw: "傍西酒堂", normalized: "傍西酒堂", sourceRefs: ["o22"], recognitionScore: 0.99899 },
    amount: { evidenceState: "explicit", raw: "18.80", normalized: { currency: "CNY", cents: 1880 }, sourceRefs: ["o23"], recognitionScore: 0.99999 },
  });
});

test("真实网约车行程单按表头坐标提取行程日期、城市、起终点和金额", async () => {
  const result = await extractImageFields({
    contractVersion: 1,
    images: [{
      materialId: "ride-real",
      contentHash: "c93e54e1210e80ee3f9d5205020f1a56055a617146a918d147b4c2fc1a1582a2",
      absPath: itineraryFixture,
    }],
  });
  const item = result.items[0];
  assert.equal(item?.status, "extracted");
  if (item?.status !== "extracted") return;
  assert.equal(item.document.type, "ride_itinerary");
  assert.equal(item.document.fields.totalAmount.normalized.cents, 1880);
  assert.equal(item.document.fields.segments.length, 1);
  const segment = item.document.fields.segments[0];
  assert.ok(segment);
  assert.equal(segment.travelDate.normalized, "2026-08-22");
  assert.equal(segment.travelTime.normalized, "17:28");
  assert.equal(segment.city.normalized, "广州市");
  assert.equal(segment.origin.normalized, "番禺广场地铁站D口");
  assert.equal(segment.destination.normalized, "傍西酒堂");
  assert.equal(segment.amount.normalized.cents, 1880);
});

test("网约车行程单保留表格中的全部行程段", async () => {
  const result = await extractImageFields({
    contractVersion: 1,
    images: [{
      materialId: "ride-multiple",
      contentHash: "c93e54e1210e80ee3f9d5205020f1a56055a617146a918d147b4c2fc1a1582a2",
      absPath: itineraryFixture,
    }],
  });
  const item = result.items[0];
  assert.equal(item?.status, "extracted");
  if (item?.status !== "extracted" || item.document.type !== "ride_itinerary") return;
  assert.deepEqual(item.document.fields.segments.map((segment) => ({
    date: segment.travelDate.normalized,
    origin: segment.origin.normalized,
    destination: segment.destination.normalized,
    cents: segment.amount.normalized.cents,
  })), [
    { date: "2026-08-22", origin: "番禺广场地铁站D口", destination: "傍西酒堂", cents: 1880 },
    { date: "2026-08-23", origin: "广州南站", destination: "白云机场", cents: 2220 },
  ]);
});

test("逐图隔离内容变化并按文件魔数接受扩展名错误的 PNG", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "image-fields-"));
  const changed = path.join(dir, "changed.jpg");
  const mislabeled = path.join(dir, "looks-like-jpeg.jpg");
  await Promise.all([writeFile(changed, jpeg), writeFile(mislabeled, png)]);

  const result = await extractImageFields({
    contractVersion: 1,
    images: [
      { materialId: "changed", contentHash: "0".repeat(64), absPath: changed },
      { materialId: "valid", contentHash: sha256(png), absPath: mislabeled },
    ],
  });

  assert.equal(result.items[0]?.status, "failed");
  if (result.items[0]?.status === "failed") assert.equal(result.items[0].error.code, "content_changed");
  assert.equal(result.items[1]?.status, "extracted");
});

test("请求级违约在启动 worker 前失败", async () => {
  await assert.rejects(
    extractImageFields({
      contractVersion: 1,
      images: [
        { materialId: "same", contentHash: "a".repeat(64), absPath: "/tmp/a.jpg" },
        { materialId: "same", contentHash: "b".repeat(64), absPath: "/tmp/b.jpg" },
      ],
    }),
    /materialId 必须非空且在批次内唯一/,
  );
});

test("发票只提取价税合计，不因其他金额字段不一致而误取金额", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "image-fields-"));
  const image = path.join(dir, "invoice.jpg");
  await writeFile(image, jpeg);
  const result = await extractImageFields({
    contractVersion: 1,
    images: [{ materialId: "unbalanced-invoice", contentHash: sha256(jpeg), absPath: image }],
  });
  const item = result.items[0];
  assert.equal(item?.status, "extracted");
  if (item?.status !== "extracted") return;
  assert.equal(item.document.type, "vat_invoice");
  assert.equal(item.document.fields.totalAmount.normalized.cents, 1980);
  assert.equal(item.document.fields.netAmount.evidenceState, "missing");
  assert.equal(item.document.fields.taxAmount.evidenceState, "missing");
});

test("火车票字段使用同一个封闭文档 schema", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "image-fields-"));
  const image = path.join(dir, "ticket.jpg");
  await writeFile(image, jpeg);
  const result = await extractImageFields({
    contractVersion: 1,
    images: [{ materialId: "rail-1", contentHash: sha256(jpeg), absPath: image }],
  });
  const item = result.items[0];
  assert.equal(item?.status, "extracted");
  if (item?.status !== "extracted" || item.document.type !== "rail_ticket") return;
  assert.equal(item.document.fields.travelDate.normalized, "2026-09-08");
  assert.equal(item.document.fields.travelTime.normalized, "08:35");
  assert.equal(item.document.fields.origin.normalized, "上海虹桥站");
  assert.equal(item.document.fields.destination.normalized, "杭州东站");
  assert.equal(item.document.fields.amount.normalized?.cents, 7300);
});

test("证据不足时明确请求模型视觉回退", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "image-fields-"));
  const image = path.join(dir, "unknown.jpg");
  await writeFile(image, jpeg);
  const result = await extractImageFields({
    contractVersion: 1,
    images: [{ materialId: "unknown-1", contentHash: sha256(jpeg), absPath: image }],
  });
  assert.equal(result.items[0]?.status, "needs_model_vision");
});

test("受管运行时缺失是环境错误，不伪装成模型视觉回退", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "image-fields-"));
  const image = path.join(dir, "invoice.jpg");
  await writeFile(image, jpeg);
  const worker = process.env.BAOX_IMAGE_WORKER;
  const home = process.env.BAOX_HOME;
  delete process.env.BAOX_IMAGE_WORKER;
  process.env.BAOX_HOME = dir;
  try {
    await assert.rejects(
      extractImageFields({
        contractVersion: 1,
        images: [{ materialId: "missing-runtime", contentHash: sha256(jpeg), absPath: image }],
      }),
      /managed OCR runtime is not installed/,
    );
  } finally {
    if (worker === undefined) delete process.env.BAOX_IMAGE_WORKER;
    else process.env.BAOX_IMAGE_WORKER = worker;
    if (home === undefined) delete process.env.BAOX_HOME;
    else process.env.BAOX_HOME = home;
  }
});

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
