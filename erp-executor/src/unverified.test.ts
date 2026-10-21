// The fake ERP's page assumptions that no recording backs. Every hand-written selector, page shape or behaviour in
// src/testing (the fake and its fixtures) carries `@unverified: <what it assumes> [<why no recording>]`; recordings
// (`probe <flow> --record <name>`) carry none. This test prints the list and its count so the number is visible in
// every run, and holds a ceiling so it can only go down: a new hand-written assumption needs a recording instead, or
// a deliberate raise of UNVERIFIED_CEILING in the same change.

import { readdirSync, readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The reason says why a recording cannot back the assumption (recording/flows.ts stops before every consumption
// boundary, types nothing and uploads nothing):
const WHY_NO_RECORDING = {
  import: 'it only exists after 发票导入单据, the consumption boundary',
  save: 'it only exists after 保存, the consumption boundary',
  upload: 'it needs a real invoice uploaded to the 发票无忧助手, a third party',
  typing: 'it is what ERP does with typed values: a replay moves on clicks only, and redaction masks every value',
  transient: 'live shows it only sometimes (a cover, a lag, a prompt); a recording is one moment',
  unseen: 'it was measured live once, and no recording run has shown it',
  fake: "it is the fake's own mechanics, not a page shape",
} as const;

// Raised 48 → 51 for 暂存 (ADR-0029): the 保存 split button's group, what 暂存 does to the form, and View / the query by
// 事由. Each was measured once live (S5, S9, 2026-10-12); recording them means leaving a draft per recording run.
// Raised 51 → 52 for 自动重新去报销 (ADR-0034): the query by 发票号码 that finds a bill holding an invoice.
// Raised 52 → 54 for the main menu (QA 2026-10-19): its 员工服务 accordion and the selected node's right panel, and the
// loading overlay that takes clicks after sign-in. Both measured live that day; the recordings start on a console
// whose shortcut skips the menu, and the overlay is a moment no recording holds.
// Raised 54 → 55 for the same overlay taking a 新增行 click (QA 2026-10-19, 1 of 13 live): a moment no recording holds.
// Raised 55 → 56 for the entry page that loads blank until it is loaded again (live 2026-10-20, 2 of 21 sign-ins).
// Raised 56 → 58 for a lookup ERP dropped unresolved and a cover over a fresh row (live 2026-10-20, 4 of 10 fills).
// Raised 58 → 59 for a lookup that resolves after its commit under the overlay (live 2026-10-20, 20 writes timed).
// Raised 59 → 61 for a click on 不生成费用明细 that opened no assistant, and an assistant window up before its iframe
// attaches (live 2026-10-21, 1 of 10 runs): moments no recording holds.
const UNVERIFIED_CEILING = 61;
const MARKER = /@unverified:\s*(.*?)\s*(?:-->|\*\/|$)/gm;
const REASON = /\[([a-z]+)\]$/;
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
  });

  it('each say why no recording backs them', () => {
    for (const marker of found) {
      const reason = REASON.exec(marker.text)?.[1];
      expect(reason && reason in WHY_NO_RECORDING ? reason : `no [reason] in「${marker.text}」`, marker.file).toBe(reason);
      expect(marker.text.replace(REASON, '').trim(), marker.file).not.toBe('');
    }
  });

  it('never appear in a recording', () => {
    expect(found.filter((marker) => marker.recorded)).toEqual([]);
  });
});
