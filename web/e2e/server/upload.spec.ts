import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { TaskSnapshotSchema } from '@baox/contract';
import { GENERATED_DIR, SAMPLE_MATERIALS } from '@baox/fixtures';
import { expect, signIn, test } from './fixture';

// Slice 01 (#179) walking skeleton on the real server: new task → upload one PDF → the material is listed.
const hotelInvoice = SAMPLE_MATERIALS.find((sample) => sample.file.startsWith('m01'));

type TransferHarness = {
  request: unknown | null;
  progress(loaded: number, total: number, lengthComputable: boolean): void;
  accepted(): void;
  confirm(): Promise<void>;
};
type TransferCommand = { loaded: number; total: number; lengthComputable: boolean } | 'accepted' | 'confirm';

async function installControlledUpload(page: Page) {
  await page.evaluate(() => {
    type UploadEvent = { loaded: number; total: number; lengthComputable: boolean };
    class ControlledRequest {
      method = '';
      target = '';
      responseType = '';
      status = 0;
      response: unknown = null;
      body: BodyInit | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      ontimeout: (() => void) | null = null;
      upload: {
        onprogress: ((event: UploadEvent) => void) | null;
        onload: (() => void) | null;
        onerror: (() => void) | null;
        onabort: (() => void) | null;
        ontimeout: (() => void) | null;
      } = { onprogress: null, onload: null, onerror: null, onabort: null, ontimeout: null };

      open(method: string, target: string) {
        this.method = method;
        this.target = target;
      }

      send(body: BodyInit) {
        this.body = body;
        harness.request = this;
      }
    }

    const harness: TransferHarness = {
      request: null,
      progress(loaded, total, lengthComputable) {
        const request = harness.request as ControlledRequest | null;
        if (!request) throw new Error('受控上传请求尚未开始');
        request.upload.onprogress?.({ loaded, total, lengthComputable });
      },
      accepted() {
        const request = harness.request as ControlledRequest | null;
        if (!request) throw new Error('受控上传请求尚未开始');
        request.upload.onload?.();
      },
      async confirm() {
        const request = harness.request as ControlledRequest | null;
        if (!request || !request.body) throw new Error('受控上传请求尚未开始');
        const response = await fetch(request.target, { method: request.method, body: request.body });
        request.status = response.status;
        request.response = await response.json().catch(() => null);
        request.onload?.();
        harness.request = null;
      },
    };
    (window as unknown as { __baoxUploadTransfer: TransferHarness }).__baoxUploadTransfer = harness;
    (window as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest = ControlledRequest;
  });
}

async function uploadHarness(page: Page, command: TransferCommand) {
  await expect.poll(() => page.evaluate(() => Boolean((window as unknown as { __baoxUploadTransfer?: TransferHarness }).__baoxUploadTransfer?.request))).toBe(true);
  await page.evaluate(async (current: TransferCommand) => {
    const harness = (window as unknown as { __baoxUploadTransfer?: TransferHarness }).__baoxUploadTransfer;
    if (!harness?.request) throw new Error('受控上传请求尚未开始');
    if (current === 'accepted') harness.accepted();
    else if (current === 'confirm') await harness.confirm();
    else harness.progress(current.loaded, current.total, current.lengthComputable);
  }, command);
}

test('新建报销任务、上传一份 PDF，材料列在上传批次里，刷新后仍在', async ({ page }) => {
  if (!hotelInvoice) throw new Error('fixture m01 is missing from @baox/fixtures');
  await signIn(page);
  await page.goto('/#/tasks');
  await page.getByRole('button', { name: '新建报销任务' }).click();
  const dialog = page.getByRole('dialog', { name: '新建报销任务' });
  await dialog.getByLabel('常驻城市').fill('杭州');
  await dialog.getByRole('button', { name: '创建并上传材料' }).click();
  await expect(page).toHaveURL(/#\/task\/[^/]+\/upload$/);

  await page.locator('input[type=file]').setInputFiles({
    name: hotelInvoice.fileName,
    mimeType: 'application/pdf',
    buffer: readFileSync(join(GENERATED_DIR, hotelInvoice.file)),
  });
  const batch = page.locator('section', { has: page.getByRole('heading', { name: /^上传批次 #1$/ }) });
  await expect(batch.getByText(hotelInvoice.fileName, { exact: true })).toBeVisible();

  // The material is a server fact, not page state.
  await page.reload();
  await expect(batch.getByText(hotelInvoice.fileName, { exact: true })).toBeVisible();
});

test('受控上传把已知字节、未知总量和服务端确认分开显示，刷新不会重传', async ({ page }) => {
  if (!hotelInvoice) throw new Error('fixture m01 is missing from @baox/fixtures');
  await signIn(page);
  await page.goto('/#/tasks');
  await page.getByRole('button', { name: '新建报销任务' }).click();
  const dialog = page.getByRole('dialog', { name: '新建报销任务' });
  await dialog.getByLabel('常驻城市').fill('杭州');
  await dialog.getByRole('button', { name: '创建并上传材料' }).click();
  await expect(page).toHaveURL(/#\/task\/[^/]+\/upload$/);
  await installControlledUpload(page);

  await page.getByLabel('拖入文件，或点击选择').setInputFiles({
    name: hotelInvoice.fileName,
    mimeType: 'application/pdf',
    buffer: readFileSync(join(GENERATED_DIR, hotelInvoice.file)),
  });
  await uploadHarness(page, { loaded: 2048, total: 8192, lengthComputable: true });
  await expect(page.getByRole('status')).toHaveText('正在传输 1 份文件：2 KB / 8 KB');
  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '2048');
  await uploadHarness(page, 'accepted');
  await expect(page.getByRole('status')).toHaveText('文件已传输，正在等待服务端确认接收结果…');
  await uploadHarness(page, 'confirm');

  const first = page.locator('section', { has: page.getByRole('heading', { name: '上传批次 #1' }) });
  await expect(first.getByText(hotelInvoice.fileName, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '开始材料盘点' })).toBeVisible();
  await page.getByRole('button', { name: '追加下一批' }).click();

  await page.getByLabel('拖入文件，或点击选择').setInputFiles({ name: 'unknown-total.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 unknown total') });
  await uploadHarness(page, { loaded: 2048, total: 0, lengthComputable: false });
  await expect(page.getByRole('status')).toHaveText('正在传输 1 份文件，暂时无法计算总进度…');
  await expect(page.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');
  await uploadHarness(page, 'accepted');
  await uploadHarness(page, 'confirm');

  const second = page.locator('section', { has: page.getByRole('heading', { name: '上传批次 #2' }) });
  await expect(second.getByText('unknown-total.pdf', { exact: true })).toBeVisible();
  await page.reload();
  await expect(first.getByText(hotelInvoice.fileName, { exact: true })).toBeVisible();
  await expect(second.getByText('unknown-total.pdf', { exact: true })).toBeVisible();
  await expect(page.locator('section', { has: page.getByRole('heading', { name: '上传批次 #3' }) })).toHaveCount(0);
});

test('目录上传保留嵌套来源路径，并把同内容副本与不支持文件逐项列出', async ({ page }) => {
  await signIn(page);
  await page.goto('/#/tasks');
  await page.getByRole('button', { name: '新建报销任务' }).click();
  const dialog = page.getByRole('dialog', { name: '新建报销任务' });
  await dialog.getByLabel('常驻城市').fill('杭州');
  await dialog.getByRole('button', { name: '创建并上传材料' }).click();
  await expect(page).toHaveURL(/#\/task\/[^/]+\/upload$/);

  await expect(page.locator('button').filter({ hasText: '选择文件夹' })).toBeVisible();
  await expect(page.locator('input[webkitdirectory]')).toHaveCount(1);
  const dataTransfer = await page.evaluateHandle(() => {
    const transfer = new DataTransfer();
    const files = [
      ['same.pdf', 'trip/receipts/same.pdf', '%PDF-1.4 invoice'],
      ['same.pdf', 'trip/notes/same.pdf', '%PDF-1.4 folio'],
      ['copy.pdf', 'trip/receipts/copy.pdf', '%PDF-1.4 invoice'],
      ['readme.txt', 'trip/notes/readme.txt', 'notes'],
    ] as const;
    for (const [name, relativePath, contents] of files) {
      const file = new File([contents], name, { type: name.endsWith('.pdf') ? 'application/pdf' : 'text/plain' });
      Object.defineProperty(file, 'webkitRelativePath', { value: relativePath });
      transfer.items.add(file);
    }
    return transfer;
  });
  await page.getByTestId('dropzone').dispatchEvent('drop', { dataTransfer });

  const batch = page.locator('section', { has: page.getByRole('heading', { name: /^上传批次 #1$/ }) });
  await expect(batch.getByText('trip/receipts/same.pdf', { exact: true })).toBeVisible();
  await expect(batch.getByText('trip/notes/same.pdf', { exact: true })).toBeVisible();
  await expect(batch.getByText('trip/receipts/copy.pdf', { exact: true })).toBeVisible();
  await expect(batch.getByText('trip/notes/readme.txt', { exact: true })).toBeVisible();
  await expect(batch.getByText(/内容重复/)).toBeVisible();
  await expect(batch.getByText('类型不支持，只接受 PDF、JPG、PNG')).toBeVisible();

  const taskId = /#\/task\/([^/]+)\//.exec(page.url())?.[1];
  if (!taskId) throw new Error('task id missing from upload URL');
  const snapshot = TaskSnapshotSchema.parse(await (await page.request.get(`/api/tasks/${taskId}`)).json());
  expect(snapshot.batches[0]?.files.map((file) => file.relativePath)).toEqual([
    'trip/receipts/same.pdf',
    'trip/notes/same.pdf',
    'trip/receipts/copy.pdf',
    'trip/notes/readme.txt',
  ]);
  expect(snapshot.materials.map((material) => material.relativePath)).toEqual(['trip/receipts/same.pdf', 'trip/notes/same.pdf']);
});
