#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { extractImageFields } from "../dist/index.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const sourceDir = path.resolve(process.argv[2] ?? path.join(repoRoot, "resources/test-images"));
const limit = Number(process.argv[3] ?? "38");
const outputPath = path.resolve(process.argv[4] ?? path.join(repoRoot, ".codex-out/ocr-benchmark.json"));
const model = process.argv[5] ?? "small";
if (!new Set(["small", "medium"]).has(model)) throw new TypeError("model must be small or medium");
process.env.BAOX_OCR_MODEL = model;
const names = (await readdir(sourceDir)).filter((name) => /\.(?:png|jpe?g)$/i.test(name)).sort().slice(0, limit);
const images = await Promise.all(names.map(async (name, index) => {
  const absPath = path.join(sourceDir, name);
  const bytes = await readFile(absPath);
  return { materialId: `benchmark-${index + 1}`, contentHash: createHash("sha256").update(bytes).digest("hex"), absPath };
}));
const startedAt = performance.now();
const result = await extractImageFields({ contractVersion: 1, images });
const wallMs = performance.now() - startedAt;
const manifest = images.map((image, index) => ({ materialId: image.materialId, fileName: names[index] }));
await writeFile(outputPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), sourceCount: images.length, manifest, wallMs, result }, null, 2)}\n`, { mode: 0o600 });
const itemDurations = result.items.flatMap((item) => item.status === "extracted" || item.status === "needs_model_vision"
  ? (item.provenance ? [item.provenance.durationMs] : []) : []).sort((a, b) => a - b);
const counts = Object.groupBy(result.items, (item) => item.status);
const typeGroups = Object.groupBy(
  result.items.flatMap((item) => item.status === "extracted" ? [item.document.type] : []),
  (type) => type,
);
process.stdout.write(`${JSON.stringify({
  count: images.length,
  model,
  wallMs,
  p50ImageMs: percentile(itemDurations, 0.5),
  p95ImageMs: percentile(itemDurations, 0.95),
  peakRssBytes: result.metrics.peakRssBytes,
  statuses: Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, value?.length ?? 0])),
  documentTypes: Object.fromEntries(Object.entries(typeGroups).map(([key, value]) => [key, value?.length ?? 0])),
  outputPath,
}, null, 2)}\n`);

function percentile(values, quantile) {
  if (!values.length) return null;
  return values[Math.ceil(values.length * quantile) - 1];
}
