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

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0, 4, 0, 0, 0xff, 0xd9]);
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0]);

process.env.BAOX_IMAGE_WORKER = fixtureWorker;

test("批量图片按输入顺序产生经校验的增值税发票字段候选", async () => {
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
  assert.deepEqual(extracted.document.fields.invoiceNumber, {
    evidenceState: "explicit",
    raw: "25317000000123456789",
    normalized: "25317000000123456789",
    sourceRefs: ["o2"],
    recognitionScore: 0.99,
  });
  assert.equal(extracted.document.fields.issueDate.normalized, "2026-09-04");
  assert.equal(extracted.document.fields.totalAmount.normalized?.cents, 1880);
  assert.equal(extracted.provenance.model, "fixture-v1");
  assert.equal(result.metrics.peakRssBytes, 123456);
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

test("发票金额不守恒是材料失败，不产生错误候选", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "image-fields-"));
  const image = path.join(dir, "invoice.jpg");
  await writeFile(image, jpeg);
  const result = await extractImageFields({
    contractVersion: 1,
    images: [{ materialId: "unbalanced-invoice", contentHash: sha256(jpeg), absPath: image }],
  });
  const item = result.items[0];
  assert.equal(item?.status, "failed");
  if (item?.status === "failed") assert.equal(item.error.code, "candidate_validation_failed");
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

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
