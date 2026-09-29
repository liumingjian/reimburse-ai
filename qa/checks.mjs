// Decisions the QA driver makes that do not need a browser: which project the ERP sections assign to,
// how to read an ERP view that stayed `idle`, and how long to wait for a re-render.
//
// Kept apart from the driver so it can be checked without a browser: `node --test "qa/*.test.mjs"`.
// Deliberately not part of `pnpm test`: the driver is an operator tool, not a CI job.

// The offline project-book section enters these two on purpose: no ERP session, no catalog fixture, and
// the duplicate / unsafe-number feedback is what it is there to check. They are fixture numbers — the real
// 报销系统 (reimbursement system) has never heard of them, and says so.
export const OFFLINE_PROJECT = { number: 'P-2307', name: '华东客户交付' };

// A project number the operator's own ERP account really carries, for the README. Never a default: a
// project book is per account, and inventing a number for someone else's account only moves the failure.
export const EXAMPLE_REAL_PROJECT = { number: '111705', name: '安徽省农村信用社联合社-开源软件运维人员驻场服务-25-111705' };

/**
 * The project the ERP-facing sections assign every line to. `QA_PROJECT` / `QA_PROJECT_NAME` name a project
 * of the operator's own ERP account; without them the driver falls back to the offline fixture number,
 * which 报销信息核对 (the catalog check, 原文 报销信息核对) will correctly refuse — so say so out loud
 * rather than letting the run look like an app defect.
 *
 * Returns `{ number, name, real, warning }`; `warning` is the sentence the driver must record, or null.
 */
export function erpProjectTarget(env = {}) {
  const number = String(env['QA_PROJECT'] ?? '').trim();
  const name = String(env['QA_PROJECT_NAME'] ?? '').trim();
  if (!number) {
    return {
      ...OFFLINE_PROJECT,
      real: false,
      warning:
        `QA_PROJECT is not set, so every line is assigned to the offline-only fixture number ${OFFLINE_PROJECT.number}. ` +
        '报销信息核对 will refuse it as missing and 去报销 will stop at the catalog step before the 发票无忧助手 is ever opened. ' +
        'This is the driver\'s own doing, not an app defect. Set QA_PROJECT / QA_PROJECT_NAME to a project this ERP account really has (see qa/README.md).',
    };
  }
  if (!name) {
    return {
      number,
      name: number,
      real: true,
      warning:
        `QA_PROJECT=${number} was given without QA_PROJECT_NAME, so the project name is standing in as the number. ` +
        '报销信息核对 compares the name against the 报销系统 as well, and will report 名称不一致 unless the personal project book already carries the real name.',
    };
  }
  return { number, name, real: true, warning: null };
}

/**
 * The 报销信息核对 refusal in a task snapshot's `catalog` section, as one readable sentence, or null when
 * there is none. The section exists precisely so a catalog refusal can be read without digging through
 * `erp_job_event`.
 */
export function catalogRefusal(catalog) {
  if (!catalog || catalog.status !== 'mismatch') return null;
  const problems = (catalog.problems ?? [])
    .map((p) => `${p?.subject ?? '?'}：${p?.reason ?? '?'}`.replace(/\s+/g, ' '))
    .filter(Boolean);
  return problems.length > 0 ? problems.join(' | ') : '报销信息核对 refused the write but listed no problem';
}

/**
 * What the `erp-write` area records when `erp.status` never left `idle`.
 *
 * `idle` on its own does not mean the app did nothing, and it has two separate reasons for saying so.
 *
 * A clean abort — the job stopped BEFORE writing anything — also reports `status: 'idle'`, and carries its
 * explanation in `erp.abortReason`; only the `unknown` phase, where the write may have landed, reports
 * `status: 'aborted'` (server/src/task-snapshot/erp.ts, `erpView`). Watching `status` alone therefore misses exactly
 * the case this section exists to check, which is how a correct abort was recorded as a defect.
 *
 * A catalog mismatch is likewise mapped to the plain `idle` view on purpose, because its problems belong to
 * the snapshot's `catalog` section. A server refusal with a good reason is not a defect — so name the refusal
 * and move on. Only an `idle` with no reason anywhere is the app going quiet, which is.
 *
 * `refusals` are the page's own `role=alert` texts (a preflight refusal the ERP browser has nothing to do
 * with). Returns a list of `{ level, text }`.
 */
export function erpIdleFindings({ catalog = null, refusals = [], abortReason = null } = {}) {
  const notReached =
    'so the browser-off path under test was never reached. Assign the lines to a project this ERP account really has (QA_PROJECT) to exercise it.';

  // A clean abort is the good outcome of this section, not a silence: it says the run stopped before writing.
  // Which of the two paths it stopped on is read off the reason itself — the driver cannot see the dedicated
  // Chromium, and naming the wrong path is how a real write came to be reported in browser-off terms.
  const reason = String(abortReason ?? '').replace(/\s+/g, ' ').trim();
  if (reason) {
    const path = /浏览器|Chrome|9333/.test(reason)
      ? 'the dedicated browser was unavailable'
      : 'the dedicated browser was available and the run stopped for another reason';
    return [{ level: 'ok', text: `the ERP write stopped before any change (${path}): ${reason.slice(0, 220)}` }];
  }

  const refusal = catalogRefusal(catalog);
  if (refusal) {
    return [
      { level: 'ok', text: `报销信息核对 stopped 去报销 before the write started, and nothing was written: ${refusal}` },
      { level: 'WARN', text: `the catalog refusal came first, ${notReached}` },
    ];
  }

  const alerts = refusals
    .map((t) => String(t ?? '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' | ');
  if (alerts) {
    return [{ level: 'WARN', text: `去报销 was refused before the write started, ${notReached} The refusal: ${alerts.slice(0, 300)}` }];
  }

  return [
    {
      level: 'DEFECT',
      text: '去报销 left the ERP view idle: no abort reason, no 报销信息核对 problem and no refusal on the page, so nothing says why it stopped',
    },
  ];
}

/**
 * Whether the `erp-write` poll can stop. A clean abort never changes `erp.status`, so waiting for it to leave
 * `idle` burns the whole budget on a state that has already settled; `abortReason` is what actually moves.
 */
export function erpPollSettled({ status = null, abortReason = null, catalog = null } = {}) {
  if (status === 'aborted' || status === 'done' || status === 'waiting_login') return true;
  if (String(abortReason ?? '').trim()) return true;
  return catalog?.status === 'mismatch';
}


const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll `read` until its value differs from the one it started at, or the budget runs out.
 *
 * Used for the print page's rotate check: `imageUrl` is content-addressed (server/src/task-snapshot/print.ts), so a
 * finished re-render cannot fail to change the `src` — but the re-render itself takes seconds, measured at
 * about seven against the live app. A fixed sleep shorter than that reports a working feature as broken.
 *
 * `from` is the value to compare against; pass it when it has to be read before the action that changes it,
 * so nothing is missed in between. `sleep` and `now` are injected so the wait can be checked without real
 * time passing.
 */
export async function waitForChange(read, { from: start, timeout = 30000, interval = 500, sleep = realSleep, now = Date.now } = {}) {
  const from = start === undefined ? await read() : start;
  const started = now();
  let value = from;
  while (now() - started < timeout) {
    await sleep(interval);
    value = await read();
    if (value !== from) return { changed: true, from, value, waited: now() - started };
  }
  return { changed: false, from, value, waited: now() - started };
}

/**
 * How long the `erp-write` area waits after clicking 去报销.
 *
 * It used to be 120 s, chosen for a write that aborts at once because the dedicated browser is off. Measured
 * live 2026-09-19, a real write — catalog check, form, upload, 发票导入单据 with ten invoices, read-back, fill —
 * took about 141 s end to end, so the budget expired mid-write, the poll saw `erp.status: 'running'` and the
 * area called a successful import a defect. The budget is now roughly twice the measured write.
 */
export const ERP_WRITE_BUDGET_MS = 300_000;

/**
 * What the one 去报销 the driver performs actually did, in the words of the path it took.
 *
 * `erp-off` was the only area that clicked 去报销, and it described every outcome as if the dedicated Chromium
 * were off — which it usually is not. The driver cannot see that browser; the snapshot is all it has, so the
 * path is read off the outcome:
 *
 *   `done`         the write ran to the end and the form is waiting for the employee's 保存 (ADR-0028). The
 *                  browser was plainly available. This is a pass, and the area had no way to say so before.
 *   `aborted`      only the `unknown` phase reports this (server/src/task-snapshot/erp.ts): the write may have
 *                  landed and the app cannot tell. Over an irreversible import that is a defect to report,
 *                  whatever caused it.
 *   `waiting_login` the browser is up but nobody is logged in; nothing was written, and the run is paused for
 *                  a human. Not a defect, and not something the driver can finish.
 *   `running`      still in flight when the budget ran out. The browser is on and the write is working; the
 *                  budget expired, not the app. A warning about this run's coverage, never a defect.
 *   `idle`/null    nothing moved: `erpIdleFindings` reads the clean abort, the catalog refusal or the silence.
 *
 * `waitedMs` / `budgetMs` are reported with the `running` case so the next operator can see which of the two
 * ran out. Returns a list of `{ level, text }`.
 */
export function erpWriteFindings({ status = null, abortReason = null, catalog = null, refusals = [], waitedMs = null, budgetMs = ERP_WRITE_BUDGET_MS } = {}) {
  const reason = String(abortReason ?? '').replace(/\s+/g, ' ').trim();
  const seconds = (ms) => `${Math.round(Number(ms ?? 0) / 1000)}s`;
  if (status === 'done') {
    return [{ level: 'ok', text: '去报销 ran with the ERP browser available and finished: the 费用报销单 is filled and handed over unsaved, for the employee to check and 保存 themselves' }];
  }
  if (status === 'aborted') {
    return [{ level: 'DEFECT', text: `去报销 ended with the write result undetermined (erp.status aborted), so the employee is told to go and look for themselves: ${reason.slice(0, 300) || '(no reason recorded)'}` }];
  }
  if (status === 'waiting_login') {
    return [{ level: 'WARN', text: 'the dedicated browser is open but not logged in, so 去报销 is paused at 登录 and wrote nothing. Log in in that window and run this area again to cover the write.' }];
  }
  if (status === 'running') {
    return [{ level: 'WARN', text: `去报销 was still running when this area's ${seconds(budgetMs)} budget ran out after ${seconds(waitedMs)} — the ERP browser is on and the write is in flight, so this run's outcome is unknown to the driver, not wrong. Check the task page for how it ended.` }];
  }
  return erpIdleFindings({ catalog, refusals, abortReason });
}

/**
 * Where the abort reason is on screen — and it is not always the page the driver is standing on.
 *
 * The driver used to click 去报销 on `#/task/:id/review`, wait, and then look for the reason THERE. That is right
 * for exactly one outcome and wrong for every other:
 *
 *   - a clean abort keeps `erp.status` at `idle`, the task stays on its old stage, and `ReviewPage.tsx:299` prints
 *     the reason under 去报销 as `data-testid="erp-abort-reason"` — but only while `erp.status === 'idle'`;
 *   - anything that started writing reports `erp.status: 'aborted'` (the `unknown` phase), and the same ReviewPage
 *     branch then shows 「查看填报进度」 INSTEAD of the reason and sends the employee to the task's current stage
 *     page, where the reason is (`ErpPage.tsx:135`, `ReconcilePage.tsx:63`, `TaskRoute.tsx:49`).
 *
 * So `the abort reason is not shown anywhere in the UI` was the driver asserting on a page the app had already
 * moved the employee off. Verified against the three components on 2026-09-19: the app shows it, the driver was
 * looking in one place.
 */
export function abortReasonPage(status) {
  return status === null || status === undefined || status === 'idle' ? 'review' : 'stage';
}

/**
 * The task page for a stage, mirroring `contract/src/stage.ts`'s `STAGE_DEFAULT_PAGE` — which is the map
 * ReviewPage's own 「查看填报进度」 button uses, so following it is following the employee.
 * `qa/checks.test.mjs` pins this copy against that source.
 */
export const STAGE_PAGE = {
  upload: 'upload', inventory: 'inventory', pending: 'pending', project: 'project',
  catalog: 'review', preparation: 'review', review: 'review', actions: 'review',
  erp: 'erp', done: 'done', reconcile: 'reconcile', voided: 'upload',
};

/**
 * What the `erp-write` area records about the reason being readable. `shown` is what the driver found on the page
 * `abortReasonPage` sent it to; `page` is that page, so a failure names where it looked.
 */
export function abortReasonFindings({ reason = null, shown = false, page = null } = {}) {
  const text = String(reason ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return [];
  if (shown) return [{ level: 'ok', text: `the reason 去报销 stopped is readable on the ${page} page without opening a console` }];
  return [{ level: 'DEFECT', text: `去报销 recorded a reason the employee cannot read: nothing on the ${page} page shows「${text.slice(0, 120)}」` }];
}
