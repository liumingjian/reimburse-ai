// Read-only: run the real parse pipeline over several stored originals in one process — the shape the parse worker
// runs in (ADR-0017) — and print what each one found. Written to check that a QR reading belongs to its own document.
//
// Usage: tsx server/scripts/probe-parse.ts <sha256> [<sha256> ...]

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseMaterial } from '../src/parse/material';

const root = process.env['BAOX_DATA_DIR'] ?? '/Users/lmj/baox-qa-data';
const blob = (sha: string) => join(root, 'files', 'sha256', sha.slice(0, 2), sha);

for (const sha of process.argv.slice(2)) {
  const outcome = await parseMaterial({ materialId: sha.slice(0, 8), fileName: `${sha.slice(0, 8)}.pdf`, mediaType: 'pdf', bytes: new Uint8Array(readFileSync(blob(sha))) });
  const findings = outcome.outcome === 'recognised' ? outcome.findings : [];
  console.log(JSON.stringify({ sha: sha.slice(0, 8), outcome: outcome.outcome, findings: findings.map((f) => `${f.kind}/${'code' in f ? f.code : ''}: ${'message' in f ? f.message : ''}`) }));
}
