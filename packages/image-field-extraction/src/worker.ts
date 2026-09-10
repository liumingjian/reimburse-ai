import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import type { WorkerImageResult } from "./types.js";

interface WorkerReady {
  engine: string;
  version: string;
  model: string;
}

interface WorkerRun {
  ready: WorkerReady;
  results: ReadonlyMap<string, WorkerImageResult>;
  peakRssBytes: number | null;
}

const defaultWorker = fileURLToPath(new URL("../python/worker.py", import.meta.url));

export async function runWorker(
  images: readonly { materialId: string; absPath: string }[],
): Promise<WorkerRun> {
  const managedPython = path.join(process.env.BAOX_HOME ?? path.join(os.homedir(), ".baox"), "ocr-runtime", "v1", "bin", "python");
  const executable = process.env.BAOX_IMAGE_PYTHON
    ?? (process.env.BAOX_IMAGE_WORKER ? "python3" : (existsSync(managedPython) ? managedPython : null));
  if (!executable) throw new Error("managed OCR runtime is not installed");
  const worker = process.env.BAOX_IMAGE_WORKER ?? defaultWorker;
  const child = spawn(executable, [path.resolve(worker)], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const messages: unknown[] = [];
  let protocolError: Error | null = null;
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    try {
      messages.push(JSON.parse(line));
    } catch {
      protocolError = new Error("OCR worker emitted non-JSON output");
    }
  });

  child.stdin.write(`${JSON.stringify({ type: "init", contractVersion: 1 })}\n`);
  for (const image of images) {
    child.stdin.write(`${JSON.stringify({ type: "image", ...image })}\n`);
  }
  child.stdin.end(`${JSON.stringify({ type: "shutdown" })}\n`);

  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (code !== 0) throw new Error(stderr.trim() || `OCR worker exited with ${code}`);
  if (protocolError) throw protocolError;

  const readyMessage = messages.find(isReady);
  if (!readyMessage) throw new Error("OCR worker did not complete its handshake");
  const results = messages.filter(isResult).map((message) => [message.materialId, message] as const);
  return {
    ready: { engine: readyMessage.engine, version: readyMessage.version, model: readyMessage.model },
    results: new Map(results),
    peakRssBytes: messages.find(isMetrics)?.peakRssBytes ?? null,
  };
}

function isReady(value: unknown): value is WorkerReady & { type: "ready" } {
  if (!isRecord(value)) return false;
  return value.type === "ready"
    && typeof value.engine === "string"
    && typeof value.version === "string"
    && typeof value.model === "string";
}

function isResult(value: unknown): value is WorkerImageResult & { type: "result" } {
  if (!isRecord(value)) return false;
  return value.type === "result"
    && typeof value.materialId === "string"
    && Array.isArray(value.observations)
    && typeof value.durationMs === "number"
    && (value.error === undefined || typeof value.error === "string");
}

function isMetrics(value: unknown): value is { type: "metrics"; peakRssBytes: number } {
  return isRecord(value) && value.type === "metrics" && typeof value.peakRssBytes === "number";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
