import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { STAGE_DEFAULT_PAGE, TASK_PAGES, pageAllowed, type TaskPage, type TaskStage } from '@baox/contract';
import { FAULTS, SEED_STAGES, type Fault, type SeedStage } from '../src/mock/options';
import { PAGE_COPY } from '../src/pages/page-copy';

// 全矩阵（#107）：每个 seed（可作 seed 的阶段 + assign / print 别名）× 每个任务页面、每个 fault × 每个 seed 的默认页、每个 fault 的场景。
// 每个用例断言关键可见文字，且页面里没有 undefined / NaN / [object / 长短破折号；截图作为产物存进 test-results/（不是基线）。
const INDEX = new URL('../dist-mock/index.html', import.meta.url).href;
const open = (query: string, hash: string) => `${INDEX}${query}${hash}`;

type Seed = { seed: string; stage: TaskStage; page: TaskPage; key: string };

// 各 seed 默认页上一定出现的文字。
// The server never projects the catalog / preparation stages, so they are no seeds (SEED_STAGES).
const KEY_TEXT: Readonly<Record<SeedStage, string>> = {
  upload: '把材料拖到这里',
  inventory: '盘点版本',
  pending: '还剩 4 个',
  // 吸底栏用字段组：标签「已归属」与值分开，这里认值。
  project: '2 / 9 条',
  review: '确认后即可去打印、去报销',
  actions: '整单明细已确认',
  erp: '我已登录，继续',
  done: '尚无',
  reconcile: '写入结果不确定',
  // A voided T1 has no materials yet; its only page is upload.
  voided: '把材料拖到这里',
};

const SEEDS: readonly Seed[] = [
  ...SEED_STAGES.map((stage) => ({ seed: stage, stage, page: STAGE_DEFAULT_PAGE[stage], key: KEY_TEXT[stage] })),
  { seed: 'assign', stage: 'project', page: 'project', key: KEY_TEXT.project },
  { seed: 'print', stage: 'actions', page: 'print', key: 'No.1-3 · 08-10 · 外地市内交通 · 69.19' },
];

// 最后两个是 em-dash U+2014 与 en-dash U+2013。
const FORBIDDEN = ['undefined', 'NaN', '[object', String.fromCharCode(0x2014), String.fromCharCode(0x2013)];

const BANNER = '连不上报销服务，请检查网络后重试；如果一直这样，请联系维护者';

function expectedHeading(stage: TaskStage, page: TaskPage): string {
  // A seed's admitted actions never open a page its stage keeps closed, so the stage alone decides here.
  if (pageAllowed({ stage, allowedActions: [] }, page)) return PAGE_COPY[page].title;
  // seed=upload 的 T1 还没有任何材料；其余阶段有材料但还没到这一步。
  // A voided T1 also has no materials.
  return stage === 'upload' || stage === 'voided' ? '还没有上传材料' : '还不能进入这一步';
}

async function expectClean(page: Page, label: string) {
  const text = await page.locator('body').innerText();
  for (const forbidden of FORBIDDEN) expect(text, `${label} 含 ${forbidden}`).not.toContain(forbidden);
}

async function shot(page: Page, testInfo: TestInfo) {
  await page.screenshot({ path: testInfo.outputPath('page.png'), fullPage: true });
}

const pdf = (name: string) => ({ name, mimeType: 'application/pdf', buffer: Buffer.from(`%PDF-1.4 ${name}`) });

// The ERP seed is waiting for the employee to log in to the task's ERP tab.
async function startErp(page: Page, fault: Fault) {
  await page.goto(open(`?seed=erp&fault=${fault}`, '#/task/T1/erp'));
  await page.getByRole('button', { name: '我已登录，继续' }).click();
}

// 每个 fault 的典型场景与它应当显示的内容。
const FAULT_SCENARIOS: Readonly<Record<Fault, (page: Page) => Promise<void>>> = {
  'duplicate-upload': async (page) => {
    await page.goto(open('?fault=duplicate-upload', '#/task/T1/upload'));
    await page.getByLabel('拖入文件，或点击选择', { exact: true }).setInputFiles([pdf('铁路电子客票_0809.pdf')]);
    await expect(page.getByRole('heading', { name: /^上传批次 #1$/ })).toBeVisible();
    await page.getByRole('button', { name: '追加下一批' }).click();
    await page.getByLabel('拖入文件，或点击选择', { exact: true }).setInputFiles([pdf('铁路电子客票_0822.pdf'), pdf('办公用品_发票.pdf')]);
    await expect(page.getByText(/^内容重复/)).toBeVisible();
    await expect(page.getByRole('heading', { name: '上传批次 #2' })).toBeVisible();
  },
  'unsupported-material': async (page) => {
    await page.goto(open('?seed=pending&fault=unsupported-material', '#/task/T1/pending'));
    await expect(page.getByText('还剩 5 个')).toBeVisible();
    await expect(page.getByLabel('待确认项清单').getByRole('button', { name: /曹操出行_行程单\.pdf/ })).toBeVisible();
  },
  'erp-login-missing': async (page) => {
    await startErp(page, 'erp-login-missing');
    await expect(page.getByText(/还没有检测到登录（第 1 次检测）/)).toBeVisible();
    await expect(page.getByRole('button', { name: '我已登录，继续' })).toBeEnabled();
  },
  // The catalog is checked inside the ERP job: a renamed project stops it before anything is imported, and the task
  // is back at project assignment (项目归属) with the problem shown.
  'catalog-mismatch': async (page) => {
    await startErp(page, 'catalog-mismatch');
    await page.getByRole('link', { name: '回到当前阶段' }).click();
    await expect(page).toHaveURL(/#\/task\/T1\/project$/);
    await expect(page.getByRole('alert').filter({ hasText: '改过名的项目' })).toBeVisible();
  },
  'erp-write-aborted': async (page) => {
    await startErp(page, 'erp-write-aborted');
    await expect(page).toHaveURL(/#\/task\/T1\/reconcile$/);
    await expect(page.getByRole('region', { name: '中止原因' })).toContainText('保存后没有读到报销系统的结果');
  },
  // 写入前就停下：阶段退回 actions，填报页当场关上，守卫页说出原因；回到整单确认页可以直接再去报销。
  'erp-stopped-before-write': async (page) => {
    await startErp(page, 'erp-stopped-before-write');
    await expect(page.getByRole('heading', { name: '这次去报销停下了' })).toBeVisible();
    await page.getByRole('link', { name: '回到当前阶段' }).click();
    await expect(page).toHaveURL(/#\/task\/T1\/review$/);
    await expect(page.getByTestId('erp-abort-reason')).toContainText('报销系统的版本与上次核对时不一致');
    await expect(page.getByRole('button', { name: '去报销', exact: true })).toBeEnabled();
  },
  'readback-mismatch': async (page) => {
    await startErp(page, 'readback-mismatch');
    // 严格回读停下 ⇒ 停在对账；开始对账读到已保存但逐行不一致的草稿 ⇒ 只能转人工。
    await expect(page).toHaveURL(/#\/task\/T1\/reconcile$/);
    await page.getByRole('button', { name: '开始对账' }).click();
    await expect(page.getByTestId('readback-6')).toContainText('不一致');
    await expect(page.getByTestId('readback-6')).toContainText('74.00');
    await expect(page.getByRole('button', { name: '转人工' })).toBeVisible();
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
