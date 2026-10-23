import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { normalise, type ParseDoc, type TextObservation } from '../doc';
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

// A case's document with whole runs reprinted, to reach what no real sample shows (a date edited, a title swapped).
// Each key names a run by its id (`p1.10`) or by its printed text; the value is what it prints instead, read the way
// the readers read it (`text` normalised from it). Throws when a key names no run, so a re-capture that moved or
// redacted a run fails here instead of leaving the edit unapplied.
export function editedCase(name: string, reprint: Readonly<Record<string, string>>): ParseDoc {
  const doc = caseDoc(name);
  for (const key of Object.keys(reprint)) if (!doc.observations.some((o) => o.id === key || o.raw === key)) throw new Error(`${name}: no run is ${key}`);
  const reprinted = (o: TextObservation): TextObservation => {
    const raw = reprint[o.id] ?? reprint[o.raw];
    return raw === undefined ? o : { ...o, text: normalise(raw), raw };
  };
  return { ...doc, observations: doc.observations.map(reprinted) };
}

// The real 华住 结账单 (`hotel-folio-huazhu-colon-run`, 入住 2026-08-11, 离店 2026-08-13) with its stay dates reprinted:
// p1.10 is the 入住 value run, p1.12 the 离店 one, each printed `： <date>`.
export const huazhuStay = (checkIn: string, checkOut: string): ParseDoc =>
  editedCase('hotel-folio-huazhu-colon-run', { 'p1.10': `： ${checkIn}`, 'p1.12': `： ${checkOut}` });
