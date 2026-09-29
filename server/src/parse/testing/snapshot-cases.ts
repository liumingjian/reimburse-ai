import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ParseDoc } from '../doc';
import { parseDocSnapshot } from '../snapshot';

// The stored document of a snapshot case (`snapshots/<case>.doc.json`), for tests that edit a real document's runs
// rather than only score it. A fresh copy on every call, so a test's edits never reach another test.
//
// The `fixture-<file>` cases are the @baox/fixtures files as the production readers read them. After regenerating
// the fixtures (or bumping pdfjs or the OCR models), recapture them from server/, one per file, with
//   pnpm exec tsx scripts/probe-parse.ts --capture src/parse/snapshots/fixture-<file> --redact <{} in a file> ../fixtures/generated/<file>.<ext>
// and let `readers-production.test.ts` (which compares m01 against its snapshot) say when that is due.
export function caseDoc(name: string): ParseDoc {
  return parseDocSnapshot(readFileSync(fileURLToPath(new URL(`../snapshots/${name}.doc.json`, import.meta.url)), 'utf8'));
}
