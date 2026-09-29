import { GOLDEN_TIME } from '@baox/contract/goldens/scenarios';

// Recording a golden snapshot: the server's raw snapshot JSON with the values that differ per run replaced, so two runs
// of the same scenario record the same file. Replacements keep the snapshot valid against the contract:
//
//   UUIDs (taskId, materialId, lineId, …, also inside stepToken and file URLs)
//                                  → 00000000-0000-4000-8000-<n, 12 digits>, numbered by first appearance
//   32-hex digests (confirmation and assignment digests, which hash line ids)
//                                  → <n, 32 digits>, numbered the same way
//   ISO timestamps taken during the run (createdAt, updatedAt, uploadedAt, …)
//                                  → GOLDEN_TIME (@baox/contract/goldens)
//
// Content hashes (64-hex sha256 of the fixture bytes) and dates read from the materials are stable and kept.

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const DIGEST = /"([0-9a-f]{32})"/g;
const TIMESTAMP = /"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)"/g;
// A timestamp this close to the run counts as taken during it (contract times are cut to the second).
const SLACK_MS = 2_000;

// `run`: when the scenario started and ended, by the wall clock the server stamps facts with.
export function goldenJson(snapshot: unknown, run: { start: number; end: number }): string {
  const numbered = (width: number, prefix: string) => {
    const seen = new Map<string, string>();
    return (value: string) => {
      let replacement = seen.get(value);
      if (!replacement) seen.set(value, (replacement = prefix + String(seen.size + 1).padStart(width, '0')));
      return replacement;
    };
  };
  const uuid = numbered(12, '00000000-0000-4000-8000-');
  const digest = numbered(32, '');
  return `${JSON.stringify(snapshot, null, 2)}\n`
    .replace(UUID, uuid)
    .replace(DIGEST, (_match, value: string) => `"${digest(value)}"`)
    .replace(TIMESTAMP, (match, value: string) => {
      const at = Date.parse(value);
      return at >= run.start - SLACK_MS && at <= run.end + SLACK_MS ? `"${GOLDEN_TIME}"` : match;
    });
}
