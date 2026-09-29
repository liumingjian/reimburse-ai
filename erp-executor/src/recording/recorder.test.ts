// The recorder's two promises, on the hand-written fake ERP: it captures the page each click leaves, marking where the
// click landed, and it never lets a flow press save / submit / import, type, or upload. And redaction keeps structure
// while dropping values.

import { describe, expect, it } from 'vitest';
import { clickAt, evalIn, pressKey } from '../cdp';
import { openInvoiceAssistant, openNewReimbursement, openUploadView } from '../steps';
import { createFakeErp } from '../testing/fake-erp';
import { ERP_ACCOUNT, FAST_PACE } from '../testing/scenario';
import { CAPTURE_SNIPPET, CLICK_MARK, type CapturedNode, type CapturedPage } from './capture';
import { findLeaks, redactor } from './redact';
import { crossesBoundary, recordingSession } from './recorder';

const fake = () => createFakeErp({ account: ERP_ACCOUNT, invoices: [], projects: [], expenseItems: [] });
const centreOf = (selector: string) => `(() => { const b = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`;
const find = (node: CapturedNode, match: (n: CapturedNode) => boolean): CapturedNode | null => {
  if (match(node)) return node;
  for (const child of node.c) if (typeof child !== 'string') { const hit = find(child, match); if (hit) return hit; }
  return null;
};

describe('recordingSession', () => {
  it('captures the page before each click, with the clicked element marked, and leaves the page unmarked', async () => {
    const erp = await fake();
    const session = recordingSession(erp.session);
    const at = await evalIn<{ x: number; y: number }>(session, centreOf('[data-action="open-list"]'));
    await clickAt(session, at.x, at.y);
    expect(session.steps).toHaveLength(1);
    const [step] = session.steps;
    expect(step!.click).toMatchObject({ tag: 'span', text: '我的费用报销' });
    expect(find(step!.page.body, (n) => CLICK_MARK in n.a)?.c).toEqual(['我的费用报销']);
    expect(erp.document.querySelector(`[${CLICK_MARK}]`)).toBeNull();
    // The click itself still reached the page.
    expect(erp.document.querySelector('#expense-list').style.display).toBe('');
  });

  it('refuses a press on 保存 before it is sent, so ERP saves nothing', async () => {
    const erp = await fake();
    erp.document.querySelector('#expense-form').style.display = '';
    const session = recordingSession(erp.session);
    const at = await evalIn<{ x: number; y: number }>(session, centreOf('[data-action="save"]'));
    await expect(clickAt(session, at.x, at.y)).rejects.toMatchObject({ code: 'RECORDING_REFUSED' });
    expect(erp.mutations).toEqual([]);
    expect(erp.commands.filter((c) => c.method === 'Input.dispatchMouseEvent' && c.params['type'] === 'mousePressed')).toEqual([]);
  });

  it('refuses keys unless the flow declares it types, and uploads always', async () => {
    const erp = await fake();
    await expect(pressKey(recordingSession(erp.session), 'Enter')).rejects.toMatchObject({ code: 'RECORDING_REFUSED' });
    await expect(recordingSession(erp.session, { allowKeys: true }).send('DOM.setFileInputFiles', { files: [] })).rejects.toMatchObject({ code: 'RECORDING_REFUSED' });
  });

  it('captures the assistant frame with every page, marks a click inside it, and stops capturing on stop()', async () => {
    const erp = await fake();
    const session = recordingSession(erp.session);
    const page = { session, pace: FAST_PACE };
    await openNewReimbursement(page);
    await openInvoiceAssistant(page);
    const assistant = await openUploadView(page);
    await session.snapshot('upload-view');
    const inFrame = session.steps.filter((step) => step.click?.frame === 'child');
    expect(inFrame.length).toBeGreaterThan(0);
    expect(inFrame[0]!.child?.url).toBe('https://www.piaozone.com/pwy-assistant/index.html');
    expect(session.steps.at(-1)).toMatchObject({ name: 'upload-view', child: { title: '发票助手' } });
    expect(erp.assistantDocument?.querySelector(`[${CLICK_MARK}]`)).toBeNull();
    session.stop();
    const count = session.steps.length;
    const at = await evalIn<{ x: number; y: number }>(assistant, centreOf('.ant-tabs'));
    await clickAt(assistant, at.x, at.y);
    expect(session.steps).toHaveLength(count);
  });

  it('refuses 发票导入单据 inside the assistant frame, so nothing is imported', async () => {
    const erp = await fake();
    const session = recordingSession(erp.session);
    const page = { session, pace: FAST_PACE };
    await openNewReimbursement(page);
    await openInvoiceAssistant(page);
    const assistant = await openUploadView(page);
    const at = await evalIn<{ x: number; y: number }>(assistant, centreOf('[data-action="import"]'));
    await expect(clickAt(assistant, at.x, at.y)).rejects.toMatchObject({ code: 'RECORDING_REFUSED' });
    expect(erp.mutations).toEqual([]);
  });

  it.each([
    [{ tag: 'span', id: '', controlId: 'x-FRECINVINFO_ENTRYBAR-tbImportBill', text: '', controlText: '' }, true],
    [{ tag: 'span', id: '', controlId: '', text: '发票导入单据', controlText: '发票导入单据' }, true],
    [{ tag: 'a', id: 'x-BILLMENU_TOOLBAR-tbSubmit', controlId: 'x-BILLMENU_TOOLBAR-tbSubmit', text: '提交', controlText: '提交' }, true],
    [{ tag: 'span', id: '', controlId: 'li_x', text: '新增', controlText: '新增' }, false],
    // A container with an id reads as all its items; its text alone does not make a press a save.
    [{ tag: 'span', id: '', controlId: 'toolbar', text: '新增行', controlText: '新增行 删除行 复制行 保存 提交 审核 更多操作' }, false],
  ])('crossesBoundary(%j) is %s', (target, crosses) => {
    expect(crossesBoundary(target) !== null).toBe(crosses);
  });
});

describe('redactor', () => {
  const secrets = { displayName: '测试员', account: 'qa.tester', tenant: 'tenant-x', password: 'hunter22' };

  it('keeps structure and the build, swaps the identity for placeholders and drops every value', async () => {
    const erp = await createFakeErp({ account: { displayName: '测试员', account: 'qa.tester', tenant: 'tenant-x' }, invoices: [], projects: [], expenseItems: [], today: '2026/9/15' });
    erp.document.querySelector('[id$="-FCAUSA-EDITOR"]').value = '去北京 出差 3 天';
    erp.document.querySelector('#expense-form').style.display = '';
    const page = JSON.parse(await evalIn<string>(erp.session, CAPTURE_SNIPPET)) as CapturedPage;
    const { html, facts } = redactor({ secrets, keep: ['8.2.830.9'] }).page(page, 'header');
    expect(html).toContain('<span class="kd-mainconsole-usernametext"');
    expect(html).toContain('>{{DISPLAY_NAME}}</span>');
    expect(html).toContain('id="a1b2c3d4e5f6-FCAUSA-EDITOR"');
    expect(html).toMatch(/id="a1b2c3d4e5f6-FCAUSA-EDITOR" value="＊{8}"/);
    expect(html).toContain('>0000/0/00</td>');
    expect(html).not.toContain('去北京');
    expect(facts.resVer).toBe('?ver=8.2.830.9');
    expect(facts.loginInfo).toEqual({ user: '{{ACCOUNT}}', acc: '{{TENANT}}' });
    expect(findLeaks(html + JSON.stringify(facts), secrets)).toEqual([]);
  });

  it('prunes what display:none hides, keeping the element itself', async () => {
    const erp = await fake();
    const page = JSON.parse(await evalIn<string>(erp.session, CAPTURE_SNIPPET)) as CapturedPage;
    const hidden = find(page.body, (n) => n.a['id'] === 'expense-list')!;
    expect(hidden).toMatchObject({ s: 'display:none', c: [] });
    expect(page.pruned).toBeGreaterThan(0);
  });

  it('masks the value displays every K3Cloud page has', () => {
    const span = (a: Record<string, string>, text: string): CapturedNode => ({ t: 'span', a, b: [0, 0, 10, 10], c: [text] });
    const node: CapturedNode = { t: 'div', a: {}, b: [0, 0, 10, 10], c: [
      span({ class: 'ui-poplistedit-displayname', title: '某某部门' }, '某某部门'),
      span({ class: ' kd-grid-cellspan ', 'data-field': 'FEXPENSEDEPTENTRYID' }, '某某团队'),
      span({ class: ' kd-grid-cellspan ', 'data-field': 'F_BEGINDATE' }, '2026/9/29'),
      span({ class: ' kd-grid-cellspan ', 'data-field': 'FINVOICETYPE' }, '普通发票'),
    ] };
    const html = redactor({ secrets }).page({ url: '', title: '', readyState: 'complete', viewport: { width: 1, height: 1, devicePixelRatio: 1 }, resVer: null, loginInfo: null, body: node, frames: [], count: 5, pruned: 0 }, 'h').html;
    expect(html).not.toMatch(/某某部门|某某团队/);
    expect(html).toContain('>0000/0/00</span>');
    expect(html).toContain('>普通发票</span>');
  });

  it("masks a list form's bill rows, its saved filter schemes and the main menu's category titles", () => {
    const node = (t: string, a: Record<string, string>, ...c: Array<CapturedNode | string>): CapturedNode => ({ t, a, b: [0, 0, 10, 10], c });
    const body = node('div', {},
      node('div', { id: 'u-FLIST', class: 'kd-kdgrid-base' }, node('th', {}, '事由'), node('span', { 'data-field': 'FCAUSA', 'data-rowid': '3' }, '某人的差旅')),
      node('div', { class: 'SchemeItemControlTemplate' }, '报销打印(某人共享)'),
      node('ul', { class: 'kd-tabsnewsyle-list ', title: '某公司内部文档' }));
    const html = redactor({ secrets }).page({ url: '', title: '', readyState: 'complete', viewport: { width: 1, height: 1, devicePixelRatio: 1 }, resVer: null, loginInfo: null, body, frames: [], count: 5, pruned: 0 }, 'h').html;
    expect(html).not.toMatch(/某人|某公司/);
    expect(html).toContain('>事由</th>');
    // A masked node keeps the attributes selectors read, whole.
    expect(html).toContain('data-field="FCAUSA" data-rowid="3"');
  });

  it('masks the text of a click that landed under a mask rule, in the manifest as on the page', () => {
    const page = (text: string, a: Record<string, string>): CapturedPage => ({ url: '', title: '', readyState: 'complete', viewport: { width: 1, height: 1, devicePixelRatio: 1 }, resVer: null, loginInfo: null, count: 2, pruned: 0, frames: [],
      body: { t: 'div', a: { id: 'u-FLIST' }, b: [0, 0, 1, 1], c: [{ t: 'span', a: { [CLICK_MARK]: '', ...a }, b: [0, 0, 1, 1], c: [text] }] } });
    const target = { tag: 'span', id: '', controlId: 'u-FLIST', text: '某人的差旅 3 天', controlText: '' };
    expect(redactor({ secrets }).click(page(target.text, { 'data-rowid': '0' }), target).text).toBe('＊＊＊＊＊＊＊＊');
    expect(redactor({ secrets }).click(page(target.text, {}), target).text).toBe('某人的差旅 0 天');
  });

  it('names a leaked secret without repeating it', () => {
    expect(findLeaks('... Hunter22 ...', secrets)).toEqual(['password']);
  });
});
