# 去报销

From a confirmed claim the employee clicks 去报销 and the app fills the ERP 费用报销单. It stops, without writing,
when ERP is not logged in, when 报销信息核对 finds a project ERP does not know, or when no executor can be reached.
While a run is on, the page shows 填写报销单 and the task cannot be voided.

## Sub-features

- `login-wall`: ERP sits on its login page. The job pauses at 等待登录 with nothing written, and 取消去报销 returns
  the task to 整单确认.
- `catalog-mismatch`: 报销信息核对 finds a renamed project. The task goes back to 项目归属 before any import.
- `no-executor`: production has no paired extension, so the page sends the employee to 设置 to pair it, and back.
- `uncertain`: the write's result is unknown. See [对账](./reconcile.md).

## How to get to it (user POV)

- `/#/task/<id>/review`, then in the region 整单确认 the button 去报销. That leads to `/#/task/<id>/erp`.
- `/#/task/<id>/erp` while running or paused: 我已登录，继续 and 取消去报销.

## Driving it with verify.sh

Preconditions: `v.signIn()` then `v.confirmedTask()`. The ERP double comes from the scenario's `fake`, or `--fake`.

- **login-wall.** Run `verify.sh run login-wall`. Click `getByRole('button', { name: '去报销', exact: true })`. The
  URL ends `/erp` and the heading 填写报销单 is visible. Poll until `step.kind === 'erp_login'` and
  `erp.status === 'waiting_login'`. Click 取消去报销: the URL ends `/review`, 去报销 is enabled again, and the
  snapshot reads `erp.status: 'idle'`.
- **catalog-mismatch.** No scenario yet. Write one with `export const fake = 'catalog_mismatch'`. After 去报销, poll
  until `stage === 'project'`. The snapshot reads `catalog.status: 'mismatch'` and `erp.status: 'idle'`. The project
  page has an alert containing 报销信息核对发现项目不匹配.
- **no-browser.** With `--fake none` the CDP executor finds no browser, because `BAOX_ERP_CHROMIUM=off`. The job stops
  before any attempt and `erp.abortReason` says why.
- **Proof.** Screenshots `waiting-login` and `cancelled`, plus snapshots `waiting-login` and `after-cancel`. Nothing
  is written: no `erp_attempt`, so `erp.outcome` stays `none`.

## Gotchas

- These are scripted doubles at the executor seam. They prove the app's projection of each ERP behaviour, not the fill
  steps against a real form (`pnpm test:erp-live`, and `erp-executor`'s fake-ERP tests).
- `no-executor` is the production extension path (`main.ts`). The e2e server runs the CDP executor, so this harness
  cannot reach the real refusal. `web/e2e/server/erp.spec.ts` stubs it with `page.route`.
- The account's ERP lease is held while a job is paused. A second task of the same account cannot start 去报销.
