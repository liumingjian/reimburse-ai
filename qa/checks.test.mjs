// Checks the browser-free decisions of the QA driver: which project the ERP sections use, how an `idle`
// ERP view is read, and how long the rotate check waits.
//   node --test "qa/*.test.mjs"
// Deliberately not part of `pnpm test`: the driver is an operator tool, not a CI job.
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { EXAMPLE_REAL_PROJECT, OFFLINE_PROJECT, catalogRefusal, erpIdleFindings, erpProjectTarget, waitForChange } from './checks.mjs';

const repo = new URL('..', import.meta.url);
const read = (path) => readFile(fileURLToPath(new URL(path, repo)), 'utf8');

// --- F1: the ERP sections need a project this ERP account really has -------------------------------

test('without QA_PROJECT the fallback is the offline number, and it says what that costs', () => {
  const target = erpProjectTarget({});
  assert.equal(target.number, OFFLINE_PROJECT.number);
  assert.equal(target.real, false);
  assert.ok(target.warning, 'falling back to an offline-only number must be announced, not silent');
  assert.match(target.warning, /QA_PROJECT/);
  // The operator has to be able to read, from this one sentence, why 去报销 never opened the assistant.
  assert.match(target.warning, /报销信息核对/);
  assert.match(target.warning, /catalog/);
});

test('QA_PROJECT with a name is used as given, with nothing to warn about', () => {
  const target = erpProjectTarget({ QA_PROJECT: EXAMPLE_REAL_PROJECT.number, QA_PROJECT_NAME: EXAMPLE_REAL_PROJECT.name });
  assert.deepEqual(target, { number: EXAMPLE_REAL_PROJECT.number, name: EXAMPLE_REAL_PROJECT.name, real: true, warning: null });
});

test('QA_PROJECT without a name still runs, but warns that the catalog compares names too', () => {
  const target = erpProjectTarget({ QA_PROJECT: '111705' });
  assert.equal(target.real, true);
  assert.equal(target.name, '111705');
  assert.match(target.warning, /QA_PROJECT_NAME/);
});

test('blank and whitespace-only QA_PROJECT count as unset', () => {
  for (const value of ['', '   ']) {
    assert.equal(erpProjectTarget({ QA_PROJECT: value }).real, false, `«${value}»`);
  }
});

test('the offline project-book section keeps its own fixture numbers', async () => {
  const driver = await read('qa/run.mjs');
  const book = driver.slice(driver.indexOf('async function qaProjectBook'), driver.indexOf('async function qaAssignment'));
  // That section is about offline intake and duplicate / unsafe-number feedback; both fixture numbers stay.
  assert.ok(book.includes(`'P-3312'`), 'the offline section lost P-3312');
  assert.match(book, /intake\('P-2307'/, 'the offline section lost its P-2307 duplicate check');
});

test('the example project in the README is a real one from this account, not a default', async () => {
  const readme = await read('qa/README.md');
  assert.ok(readme.includes('QA_PROJECT'), 'QA_PROJECT is not documented in the env table');
  assert.ok(readme.includes(EXAMPLE_REAL_PROJECT.number), 'the README does not show a real example number');
  const driver = await read('qa/run.mjs');
  assert.ok(!driver.includes(EXAMPLE_REAL_PROJECT.number), 'the example project number leaked into the driver as a default');
});

// --- F2: an `idle` ERP view can be a catalog refusal ------------------------------------------------

const MISMATCH = {
  status: 'mismatch',
  problems: [{ subject: '项目号 P-2307', reason: '项目 P-2307「华东客户交付」在报销系统里查不到', reference: null, resolver: '要你处理' }],
};

test('a catalog refusal is never a defect, and the finding names the refusal', () => {
  const findings = erpIdleFindings({ catalog: MISMATCH });
  assert.equal(findings.filter((f) => f.level === 'DEFECT').length, 0, 'a server refusal with a good reason is not a defect');
  const [first] = findings;
  assert.equal(first.level, 'ok');
  // The next operator must not have to open erp_job_event to learn which refusal it was.
  assert.match(first.text, /P-2307/);
  assert.match(first.text, /查不到/);
  assert.ok(
    findings.some((f) => f.level === 'WARN' && /QA_PROJECT/.test(f.text)),
    'a human should be told the browser-off path was not exercised',
  );
});

test('a matched catalog with no refusal anywhere is still a defect', () => {
  const findings = erpIdleFindings({ catalog: { status: 'matched', problems: [] }, refusals: [] });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].level, 'DEFECT');
});

test('a preflight refusal on the page is a warning, and is quoted', () => {
  const findings = erpIdleFindings({ catalog: null, refusals: ['  铁路客票\n还没有对应的发票类型  ', ''] });
  assert.deepEqual(findings.map((f) => f.level), ['WARN']);
  assert.match(findings[0].text, /铁路客票 还没有对应的发票类型/);
});

test('catalogRefusal only speaks for a mismatch', () => {
  assert.equal(catalogRefusal(null), null);
  assert.equal(catalogRefusal({ status: 'pending', problems: [] }), null);
  assert.equal(catalogRefusal({ status: 'matched', problems: [] }), null);
  assert.match(catalogRefusal(MISMATCH), /^项目号 P-2307：/);
});

test('the idle mapping this rests on is still in the server', async () => {
  const fillState = await read('server/src/erp/fill-state.ts');
  // `catalog_mismatch` falls through to the `idle` view on purpose; if that ever changes, the erp-off
  // area is reading the wrong section and this test should be the first to say so.
  assert.match(fillState, /catalog mismatch \(its problems are in the catalog section\)/);
});

// --- F3: the rotate check must outlast a real re-render ---------------------------------------------

// A value that only changes after `afterMs` of simulated time, on a clock that moves only when we sleep.
function delayedValue(afterMs) {
  let clock = 0;
  return {
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    read: async () => (clock >= afterMs ? 'after' : 'before'),
  };
}

test('a re-render that lands at seven seconds is seen, and reported as a change', async () => {
  const { now, sleep, read } = delayedValue(7000);
  const result = await waitForChange(read, { timeout: 30000, interval: 500, sleep, now });
  assert.equal(result.changed, true);
  assert.equal(result.from, 'before');
  assert.equal(result.value, 'after');
  assert.ok(result.waited >= 7000 && result.waited <= 7500, `waited ${result.waited}ms`);
});

test('the old four-second budget would have missed it', async () => {
  const { now, sleep, read } = delayedValue(7000);
  assert.equal((await waitForChange(read, { timeout: 4000, interval: 500, sleep, now })).changed, false);
});

test('a value that never changes is reported unchanged, so the assertion still bites', async () => {
  const { now, sleep } = delayedValue(7000);
  const result = await waitForChange(async () => 'same', { timeout: 30000, interval: 500, sleep, now });
  assert.equal(result.changed, false);
  assert.equal(result.value, 'same');
});

test('the driver gives the rotate re-render a budget well past the measured seven seconds', async () => {
  const driver = await read('qa/run.mjs');
  const print = driver.slice(driver.indexOf('async function qaPrint'), driver.indexOf('async function qaSettings'));
  const rotate = print.slice(print.indexOf('const rotate ='));
  const [, timeout] = rotate.match(/waitForChange\([\s\S]*?timeout:\s*(\d+)/) ?? [];
  assert.ok(timeout, 'the rotate check no longer polls for the change');
  assert.ok(Number(timeout) >= 20000, `the rotate budget is ${timeout}ms, too close to the measured ~7s re-render`);
});

test('an explicit starting value is honoured, so a change during the action is not missed', async () => {
  const { now, sleep } = delayedValue(0);
  const result = await waitForChange(async () => 'after', { from: 'before', timeout: 30000, interval: 500, sleep, now });
  assert.equal(result.changed, true);
  assert.equal(result.from, 'before');
});
