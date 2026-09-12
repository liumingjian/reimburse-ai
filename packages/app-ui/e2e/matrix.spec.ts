import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { STAGE_DEFAULT_PAGE, TASK_PAGES, TASK_STAGES, pageAllowed, type TaskPage, type TaskStage } from '../src/contract/stage';
import { FAULTS, type Fault } from '../src/mock/options';
import { PAGE_COPY } from '../src/pages/page-copy';

// 全矩阵（#107）：每个 seed（阶段枚举 + assign / print 别名）× 每个任务页面、每个 fault × 每个 seed 的默认页、每个 fault 的场景。
// 每个用例断言关键可见文字，且页面里没有 undefined / NaN / [object / 长短破折号；截图作为产物存进 test-results/（不是基线）。
const INDEX = new URL('../dist-mock/index.html', import.meta.url).href;
const open = (query: string, hash: string) => `${INDEX}${query}${hash}`;

type Seed = { seed: string; stage: TaskStage; page: TaskPage; key: string };

// 各 seed 默认页上一定出现的文字。
const KEY_TEXT: Readonly<Record<TaskStage, string>> = {
  upload: '选择文件',
  inventory: '盘点版本 v1',
  pending: '还剩 3 个',
  review: '我已核对整单明细',
  actions: '整单明细已确认',
  project: '已归属 2 / 9 条',
  erp: '开始填报',
  done: 'BX20260911-0173',
  reconcile: '中止原因',
};

const SEEDS: readonly Seed[] = [
  ...TASK_STAGES.map((stage) => ({ seed: stage, stage, page: STAGE_DEFAULT_PAGE[stage], key: KEY_TEXT[stage] })),
  { seed: 'assign', stage: 'project', page: 'project', key: KEY_TEXT.project },
  { seed: 'print', stage: 'actions', page: 'print', key: 'No.3-5 · 08-10 · 外地市内交通 · 69.19' },
];

// 最后两个是 em-dash U+2014 与 en-dash U+2013。
const FORBIDDEN = ['undefined', 'NaN', '[object', String.fromCharCode(0x2014), String.fromCharCode(0x2013)];

const BANNER = '本地服务未运行，请在终端重新执行 baox';

function expectedHeading(stage: TaskStage, page: TaskPage): string {
  if (pageAllowed(stage, page)) return PAGE_COPY[page].title;
  // seed=upload 的 T1 还没有任何材料；其余阶段有材料但还没到这一步。
  return stage === 'upload' ? '还没有上传材料' : '还不能进入这一步';
}

async function expectClean(page: Page, label: string) {
  const text = await page.locator('body').innerText();
  for (const forbidden of FORBIDDEN) expect(text, `${label} 含 ${forbidden}`).not.toContain(forbidden);
}

async function shot(page: Page, testInfo: TestInfo) {
  await page.screenshot({ path: testInfo.outputPath('page.png'), fullPage: true });
}

const pdf = (name: string) => ({ name, mimeType: 'application/pdf', buffer: Buffer.from(`%PDF-1.4 ${name}`) });

async function startErp(page: Page, fault: Fault) {
  await page.goto(open(`?seed=erp&fault=${fault}`, '#/task/T1/erp'));
  await page.getByRole('button', { name: '开始填报' }).click();
  await page.getByRole('button', { name: '我已登录，继续' }).click();
}

// 每个 fault 的典型场景与它应当显示的内容。
const FAULT_SCENARIOS: Readonly<Record<Fault, (page: Page) => Promise<void>>> = {
  'duplicate-upload': async (page) => {
    await page.goto(open('?fault=duplicate-upload', '#/task/T1/upload'));
    await page.locator('input[type=file]').setInputFiles([pdf('铁路电子客票_0809.pdf')]);
    await expect(page.getByRole('heading', { name: /^上传批次 #1 / })).toBeVisible();
    await page.getByRole('button', { name: '追加下一批' }).click();
    await page.locator('input[type=file]').setInputFiles([pdf('铁路电子客票_0822.pdf'), pdf('餐饮_发票.pdf')]);
    await expect(page.getByText(/^内容重复/)).toBeVisible();
    await expect(page.getByRole('heading', { name: '上传批次 #2 · 1 份材料' })).toBeVisible();
  },
  'unsupported-material': async (page) => {
    await page.goto(open('?seed=pending&fault=unsupported-material', '#/task/T1/pending'));
    await expect(page.getByText('还剩 4 个')).toBeVisible();
    await expect(page.getByLabel('待确认项清单').getByRole('button', { name: /曹操出行_行程单\.pdf/ })).toBeVisible();
  },
  'erp-login-missing': async (page) => {
    await startErp(page, 'erp-login-missing');
    await expect(page.getByText(/还没有检测到登录（第 1 次检测）/)).toBeVisible();
    await expect(page.getByRole('button', { name: '我已登录，继续' })).toBeEnabled();
  },
  'erp-write-aborted': async (page) => {
    await startErp(page, 'erp-write-aborted');
    await expect(page.getByText(/ERP 填报已停止/)).toBeVisible();
    await expect(page.getByRole('link', { name: '进入对账' })).toBeVisible();
  },
  'readback-mismatch': async (page) => {
    await startErp(page, 'readback-mismatch');
    await page.getByRole('link', { name: '进入对账' }).click();
    await expect(page.getByTestId('readback-8')).toHaveClass(/row-err/);
    await expect(page.getByTestId('readback-8')).toContainText('74.00');
  },
  'service-disconnected': async (page) => {
    await page.goto(open('?fault=service-disconnected', '#/task/T1/upload'));
    const banner = page.getByRole('alert').filter({ hasText: BANNER });
    await expect(banner).toBeVisible();
    await expect(banner).toHaveCount(0, { timeout: 10_000 });
  },
};

test.describe('seed × 页面', () => {
  for (const seed of SEEDS) {
    for (const taskPage of TASK_PAGES) {
      test(`?seed=${seed.seed} #/task/T1/${taskPage}`, async ({ page }, testInfo) => {
        await page.goto(open(`?seed=${seed.seed}`, `#/task/T1/${taskPage}`));
        await expect(page.getByRole('heading', { level: 1 })).toHaveText(expectedHeading(seed.stage, taskPage));
        if (taskPage === seed.page) await expect(page.getByText(seed.key).first()).toBeVisible();
        await expectClean(page, `${seed.seed}/${taskPage}`);
        await shot(page, testInfo);
      });
    }
  }
});

test.describe('fault × seed 默认页', () => {
  for (const fault of FAULTS) {
    for (const seed of SEEDS) {
      test(`?seed=${seed.seed}&fault=${fault} #/task/T1/${seed.page}`, async ({ page }, testInfo) => {
        await page.goto(open(`?seed=${seed.seed}&fault=${fault}`, `#/task/T1/${seed.page}`));
        await expect(page.getByRole('heading', { level: 1 })).toHaveText(PAGE_COPY[seed.page].title);
        await expectClean(page, `${seed.seed}/${fault}`);
        await shot(page, testInfo);
      });
    }
  }
});

test.describe('fault 场景', () => {
  for (const fault of FAULTS) {
    test(`?fault=${fault}`, async ({ page }, testInfo) => {
      await FAULT_SCENARIOS[fault](page);
      await expectClean(page, fault);
      await shot(page, testInfo);
    });
  }
});
