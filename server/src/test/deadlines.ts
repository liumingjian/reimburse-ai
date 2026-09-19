// The suite's timeout hierarchy, in one place so it cannot invert again.
//
// Tests that drive the real pipeline — parsing invoices, running a fill job over the fake ERP — advance by waiting on
// a condition (`inventory.status === 'done'`, `erp.status !== 'running'`), never by sleeping for a fixed span. Each of
// those pollers carries BACKSTOP_MS as a safety net, and its failure message names what it was still waiting for.
//
// That only works while vitest's own testTimeout stays strictly above BACKSTOP_MS. Until 2026-09-19 it did not:
// vitest ran on its 5s default, so the outer limit was four times tighter than the inner one. Two consequences, both
// observed on a MacBook running the suite three times over:
//
//   1. The outer limit always fired first, so every failure read `Test timed out in 5000ms` — the poller's diagnostic
//      was unreachable by construction.
//   2. Honest work turned red under load. These tests need five to six seconds of real CPU; an idle machine passed,
//      a busy one failed. Three consecutive runs of the same commit went red, green, red.
//
// Fourteen tests had already been patched one at a time with their own `}, 120_000)` overrides; the four that failed
// were simply the ones nobody had patched yet. This module replaces that per-test whack-a-mole with one default.

/** Safety net for the suite's condition pollers. Reaching it means the condition never came true. */
export const BACKSTOP_MS = 20_000;

/**
 * Vitest's per-test limit. Must exceed BACKSTOP_MS so a stuck poller reports what it was waiting for, rather than
 * being killed first by a timeout that can say nothing. Asserted in server/vitest.config.ts.
 */
export const TEST_TIMEOUT_MS = 60_000;
