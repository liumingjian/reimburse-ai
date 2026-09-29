import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { ParseOutcome } from './dispatch';
import { factsOf, type Facts } from './facts';
import { parseMaterial } from './material';
import { parseDocSnapshot, snapshotReaders } from './snapshot';

// Every recognition regression case: `snapshots/<case>.doc.json` (a captured, redacted document, `snapshot.ts`) read
// through the snapshot reader, against `snapshots/<case>.expected.json`. No pdfjs, no OCR. Adding a case = adding the
// two files; capture the first with `scripts/probe-parse.ts --capture`.
//
// `<case>.expected.json`, written from the document itself and never from the parser's output:
//   { "about": "<what went wrong, with the issue>", "outcome": "recognised" | "unrecognised" | "ambiguous" | "failed",
//     "layout": "<kind>/<layout>" (recognised only), "facts": { "<slot key>": "<value as the layout emits it>" },
//     "missing": [<slot key>, ...], "findings": [<finding code>, ...] (recognised only) }
// All three are the whole of what the layout reads, not a selection: `facts` is every key it reads (leg fields are
// `segments[0].amount` and so on), and `missing` and `findings` are the whole list in the order the layout emits them.
// An absent `missing` or `findings` means none, so a spurious extra slot or a new finding fails the case.
//
// `fixture-<file>` cases are the @baox/fixtures files, captured unredacted (the fixtures are synthetic); the layout
// tests edit these documents through `testing/snapshot-cases.ts` instead of reading the PDFs with pdfjs.

// The engines stay out: a case that needed one would fail to load here rather than quietly run pdfjs or OCR.
vi.mock('unpdf', () => {
  throw new Error('a snapshot case loaded pdfjs');
});
vi.mock('zxing-wasm/reader', () => {
  throw new Error('a snapshot case loaded the QR decoder');
});
vi.mock('./ocr', () => {
  throw new Error('a snapshot case loaded OCR');
});

type Expected = { about?: string; outcome: ParseOutcome['outcome']; layout?: string; facts?: Record<string, string>; missing?: string[]; findings?: string[] };

const DIR = fileURLToPath(new URL('./snapshots', import.meta.url));
const files = readdirSync(DIR);
const cases = files.filter((file) => file.endsWith('.doc.json')).map((file) => file.slice(0, -'.doc.json'.length)).sort();

// A fact is read when `factsOf` (the inventory view's and the private gate's rule, #311) picks that value and the layout
// does not also read the key another way: a conflicting read is not a correct read.
function factOf(facts: Facts, key: string): string | undefined {
  return facts.conflicts.includes(key) ? `<conflict on ${key}>` : facts.values[key];
}

describe('recognition snapshot cases', () => {
  it('pairs every document with its expectation', () => {
    expect(cases.length).toBeGreaterThan(0);
    expect(files.filter((file) => file.endsWith('.expected.json')).map((file) => file.slice(0, -'.expected.json'.length)).sort()).toEqual(cases);
  });

  it.each(cases)('%s', async (name) => {
    const doc = parseDocSnapshot(readFileSync(join(DIR, `${name}.doc.json`), 'utf8'));
    const expected = JSON.parse(readFileSync(join(DIR, `${name}.expected.json`), 'utf8')) as Expected;
    const outcome = await parseMaterial({ materialId: name, fileName: `${name}.${doc.mediaType === 'pdf' ? 'pdf' : 'jpg'}`, mime: doc.mediaType === 'pdf' ? 'application/pdf' : 'image/jpeg', bytes: new Uint8Array() }, snapshotReaders(doc));

    expect(outcome.outcome).toBe(expected.outcome);
    if (outcome.outcome !== 'recognised') return;
    expect(`${outcome.kind}/${outcome.layout}`).toBe(expected.layout);
    expect(outcome.missing).toEqual(expected.missing ?? []);
    expect(outcome.findings.map((finding) => finding.code)).toEqual(expected.findings ?? []);
    const read = factsOf(outcome);
    expect(Object.fromEntries(Object.keys(read.values).map((key) => [key, factOf(read, key)]))).toEqual(expected.facts ?? {});
  });
});
