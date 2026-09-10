#!/usr/bin/env node
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { extractImageFields } from "./index.js";
import { toLegacyReadings } from "./legacy-readings.js";
import type { ImageFieldExtractionRequest } from "./types.js";

const requestPath = argument("--request");
const outputPath = argument("--output");
const readingsPath = argument("--readings");
if (!requestPath || !outputPath) {
  process.stderr.write("usage: extract-image-fields --request <json> --output <json>\n");
  process.exitCode = 2;
} else {
  try {
    const request = JSON.parse(await readFile(path.resolve(requestPath), "utf8")) as ImageFieldExtractionRequest;
    const result = await extractImageFields(request);
    const destination = path.resolve(outputPath);
    const temporary = `${destination}.tmp`;
    await writeFile(temporary, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, destination);
    if (readingsPath) {
      const readingsDestination = path.resolve(readingsPath);
      const readingsTemporary = `${readingsDestination}.tmp`;
      await writeFile(readingsTemporary, `${JSON.stringify(toLegacyReadings(result), null, 2)}\n`, { mode: 0o600 });
      await rename(readingsTemporary, readingsDestination);
    }
    process.stdout.write(`${JSON.stringify({ output: destination, items: result.items.length })}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
