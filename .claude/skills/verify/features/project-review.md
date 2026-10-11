# 项目归属 and 整单确认

After 盘点 the employee keeps a personal 项目簿, assigns every line to a project, writes the 报销事由, and confirms the
whole claim on 整单明细确认. Only then are 去打印 and 去报销 offered.

## Sub-features

- `book` adds a project (项目号 + 项目名称) to the personal 项目簿.
- `assign` puts lines into projects and requires a non-blank 报销事由.
- `review` shows the 整单明细 table and confirms it, revealing 去打印 and 去报销.
- `edit-after-confirm` changes 常驻城市 after confirming; the confirmation must be given again.

## How to get to it (user POV)

- `/#/task/<id>/project`, then the fields 项目号 and 项目名称, then 加入项目, then 项目录完了，开始归属.
- On the same page: the checkbox 全选当前明细, then a project in the 归入项目 panel, then 报销事由, then 确认项目归属.
- `/#/task/<id>/review`: 确认整单明细, then the region 整单确认 with 去打印 and 去报销.

## Driving it with verify.sh

Preconditions: a task past 盘点 with its 住宿 gap answered. No scenario ships yet. Write one starting from
`v.signIn()` plus the first half of `v.confirmedTask()`, or drive `new-task-upload` first.

- **Book.** Fill `getByLabel('项目号')` with P-2307 and `getByLabel('项目名称')` with 华东客户交付, then click 加入项目.
  `getByTestId('book-message')` contains 已加入个人项目簿.
- **Assign.** Click 项目录完了，开始归属. Click the label after the checkbox 全选当前明细, then in
  `getByRole('complementary', { name: '归入项目' })` the button matching P-2307. `getByTestId('project-of-1')`
  shows `P-2307 / 华东客户交付`.
- **Purpose.** Fill `getByLabel('报销事由', { exact: true })`. Blank or spaces show 请填写报销事由，不能只输入空格。.
  Click 确认项目归属 and the URL ends `/review`.
- **Confirm.** Click `getByRole('button', { name: '确认整单明细', exact: true })`.
  `getByRole('region', { name: '整单确认' })` shows 去打印 and 去报销.
- **Proof.** The snapshot reads `stage: 'actions'`, `step.kind: 'choose_action'` and
  `projectAssignment.purpose`.

## Gotchas

- The checkbox 全选当前明细 is visually hidden: click its label (`locator('xpath=following-sibling::label[1]')`), as
  `web/e2e/server/project.spec.ts` does.
- P-2307 and P-3312 exist only in the fixture catalog. Against the real ERP, 报销信息核对 refuses them.
