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
 * What the `erp-off` area records when `erp.status` never left `idle`.
 *
 * `idle` on its own does not mean the app did nothing, and it has two separate reasons for saying so.
 *
 * A clean abort — the job stopped BEFORE writing anything — also reports `status: 'idle'`, and carries its
 * explanation in `erp.abortReason`; only the `unknown` phase, where the write may have landed, reports
 * `status: 'aborted'` (server/src/erp/fill-state.ts:210-224). Watching `status` alone therefore misses exactly
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
  const reason = String(abortReason ?? '').replace(/\s+/g, ' ').trim();
  if (reason) {
    const found = [{ level: 'ok', text: `the ERP write stopped before any change: ${reason.slice(0, 220)}` }];
    if (!/浏览器|Chrome|9333/.test(reason)) {
      found.push({ level: 'WARN', text: 'the abort reason does not say the dedicated browser is unavailable' });
    }
    return found;
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
      text: 'with the ERP browser off the write stayed idle: no abort reason, no 报销信息核对 problem and no refusal on the page, so nothing says why it stopped',
    },
  ];
}

/**
 * Whether the `erp-off` poll can stop. A clean abort never changes `erp.status`, so waiting for it to leave
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
 * Used for the print page's rotate check: `imageUrl` is content-addressed (server/src/print/facts.ts), so a
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
