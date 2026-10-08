import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GENERATED_DIR } from '@baox/fixtures';
import type { ParseOutcome } from '../parse/dispatch';
import type { Upload } from './api';
import { sha256 } from './parse-presets';

// 支付截图 materials for scenario tests (ADR-0032): distinct PNG bytes, and the outcome the preset parser should give
// them as `payment_screenshot/labelled` read with `values`. Pass `outcomes` to `presetParser`.
export function paymentScreenshots() {
  const base = readFileSync(join(GENERATED_DIR, 'print-pg1.png'));
  const outcomes: Record<string, ParseOutcome> = {};
  const upload = (name: string, values: Record<string, string>): Upload => {
    // Bytes after the PNG's end chunk keep it a valid image and make each file its own content.
    const bytes = Buffer.concat([base, Buffer.from(name)]);
    const candidates = Object.entries(values).map(([key, value]) => ({ key, value, source: 'rule:payment_screenshot/labelled', parserVersion: '1', evidence: 'explicit' as const, refs: [] }));
    outcomes[sha256(bytes)] = { outcome: 'recognised', kind: 'payment_screenshot', layout: 'labelled', parserVersion: '1', kindLabel: '支付截图', candidates, findings: [], missing: [] };
    return { name, bytes, type: 'image/png' };
  };
  return { upload, outcomes };
}
