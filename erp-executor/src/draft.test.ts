// 暂存 (ADR-0029, ADR-0037): every fill ends with the bill 暂存'd, found again by baox's ownership marker and read back
// by its 内码; there is no plan without `draft`. And the boundary that keeps it the only ERP command of its kind the
// executor presses.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { compareDraft } from './draft';
import { runFillJob } from './job';
import { createFakeErp, type FakeErp, type FakeErpOptions } from './testing/fake-erp';
import { blobSource, FAST_PACE, fakeErpOptions, fillPlan } from './testing/scenario';
import { stubServer, type StubServer } from './testing/stub-server';

const taskId = 'task-draft';
const MARK = 'baox-k3m9q2x7v1';
let server: StubServer;
beforeEach(() => { server = stubServer({ taskId }); });

const drafting = async (options: Partial<FakeErpOptions> = {}) => {
  const fake = await createFakeErp(fakeErpOptions({ assumeReceiptLink: true, ...options }));
  const result = await runFillJob({ ...fillPlan(taskId), draft: { mark: MARK } }, { browser: fake.browser, blobs: blobSource(), channel: server.channel, pace: FAST_PACE, probeWaitMs: 0 });
  return { fake, result };
};
const causa = (fake: FakeErp) => String((fake.document.querySelector('[id$="-FCAUSA-EDITOR"]') as { value?: string } | null)?.value ?? '');
const tab = (fake: FakeErp) => String(fake.document.querySelector('.form-tab')?.textContent ?? '');

describe('暂存 on the unattended path', () => {
  it('writes the marker after the purpose, presses 暂存 after a durable save attempt, and ends with the draft found by it', async () => {
    const { fake, result } = await drafting();
    expect(result, JSON.stringify(result)).toMatchObject({ type: 'result', status: 'drafted', code: null, billNo: null, draftId: '119946' });
    expect(server.attempts.map((a) => a.action)).toEqual(['import', 'fill', 'save']);
    expect(server.attempts[2]!.preconditions).toMatchObject({ formMode: 'new', billNo: null });
    expect(causa(fake)).toMatch(new RegExp(` ${MARK}$`));
    expect(tab(fake)).toBe('费用报销单 - 修改');
    expect(fake.mutations.filter((m) => m.kind === 'draft')).toEqual([{ kind: 'draft', detail: '119946' }]);
    expect(fake.mutations.some((m) => m.kind === 'save')).toBe(false);
  });

  // 去报销进度 (#420): 暂存 and the check of the draft it left (核对暂存单) are two steps the page counts and names.
  const stepTrail = () => server.events.flatMap((e) => (e.type === 'step' ? [`${e.step}:${e.status}`] : []));
  it('reports 暂存 and 核对暂存单 as their own steps, after the hand-over read-back', async () => {
    await drafting();
    const steps = stepTrail();
    expect(steps.slice(steps.indexOf('handover:done'))).toEqual(['handover:done', 'save:running', 'save:done', 'draft_check:running', 'draft_check:done']);
  });

  it('fails 核对暂存单, not 暂存, when the press landed and the lookup by the marker does not settle it', async () => {
    await drafting({ draftMarkTaken: true });
    expect(stepTrail().slice(-3)).toEqual(['save:done', 'draft_check:running', 'draft_check:failed']);
  });

  it('refuses a plan without a draft before it touches ERP: nothing hands over an unsaved form any more', async () => {
    const fake = await createFakeErp(fakeErpOptions({ assumeReceiptLink: true }));
    const { draft: _draft, ...unsaved } = fillPlan(taskId);
    await expect(runFillJob(unsaved, { browser: fake.browser, blobs: blobSource(), channel: server.channel, pace: FAST_PACE, probeWaitMs: 0 })).rejects.toThrow(/draft/);
    expect(server.events).toEqual([]);
    expect(fake.commands.filter((c) => c.method.startsWith('Input.'))).toEqual([]);
  });

  it('says it does not know, rather than aborting, when 暂存 lands nothing', async () => {
    const { result } = await drafting({ draftCommandDead: true });
    expect(result).toMatchObject({ status: 'unknown', code: 'draft_not_observed' });
    expect(server.attempts.map((a) => a.action)).toEqual(['import', 'fill', 'save']);
  });

  it('refuses to call a draft its own when the marker finds two', async () => {
    const { result } = await drafting({ draftMarkTaken: true });
    expect(result).toMatchObject({ status: 'unknown', code: 'draft_not_unique' });
    expect(result.draftId ?? null).toBeNull();
  });

  it('reads what ERP stored, not what was typed, and names the 内码 when they differ', async () => {
    const { result } = await drafting({ draftStoresCausa: `被截断的事由 ${MARK}` });
    expect(result).toMatchObject({ status: 'unknown', code: 'draft_readback_mismatch', draftId: '119946' });
    expect(result.message).toContain('事由与写入的不一致');
  });
});

describe('the draft read back against the page', () => {
  const model = { DocumentStatus: 'Z', BillNo: ' ', Causa: `出差 ${MARK}`,
    RecInvInfo: [{ FInvoiceNo: '26427000000640558021', FTotalAmount: 703, FInvoiceStatus: 'A' }],
    ER_ExpenseReimbEntry: [{ FExpID: { Id: 7, Number: 'FY010003', Name: [{ Key: 2052, Value: '长途交通' }] }, FExpenseAmount: 644.95 }] };
  const expected = (receipt: Record<string, string>, detail: Record<string, string>) => ({ causa: `出差 ${MARK}`, receipts: [{ values: receipt }], details: [{ values: detail }] });

  it('finds a name four levels down and money to the cent, and leaves display-only captions to the page read-back', () => {
    expect(compareDraft(model, expected({ 发票号码: '26427000000640558021', 价税合计: '703.00', 发票状态: '正常' }, { 费用项目: '长途交通', 费用金额: '644.95', 发票类型: '普通发票' }))).toEqual([]);
  });

  it('names the column, never the value, when a compared cell is not in the model', () => {
    expect(compareDraft(model, expected({ 发票号码: '99999999999999999999' }, {}))).toEqual(['收票分录第 1 行：发票号码 在 View 里找不到']);
  });

  // Live 2026-10-16 (内码 119984): a filled detail row shows its money as ¥531.13, the View holds 531.13.
  it('reads money the page shows with a ¥ the way the View holds it', () => {
    const line = (net: number, tax: number, gross: number) => ({ ExpID: { Id: 9, Number: 'FY009001', Name: [{ Key: 2052, Value: '招待' }] },
      ExpenseAmount: gross, TaxAmt: tax, LOCNOTAXAMOUNT: net, RequestAmount: gross, ReqSubmitAmount: gross });
    const two = { ...model, ER_ExpenseReimbEntry: [line(531.13, 31.87, 563), line(548.11, 32.89, 581)] };
    const cells = (net: string, tax: string, gross: string) => ({ values: { 费用项目: '招待', 费用金额: net, 税额: tax, 申请报销金额: gross, 申请付款金额: gross } });
    const page = { causa: `出差 ${MARK}`, receipts: [{ values: { 发票号码: '26427000000640558021' } }], details: [cells('¥531.13', '¥31.87', '¥563.00'), cells('￥548.11', '￥32.89', '￥581.00')] };
    expect(compareDraft(two, page)).toEqual([]);
    const wrong = { ...page, details: [cells('¥530.13', '¥31.87', '¥563.00'), page.details[1]!] };
    expect(compareDraft(two, wrong)).toEqual(['费用明细第 1 行：费用金额 在 View 里找不到']);
  });
});

describe('the 暂存 boundary', () => {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const sources = readdirSync(here, { recursive: true, encoding: 'utf8' })
    // `__lint_probe_*` files are lint-boundary.test.ts's own, written and deleted while this runs.
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.startsWith('testing') && !name.startsWith('recording') && !name.startsWith('__'));
  const naming = (pattern: RegExp) => sources.filter((name) => pattern.test(readFileSync(join(here, name), 'utf8')));

  it('is crossed in one module: only draft.ts names the 暂存 command', () => {
    expect(naming(/tbSaveTemp/)).toEqual(['draft.ts']);
  });

  it('is the only one: no module names 保存, 提交, 审核 or 删除 as a command or a WebAPI write', () => {
    expect(naming(/\btbSave\b|tbSplitSubmit|tbSplitApprove|tbDelete|DynamicFormService\.(Save|Draft|Submit|Audit|Delete)\b/)).toEqual([]);
  });
});
