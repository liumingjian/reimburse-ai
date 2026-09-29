import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GENERATED_DIR, SAMPLE_MATERIALS } from '@baox/fixtures';
import { describe, expect, it } from 'vitest';
import { inlineExecutor } from '../parse/executor';
import { loadParsePresets, PARSE_PRESETS_PATH, sha256, type ParsePreset } from './parse-presets';

// The drift guard behind the scenario server's default parser: every sample goes through the real parser (pdfjs, OCR)
// and must come out exactly as recorded. A parser change that alters an outcome fails here, once, instead of silently
// diverging from what scenario tests assume. Re-record after an intended change:
//
//   UPDATE_PARSE_PRESETS=1 pnpm --filter @baox/server exec vitest run src/test/parse-presets.test.ts

const UPDATE = process.env['UPDATE_PARSE_PRESETS'] === '1';

describe('preset parse outcomes', () => {
  it('match what the real parser makes of every sample material', async () => {
    const parser = inlineExecutor();
    const actual: Record<string, ParsePreset> = {};
    for (const sample of SAMPLE_MATERIALS) {
      const bytes = new Uint8Array(readFileSync(join(GENERATED_DIR, sample.file)));
      const mime = sample.file.endsWith('.pdf') ? 'application/pdf' : 'image/jpeg';
      actual[sample.file] = { sha256: sha256(bytes), outcome: await parser.parse({ materialId: sample.file, fileName: sample.fileName, mime, bytes }) };
    }
    if (UPDATE) writeFileSync(PARSE_PRESETS_PATH, `${JSON.stringify(actual, null, 2)}\n`);
    expect(loadParsePresets()).toEqual(actual);
  });
});
