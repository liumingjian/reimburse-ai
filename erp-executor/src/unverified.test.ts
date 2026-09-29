// The fake ERP's page assumptions that no recording backs. Every hand-written selector, page shape or behaviour in
// src/testing (the fake and its fixtures) carries `@unverified: <what it assumes>`; recordings (`probe <flow>
// --record <name>`) carry none. This test prints the list and its count so the number is visible in every run, and
// holds a ceiling so it can only go down: a new hand-written assumption needs a recording instead, or a deliberate
// raise of UNVERIFIED_CEILING in the same change.

import { readdirSync, readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const UNVERIFIED_CEILING = 62;
const MARKER = /@unverified:\s*(.*?)\s*(?:-->|\*\/|$)/gm;
const testing = fileURLToPath(new URL('./testing/', import.meta.url));

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}${entry.name}`;
    return entry.isDirectory() ? files(`${path}/`) : /\.(ts|html)$/.test(entry.name) ? [path] : [];
  });
}

const found = files(testing).flatMap((path) => [...readFileSync(path, 'utf8').matchAll(MARKER)]
  .map((match) => ({ file: relative(testing, path), recorded: relative(testing, path).startsWith('recordings/'), text: match[1] ?? '' })));

describe('unverified ERP assumptions', () => {
  it('are listed and counted', () => {
    const hand = found.filter((marker) => !marker.recorded);
    console.log(`${hand.length} unverified ERP assumption(s) in the fake ERP (no recording backs them):\n${hand.map((m) => `  - ${m.file}: ${m.text}`).join('\n')}`);
    expect(hand.length).toBeGreaterThan(0);
    expect(hand.length).toBeLessThanOrEqual(UNVERIFIED_CEILING);
    for (const marker of hand) expect(marker.text, marker.file).not.toBe('');
  });

  it('never appear in a recording', () => {
    expect(found.filter((marker) => marker.recorded)).toEqual([]);
  });
});
