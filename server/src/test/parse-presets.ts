import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { ParseOutcome } from '../parse/dispatch';
import type { ParseExecutor } from '../parse/executor';

// Preset parse outcomes: what the real parser makes of each @baox/fixtures sample, recorded once into
// `parse-presets.json` and replayed by content hash. The scenario server parses with these by default, so a test
// never waits on pdfjs or OCR; `parse-presets.test.ts` re-parses every sample for real and fails when the recording
// drifts from the parser (re-record with `UPDATE_PARSE_PRESETS=1`).

export type ParsePreset = { sha256: string; outcome: ParseOutcome };

export const PARSE_PRESETS_PATH = new URL('./parse-presets.json', import.meta.url);

// Keyed by the generated fixture file (`m01-hotel-invoice.pdf`), for readable diffs.
export function loadParsePresets(): Record<string, ParsePreset> {
  return JSON.parse(readFileSync(PARSE_PRESETS_PATH, 'utf8')) as Record<string, ParsePreset>;
}

export const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export type PresetParser = ParseExecutor & {
  // File names the parser was asked about and had no recording for. Each also parsed as a non-retryable `failed`
  // outcome naming the gap, so the snapshot shows it too.
  misses: () => string[];
};

// `extra`: outcomes for bytes outside the fixtures, by sha256 (a test's own synthetic material).
export function presetParser(extra: Readonly<Record<string, ParseOutcome>> = {}): PresetParser {
  const bySha = new Map<string, ParseOutcome>(Object.values(loadParsePresets()).map((preset) => [preset.sha256, preset.outcome]));
  for (const [sha, outcome] of Object.entries(extra)) bySha.set(sha, outcome);
  const misses: string[] = [];
  return {
    async parse(input) {
      const outcome = bySha.get(sha256(input.bytes));
      if (outcome) return structuredClone(outcome);
      misses.push(input.fileName);
      return { outcome: 'failed', retryable: false, reason: `no preset parse outcome for ${input.fileName}: add one, or run this test with a real parser` };
    },
    close: async () => {},
    misses: () => [...misses],
  };
}
