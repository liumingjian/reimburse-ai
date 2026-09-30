// @vitest-environment node
// Guard for DESIGN.md「版式统一」(#319): pages build cards, button groups, summary bars and key/value blocks from the
// shared components in src/shell, not by hand. Reads the page sources only; no DOM.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const pagesDir = fileURLToPath(new URL('./pages/', import.meta.url));
const pages = readdirSync(pagesDir)
  .filter((name) => name.endsWith('.tsx') && !name.endsWith('.test.tsx'))
  .map((name) => ({ name, source: readFileSync(join(pagesDir, name), 'utf8') }));

// Each pattern is a hand-built stand-in for a shared component; the message names the component to use instead.
const FORBIDDEN: readonly { pattern: RegExp; use: string }[] = [
  { pattern: /className="app-btn-row/, use: 'ActionGroup (in content) or ActionBar (a whole step)' },
  { pattern: /className="app-summary(-field)?[" ]/, use: 'SummaryBar and SummaryField' },
  { pattern: /className="app-(action-card|two-actions)/, use: 'Card and CardRow' },
  { pattern: /className="app-kv/, use: 'DetailList' },
  { pattern: /aria-pressed=\{scope/, use: 'ContentSwitcher for switching a view' },
];

describe('版式统一', () => {
  test('pages use the shared layout components instead of hand-built ones', () => {
    expect(pages.length).toBeGreaterThan(0);
    for (const { name, source } of pages) {
      for (const { pattern, use } of FORBIDDEN) {
        expect(source, `${name}: use ${use}`).not.toMatch(pattern);
      }
    }
  });

  test('action bar buttons keep Carbon default size', () => {
    for (const { name, source } of pages) {
      for (const bar of source.matchAll(/<ActionBar[\s\S]*?\n\s*\/>/g)) {
        expect(bar[0], `${name}: action bar buttons are lg (the default)`).not.toMatch(/size="(sm|md)"/);
      }
    }
  });
});
