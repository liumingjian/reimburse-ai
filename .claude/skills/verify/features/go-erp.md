# 去报销

From a confirmed claim the employee clicks 去报销 and the app fills the ERP 费用报销单 and 暂存s it: every run ends at
ERP 草稿已交接 (ADR-0037), and nothing on the way waits for the employee. It stops, without writing, when it cannot sign
in to ERP, when 报销信息核对 finds a project ERP does not know, or when no executor can be reached. While a run is on,
the page shows 填写报销单 and the task cannot be voided.

## Sub-features

- `drafted`: the one ending. The job 暂存s the bill and finds it again; the page offers 去报销系统查看 and the 内码.
- `not-signed-in`: ERP sits on its login page and the job has no 凭据. It stops before any attempt and the task is back
  at 整单确认 with the reason.
- `catalog-mismatch`: 报销信息核对 finds a renamed project. The task goes back to 项目归属 before any import.
- `no-executor`: production has no paired 本地执行器, so 去报销 is refused with a link to the 设置页.
- `uncertain`: the write's result is unknown. See [对账](./reconcile.md).

## How to get to it (user POV)

- `/#/task/<id>/review`, then in the region 整单确认 the button 去报销. That leads to `/#/task/<id>/erp`.
- `/#/task/<id>/erp` while running: the steps and the bar, nothing to click but 刷新状态; when done, 查看完成结果.

## Driving it with verify.sh

Preconditions: `v.signIn()` then `v.confirmedTask()`. The ERP double comes from the scenario's `fake`, or `--fake`.

- **drafted.** Run `verify.sh run drafted`. Click `getByRole('button', { name: '去报销', exact: true })`. The URL ends
  `/erp` and the heading 填写报销单 is visible. The link 查看完成结果 appears with no button to press on the way, and
  the snapshot reads `erp.outcome: 'drafted'`, `erp.review.draftId: '119946'`.
- **not-signed-in.** `--fake not_signed_in`. After 去报销, poll until `stage === 'actions'`: `erp.status: 'idle'` and
  `erp.abortReason` names the 设置页. No `erp_attempt` is written.
- **catalog-mismatch.** No scenario yet. Write one with `export const fake = 'catalog_mismatch'`. After 去报销, poll
  until `stage === 'project'`. The snapshot reads `catalog.status: 'mismatch'` and `erp.status: 'idle'`. The project
  page has an alert containing 报销信息核对发现项目不匹配.
- **no-browser.** With `--fake none` the CDP executor finds no browser, because `BAOX_ERP_CHROMIUM=off`. The job stops
  before any attempt and `erp.abortReason` says why.
- **Proof.** Screenshot and snapshot `drafted`: `erp.outcome` is `drafted` and the 内码 is on the page.

## Gotchas

- These are scripted doubles at the executor seam. They prove the app's projection of each ERP behaviour, not the fill
  steps against a real form (`pnpm test:erp-live`, and `erp-executor`'s fake-ERP tests).
- `no-executor` is the production path (`main.ts`). The e2e server runs an executor of its own, so this harness cannot
  reach the real refusal; the task policy's table and the web page tests cover it.
- The account's ERP lease is held while a job runs. A second task of the same account cannot start 去报销.
