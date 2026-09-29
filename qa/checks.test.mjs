// Checks the browser-free decisions of the QA driver: which project the ERP sections use, how an `idle`
// ERP view is read, and how long the rotate check waits.
//   node --test "qa/*.test.mjs"
// Deliberately not part of `pnpm test`: the driver is an operator tool, not a CI job.
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { ERP_WRITE_BUDGET_MS, EXAMPLE_REAL_PROJECT, OFFLINE_PROJECT, STAGE_PAGE, abortReasonFindings, abortReasonPage, catalogRefusal, erpIdleFindings, erpPollSettled, erpProjectTarget, erpWriteFindings, waitForChange } from './checks.mjs';

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
  const erpView = await read('server/src/task-snapshot/erp.ts');
  // `catalog_mismatch` falls through to the `idle` view on purpose; if that ever changes, the erp-off
  // area is reading the wrong section and this test should be the first to say so.
  assert.match(erpView, /catalog mismatch \(its problems are in the catalog section\)/);
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

// --- F4: a clean abort speaks through abortReason, not through status ------------------------------

test('a clean abort is the good outcome, not a defect: status stays idle and abortReason carries the reason', () => {
  const found = erpIdleFindings({
    abortReason: '上次去报销在写入报销系统之前就停止了，报销系统没有被改动，可以再去报销。原因：报销专用 Chromium 浏览器不可用',
  });
  assert.equal(found.filter((f) => f.level === 'DEFECT').length, 0);
  const good = found.find((f) => f.level === 'ok');
  assert.ok(good, 'a clean abort was not recorded as ok');
  assert.match(good.text, /停止|stopped before any change/);
});

test('a clean abort names which of the two paths it stopped on, since the driver cannot see the browser', () => {
  const off = erpIdleFindings({ abortReason: '停止了，原因：报销专用 Chromium 浏览器不可用' });
  assert.match(off.find((f) => f.level === 'ok').text, /browser was unavailable/);
  const on = erpIdleFindings({ abortReason: '停止了，原因：发票无忧助手没有建立页面连接' });
  assert.equal(on.filter((f) => f.level === 'DEFECT').length, 0);
  assert.match(on.find((f) => f.level === 'ok').text, /browser was available/);
});

test('an idle view with no reason of any kind is still the one real defect', () => {
  const found = erpIdleFindings({ abortReason: '   ', catalog: { status: 'matched' }, refusals: [] });
  assert.equal(found.filter((f) => f.level === 'DEFECT').length, 1);
});

test('the poll stops as soon as abortReason appears, because status will never move', () => {
  assert.equal(erpPollSettled({ status: 'idle', abortReason: null, catalog: null }), false);
  assert.equal(erpPollSettled({ status: 'idle', abortReason: '停止了', catalog: null }), true);
  assert.equal(erpPollSettled({ status: 'idle', abortReason: '  ', catalog: { status: 'mismatch' } }), true);
  assert.equal(erpPollSettled({ status: 'aborted' }), true);
  assert.equal(erpPollSettled({ status: 'running' }), false);
});

test('the driver reads abortReason, not just erp.status', async () => {
  const run = await read('qa/run.mjs');
  assert.match(run, /erpPollSettled\(\{\s*status,\s*abortReason: reason/);
  assert.match(run, /erpWriteFindings\(\{[^)]*abortReason: reason/);
});

// --- D2: the one real 去报销 the driver performs, described in the words of the path it took --------
//
// Live 2026-09-19: the dedicated browser was ON, the import bound 10 of 10 invoices and the whole write took
// about 141 s. The area's budget was 120 s, so the poll ended on `erp.status: 'running'` and the driver logged
// `[DEFECT] erp-off: with the ERP browser off the write ended in status running instead of aborting cleanly`
// over a successful write, with the browser on.

test('a write still running when the budget expires is a coverage warning, not a browser-off defect', () => {
  const found = erpWriteFindings({ status: 'running', waitedMs: 120000, budgetMs: 120000 });
  assert.equal(found.filter((f) => f.level === 'DEFECT').length, 0, 'a write in flight is not a defect');
  const warning = found.find((f) => f.level === 'WARN');
  assert.ok(warning, 'a budget that ran out mid-write has to be said out loud');
  assert.match(warning.text, /still running/);
  assert.match(warning.text, /120s/);
  assert.doesNotMatch(warning.text, /browser off|browser is off/);
});

test('the completed write — the browser-available path — is reported as the pass it is', () => {
  const found = erpWriteFindings({ status: 'done' });
  assert.equal(found.filter((f) => f.level !== 'ok').length, 0);
  assert.match(found[0].text, /available/);
  // ADR-0028: baox hands the filled form over; it never clicks 保存.
  assert.match(found[0].text, /保存/);
});

test('an undetermined write result stays a defect, because the import cannot be undone', () => {
  const found = erpWriteFindings({ status: 'aborted', abortReason: '写入报销系统的结果不确定，应用已停止写入，不会重放。原因：INVOICE_IMPORT_NOT_ANSWERED' });
  assert.equal(found.filter((f) => f.level === 'DEFECT').length, 1);
  assert.match(found[0].text, /INVOICE_IMPORT_NOT_ANSWERED/);
});

test('a browser that is up but not logged in pauses the write, and says so', () => {
  const found = erpWriteFindings({ status: 'waiting_login' });
  assert.equal(found.filter((f) => f.level === 'DEFECT').length, 0);
  assert.match(found.find((f) => f.level === 'WARN').text, /登录/);
});

test('an idle view is still read by erpIdleFindings, unchanged', () => {
  const reason = '上次去报销在写入报销系统之前就停止了，报销系统没有被改动，可以再去报销。原因：报销专用 Chromium 浏览器不可用';
  assert.deepEqual(erpWriteFindings({ status: 'idle', abortReason: reason }), erpIdleFindings({ abortReason: reason }));
  assert.equal(erpWriteFindings({ status: null, catalog: { status: 'matched' } }).filter((f) => f.level === 'DEFECT').length, 1);
});

test('the budget clears the measured 141s write with room to spare', async () => {
  assert.ok(ERP_WRITE_BUDGET_MS >= 240000, `the write budget is ${ERP_WRITE_BUDGET_MS}ms, and a real write measured ~141000ms`);
  const run = await read('qa/run.mjs');
  assert.match(run, /deadline = started \+ ERP_WRITE_BUDGET_MS/);
  // The sentence that libelled a successful write. It survives only as history, in a comment: never again as
  // a verdict the driver reaches.
  assert.doesNotMatch(run, /defect\([^)]*with the ERP browser off/);
  assert.doesNotMatch(run, /area\(page, 'erp-off'/);
});

test('the ERP view still reports a clean abort as idle, which is why the above matters', async () => {
  const erpView = await read('server/src/task-snapshot/erp.ts');
  // Anchor on the aborted case of `erpView` and read forward to the next case.
  const from = erpView.indexOf("case 'aborted':");
  assert.ok(from > 0, 'the ERP view no longer has an aborted phase');
  const aborted = erpView.slice(from, erpView.indexOf("case 'handed_over':", from));
  assert.ok(aborted.includes('abortReason'), 'the aborted phase no longer sets abortReason');
  assert.ok(!/status: 'aborted'/.test(aborted), 'the aborted phase now sets status too — the driver can be simplified');
});

// --- D-D: where the abort reason is on screen ------------------------------------------------------
//
// `the abort reason is not shown anywhere in the UI` was the driver's verdict on an app that shows it in three
// places. It asserted on `#/task/:id/review` without following the task to the page the app had just sent the
// employee to. These pin the rule it now follows.

test('a clean abort keeps the employee on 整单确认, where ReviewPage prints the reason', () => {
  assert.equal(abortReasonPage('idle'), 'review');
  assert.equal(abortReasonPage(null), 'review');
});

test('a write that started moves the reason off 整单确认 and onto the task stage page', () => {
  // ReviewPage's branch is `!erpStarted && erp.abortReason`, and `erpStarted` is `erp.status !== 'idle'`, so the
  // caption the driver looked for is not rendered at all once a write has begun.
  for (const status of ['aborted', 'running', 'done', 'waiting_login']) assert.equal(abortReasonPage(status), 'stage');
});

test('the stage→page map is the contract\'s own, or the driver follows the employee to the wrong page', async () => {
  const source = await read('contract/src/stage.ts');
  const body = /STAGE_DEFAULT_PAGE:[^=]*=\s*\{([^}]*)\}/.exec(source)?.[1];
  assert.ok(body, 'STAGE_DEFAULT_PAGE must be readable from contract/src/stage.ts');
  const fromContract = Object.fromEntries([...body.matchAll(/(\w+):\s*'([^']+)'/g)].map((m) => [m[1], m[2]]));
  assert.deepEqual(STAGE_PAGE, fromContract);
});

test('a reason nobody can read is the defect; a readable one is the pass, and both name the page', () => {
  assert.deepEqual(abortReasonFindings({ reason: '  ' }), []);
  const bad = abortReasonFindings({ reason: '写入报销系统的结果不确定', shown: false, page: 'stage' });
  assert.equal(bad[0].level, 'DEFECT');
  assert.match(bad[0].text, /stage page/);
  assert.match(bad[0].text, /写入报销系统的结果不确定/);
  const good = abortReasonFindings({ reason: '写入报销系统的结果不确定', shown: true, page: 'review' });
  assert.equal(good[0].level, 'ok');
});

test('the driver really follows the task to its stage page before asserting', async () => {
  const run = await read('qa/run.mjs');
  assert.match(run, /abortReasonPage\(status\)/);
  assert.match(run, /STAGE_PAGE\[snap\?\.stage\]/);
  assert.match(run, /abortReasonFindings\(/);
  // The old one-place assertion is gone.
  assert.ok(!run.includes('the abort reason is not shown anywhere in the UI'));
});
