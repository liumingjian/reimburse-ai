# New task, upload and 盘点

An employee creates a 报销任务 with a 常驻城市, uploads invoices and supporting materials in batches, and starts 材料盘点.
The app recognises each material and summarises what passed and what needs handling.

## Sub-features

- `create` opens 新建报销任务 and lands on the task's upload page.
- `upload` lists each file in 上传批次 #N, with duplicates and unsupported types flagged.
- `inventory` runs 材料盘点 and shows 盘点摘要 with counts.
- `stay-trio` raises 待确认项 when a 住宿 invoice lacks its 结账单 or 支付截图.

## How to get to it (user POV)

- `/#/tasks`, then the button 新建报销任务, a dialog, the field 常驻城市, then 创建并上传材料.
- On `/#/task/<id>/upload`: the file field labelled 拖入文件，或点击选择, or a folder dropped on `getByTestId('dropzone')`.
- 开始材料盘点 on the same page; 追加下一批 for another batch.

## Driving it with verify.sh

Preconditions: a fresh run. No ERP double is needed. `fixtures/generated/m01-hotel-invoice.pdf` and
`m02-hotel-folio.pdf` are committed.

- **Run it.** `rexec --background --timeout 1500 '.claude/skills/verify/verify.sh run new-task-upload'`.
- **Create.** Click `getByRole('button', { name: '新建报销任务' })`. In `getByRole('dialog', { name: '新建报销任务' })`
  fill 常驻城市 and click 创建并上传材料. The URL ends `/#/task/<id>/upload`.
- **Upload.** Call `setInputFiles([v.fixture('m01-hotel-invoice.pdf'), v.fixture('m02-hotel-folio.pdf')])` on the
  file field. The section headed 上传批次 #1 lists both file names.
- **Inventory.** Click 开始材料盘点. `getByRole('group', { name: '盘点摘要' })` appears within about 90 s.
- **Proof.** Snapshot `inventory.status === 'done'` and `lines.length > 0`, plus screenshots `uploaded` and
  `inventory`. With m01+m02 the 支付截图 is still missing, so 盘点摘要 says 需处理. That is expected.

## Gotchas

- Recognition is the real OCR. The first 盘点 after a build is the slowest, so allow 90 s.
- The upload list shows the file's own name (`m01-hotel-invoice.pdf`), not the business name in
  `fixtures/sample-materials.json`, unless the upload names it otherwise.
- Answering the 住宿 gap (确认没有) is in `v.confirmedTask()`; the page path is the 待确认 list (`web/e2e/server/hotel.spec.ts`).
