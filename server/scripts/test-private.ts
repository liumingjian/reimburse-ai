import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, join, relative, sep } from 'node:path';
import { parseMaterial } from '../src/parse/material';

// `pnpm test:private`: parser metrics on the private sample corpus, which lives only on the maintainer's mac.
//
// Corpus layout under $BAOX_PRIVATE_CORPUS:
//   <kind>/<layout>/<file>.(pdf|jpg|jpeg|png)   expected to be recognised by that layout
//   <kind>/<layout>/<file>.expected.json       optional `{ "<slot key>": "<value>" }` for field accuracy
//   unrecognised/<file>                         expected to match no layout
//
// Prints aggregate counts only, never a file name, path or field value, so the output is safe to share. Skips (exit 0)
// when the variable is unset. Per-layout accuracy thresholds, and failing below them, are slice 16's.

const root = process.env['BAOX_PRIVATE_CORPUS'];
if (!root) {
  console.log('test:private skipped: BAOX_PRIVATE_CORPUS is not set.');
  process.exit(0);
}
if (!existsSync(root) || !statSync(root).isDirectory()) {
  console.error('test:private: BAOX_PRIVATE_CORPUS is not a directory.');
  process.exit(1);
}

const MEDIA: Readonly<Record<string, 'pdf' | 'image'>> = { '.pdf': 'pdf', '.jpg': 'image', '.jpeg': 'image', '.png': 'image' };

function* files(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else if (MEDIA[extname(entry.name).toLowerCase()]) yield path;
  }
}

type Stats = { files: number; expected: number; otherLayout: number; unrecognised: number; ambiguous: number; failed: number; fields: number; fieldsMatched: number };
const empty = (): Stats => ({ files: 0, expected: 0, otherLayout: 0, unrecognised: 0, ambiguous: 0, failed: 0, fields: 0, fieldsMatched: 0 });
const groups = new Map<string, Stats>();
let ignored = 0;

for (const path of files(root)) {
  const parts = relative(root, path).split(sep);
  const group = parts[0] === 'unrecognised' ? 'unrecognised' : parts.length >= 3 ? `${parts[0]}/${parts[1]}` : null;
  if (!group) {
    ignored += 1;
    continue;
  }
  const stats = groups.get(group) ?? empty();
  groups.set(group, stats);
  stats.files += 1;
  const mediaType = MEDIA[extname(path).toLowerCase()] ?? 'pdf';
  const outcome = await parseMaterial({ materialId: 'private', fileName: basename(path), mediaType, bytes: new Uint8Array(readFileSync(path)) });
  if (outcome.outcome === 'recognised') {
    if (`${outcome.kind}/${outcome.layout}` !== group) {
      stats.otherLayout += 1;
      continue;
    }
    stats.expected += 1;
    const sidecar = `${path}.expected.json`;
    if (!existsSync(sidecar)) continue;
    const expected = JSON.parse(readFileSync(sidecar, 'utf8')) as Record<string, string>;
    const primary = `rule:${outcome.kind}/${outcome.layout}`;
    for (const [key, value] of Object.entries(expected)) {
      stats.fields += 1;
      if (outcome.candidates.some((c) => c.source === primary && c.key === key && c.value === value)) stats.fieldsMatched += 1;
    }
  } else if (outcome.outcome === 'unrecognised') {
    if (group === 'unrecognised') stats.expected += 1;
    else stats.unrecognised += 1;
  } else if (outcome.outcome === 'ambiguous') stats.ambiguous += 1;
  else stats.failed += 1;
}

const percent = (part: number, whole: number) => (whole === 0 ? '-' : `${((part / whole) * 100).toFixed(1)}%`);
console.log(['group', 'files', 'as expected', 'other layout', 'unrecognised', 'ambiguous', 'failed', 'field accuracy'].join('\t'));
for (const [group, s] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
  console.log([group, s.files, percent(s.expected, s.files), s.otherLayout, s.unrecognised, s.ambiguous, s.failed, `${percent(s.fieldsMatched, s.fields)} (${s.fields} fields)`].join('\t'));
}
if (ignored > 0) console.log(`ignored ${ignored} file(s) outside <kind>/<layout>/ or unrecognised/`);
