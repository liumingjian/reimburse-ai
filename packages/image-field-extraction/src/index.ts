import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import type {
  ExtractedDocument,
  ImageExtractionFailure,
  ImageFieldExtractionBatch,
  ImageFieldExtractionRequest,
} from "./types.js";
import { extractDocument } from "./documents.js";
import { runWorker } from "./worker.js";

export type * from "./types.js";

export async function extractImageFields(
  request: ImageFieldExtractionRequest,
): Promise<ImageFieldExtractionBatch> {
  validateRequest(request);
  const startedAt = performance.now();
  const verified: { materialId: string; contentHash: string; absPath: string }[] = [];
  const failures = new Map<string, ImageExtractionFailure>();

  for (const image of request.images) {
    try {
      const bytes = await readFile(image.absPath);
      const actualHash = createHash("sha256").update(bytes).digest("hex");
      if (actualHash !== image.contentHash) {
        failures.set(image.materialId, failure(image, "content_changed", "图片内容哈希已变化", false));
      } else if (!isPng(bytes) && !isJpeg(bytes)) {
        failures.set(image.materialId, failure(image, "unsupported_format", "只支持 PNG 或 JPEG", false));
      } else {
        verified.push(image);
      }
    } catch {
      failures.set(image.materialId, failure(image, "image_unavailable", "无法读取图片", true));
    }
  }

  let worker: Awaited<ReturnType<typeof runWorker>> | null = null;
  let workerUnavailable = false;
  if (verified.length > 0) {
    try {
      worker = await runWorker(verified);
    } catch {
      workerUnavailable = true;
    }
  }

  const items = request.images.map((image) => {
    const failed = failures.get(image.materialId);
    if (failed) return failed;
    if (workerUnavailable) {
      return {
        status: "needs_model_vision" as const,
        materialId: image.materialId,
        contentHash: image.contentHash,
        reason: "runtime_unavailable" as const,
        evidence: [],
      };
    }
    const reading = worker?.results.get(image.materialId);
    if (!reading || !worker) return failure(image, "worker_protocol_error", "图片读取运行时未返回结果", true);
    const provenance = {
      adapter: worker.ready.engine,
      engineVersion: worker.ready.version,
      model: worker.ready.model,
      durationMs: reading.durationMs,
    };
    if (reading.error) {
      return {
        status: "needs_model_vision" as const,
        materialId: image.materialId,
        contentHash: image.contentHash,
        reason: "ocr_failed" as const,
        evidence: reading.observations,
        provenance,
      };
    }
    const parsed = extractDocument(reading.observations);
    if (parsed.kind === "multiple_documents") {
      return failure(image, "multiple_documents", "一张图片中检测到多份独立单据", false);
    }
    if (parsed.kind === "insufficient_evidence") {
      return {
        status: "needs_model_vision" as const,
        materialId: image.materialId,
        contentHash: image.contentHash,
        reason: "insufficient_evidence" as const,
        evidence: reading.observations,
        provenance,
      };
    }
    const validationError = validateDocument(parsed.document);
    if (validationError) return failure(image, "candidate_validation_failed", validationError, false);
    return {
      status: "extracted" as const,
      materialId: image.materialId,
      contentHash: image.contentHash,
      document: parsed.document,
      evidence: reading.observations,
      provenance,
    };
  });

  return {
    contractVersion: 1,
    items,
    metrics: { durationMs: performance.now() - startedAt, peakRssBytes: worker?.peakRssBytes ?? null },
  };
}

function validateDocument(document: ExtractedDocument): string | null {
  if (document.type !== "vat_invoice") return null;
  const { netAmount, taxAmount, totalAmount } = document.fields;
  if (netAmount.evidenceState !== "explicit"
    || taxAmount.evidenceState !== "explicit"
    || totalAmount.evidenceState !== "explicit") return null;
  return netAmount.normalized.cents + taxAmount.normalized.cents === totalAmount.normalized.cents
    ? null
    : "发票金额不守恒";
}

function validateRequest(request: ImageFieldExtractionRequest): void {
  if (request.contractVersion !== 1) throw new TypeError("不支持的图片字段提取契约版本");
  if (!Array.isArray(request.images) || request.images.length === 0) throw new TypeError("images 必须是非空数组");
  const ids = new Set<string>();
  for (const image of request.images) {
    if (!image.materialId || ids.has(image.materialId)) throw new TypeError("materialId 必须非空且在批次内唯一");
    ids.add(image.materialId);
    if (!/^[a-f0-9]{64}$/.test(image.contentHash)) throw new TypeError("contentHash 必须是小写 SHA-256");
    if (!path.isAbsolute(image.absPath)) throw new TypeError("absPath 必须是绝对路径");
  }
}

function failure(
  image: ImageFieldExtractionRequest["images"][number],
  code: ImageExtractionFailure["error"]["code"],
  message: string,
  retryable: boolean,
): ImageExtractionFailure {
  return { status: "failed", materialId: image.materialId, contentHash: image.contentHash, error: { code, retryable, message } };
}

function isPng(bytes: Buffer): boolean {
  return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
}

function isJpeg(bytes: Buffer): boolean {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}
