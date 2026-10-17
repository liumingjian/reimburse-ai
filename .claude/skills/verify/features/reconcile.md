# 对账 and 转人工

When a 去报销 ends after an ERP action attempt with its result unknown (ERP 写入结果未知), the task goes to 对账. The
page shows ERP's own words and screenshot, offers a read-only 对账, and lets the employee 转人工 or 重新去报销. Nothing
is ever replayed.

## Sub-features

- `offered`: the 对账 page shows 写入结果不确定, ERP's text and screenshot, and only 开始对账 and 转人工.
- `read`: 开始对账 reads ERP without writing and shows a bucket (未知 when no form is found). The offer becomes
  重新对账 / 重新去报销 / 转人工.
- `hand-off`: 转人工 ends the task as 已转人工. The account may start its next task.

## How to get to it (user POV)

- After an uncertain 去报销: `/#/task/<id>/reconcile`, the region 处置.

## Driving it with verify.sh

Preconditions: `export const fake = 'uncertain_save'`; `v.signIn()` then `v.confirmedTask()`.

- **Run it.** `rexec --background --timeout 1500 '.claude/skills/verify/verify.sh run reconcile-uncertain'`.
- **Reach 对账.** Click 去报销 on `/review`, then poll until `stage === 'reconcile'`.
- **Offered.** Open `/#/task/<id>/reconcile`. `getByRole('alert')` contains 写入结果不确定,
  `getByTestId('erp-text')` reads 保存未完成：报销系统没有返回处理结果。, and the buttons of
  `getByRole('region', { name: '处置' })` are exactly 开始对账 and 转人工.
- **Read.** Click 开始对账. `getByTestId('reconcile-bucket')` reads 未知.
- **Hand off.** Click 转人工. `getByTestId('reconcile-status')` reads 已转人工 and the snapshot reads
  `reconcile.status: 'handed_off'`.
- **Proof.** Screenshots `reconcile-offered`, `reconcile-unknown` and `handed-off`, plus snapshot `handed-off`.

## Gotchas

- The reconcile double always finds no form (`noFormOpen`), so only the 未知 bucket is reachable here. The other
  buckets are covered by `server/src/erp/reconcile.test.ts`.
- 重新去报销 from 对账 is offered only after a read. Driving it reuses the same `uncertain_save` double, so it ends
  uncertain again.
