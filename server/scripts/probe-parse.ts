// Read-only unless `--capture`: run the real parse pipeline over PDFs or photos in one process — the shape the parse
// worker runs in (ADR-0017) — and print what each one found.
//
// Usage:
//   tsx server/scripts/probe-parse.ts <file | sha256> [...]
//     Print each material's outcome. A 64-hex argument names a stored original under BAOX_DATA_DIR.
//   tsx server/scripts/probe-parse.ts --capture <case path> --redact <map.json> <file | sha256>
//     Capture the document the material produced (`captureDoc`), swap the values in `map.json` (a flat
//     `{"<as printed>": "<replacement>"}` map, `redactDoc`), write `<case path>.doc.json`, and print the outcome of the
//     redacted snapshot. Then write `<case path>.expected.json` by hand, from the document itself and never from this
//     output (docs/agents/private-corpus.md). `--redact` is required: `{}` says on purpose that nothing needs hiding.
//
// A real material's snapshot carries real values until redacted. Commit only the redacted file.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { parseMaterial, type ParseInput } from '../src/parse/material';
import { productionReaders } from '../src/parse/readers-production';
import { captureDoc, formatDocSnapshot, redactDoc, snapshotReaders } from '../src/parse/snapshot';

const { values: options, positionals } = parseArgs({ allowPositionals: true, options: { capture: { type: 'string' }, redact: { type: 'string' } } });

const root = process.env['BAOX_DATA_DIR'] ?? '/Users/lmj/baox-qa-data';
const pathOf = (arg: string) => (/^[0-9a-f]{64}$/.test(arg) && !existsSync(arg) ? join(root, 'files', 'sha256', arg.slice(0, 2), arg) : arg);
const label = (arg: string) => (/^[0-9a-f]{64}$/.test(arg) ? arg.slice(0, 8) : arg);

function input(arg: string): ParseInput {
  const bytes = new Uint8Array(readFileSync(pathOf(arg)));
  // No MIME: recognition sniffs the medium from the bytes, and stored originals have no extension either.
  return { materialId: label(arg).slice(0, 8), fileName: arg.split('/').pop() ?? arg, mime: '', bytes };
}

function summary(arg: string, outcome: Awaited<ReturnType<typeof parseMaterial>>) {
  const recognised = outcome.outcome === 'recognised' ? outcome : null;
  return JSON.stringify({
    material: label(arg),
    outcome: outcome.outcome,
    ...(recognised ? { layout: `${recognised.kind}/${recognised.layout}`, missing: recognised.missing, candidates: recognised.candidates.map((c) => `${c.key} = ${c.value} (${c.source})`) } : {}),
    findings: recognised ? recognised.findings.map((f) => `${f.kind}/${f.code}: ${f.message}`) : [],
    ...(outcome.outcome === 'failed' || outcome.outcome === 'unrecognised' ? { reason: outcome.reason } : {}),
  }, null, 2);
}

if (options.capture !== undefined) {
  const [arg, ...rest] = positionals;
  if (!arg || rest.length > 0 || options.redact === undefined) throw new Error('usage: --capture <case path> --redact <map.json> <file | sha256>');
  const material = input(arg);
  const map = JSON.parse(readFileSync(options.redact, 'utf8')) as Record<string, string>;
  const doc = redactDoc(await captureDoc(material, productionReaders), map);
  writeFileSync(`${options.capture}.doc.json`, formatDocSnapshot(doc));
  console.log(`wrote ${options.capture}.doc.json (${doc.observations.length} runs, ${doc.codes.length} codes, ${Object.keys(map).length} values redacted)`);
  console.log(summary(arg, await parseMaterial(material, snapshotReaders(doc))));
} else {
  for (const arg of positionals) console.log(summary(arg, await parseMaterial(input(arg), productionReaders)));
}
