// The executor against pages recorded from the live ERP (`probe <flow> --record <name>`, recording/flows.ts), not
// against the hand-written fixtures: the login fingerprint, the menu path to a new 费用报销单, the compatibility
// fingerprint of the form it opens, the 费用明细 grid and its 发票类型 list, the readings the strict read-back works
// on, and the 发票无忧助手 (invoice assistant) up to its empty upload view.
//
// Where a hand-written fixture assumption is backed by a recording, the same executor read runs on both and the test
// says so; that is what lets the fixture drop its `@unverified` marker (unverified.test.ts).

import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { clickAt, evalIn } from './cdp';
import { leaveEdit, readGridByColumn, sectionAnchors, selectOption, type Grid } from './erpform';
import { headerFieldSnippet, type HeaderField } from './header-locator';
import { readPanes, recognisedTotal } from './invoice-grid';
import { COMPATIBILITY_SNIPPET, probeIdentity } from './probe';
import { structuralAttribute } from './recording/redact';
import { DETAIL_COLUMN, RECEIPTS_COLUMN, protocolReadings, readForm } from './reader';
import { addDetailRow, openInvoiceAssistant, openNewReimbursement, openUploadView, type WritePage } from './steps';
import { tabActions } from './tabs';
import { createFakeErp, fixture, type FakeErp } from './testing/fake-erp';
import { loadRecording, recordingNames } from './testing/recordings';
import { COMPATIBILITY, ERP_ACCOUNT, ERP_ORIGIN, FAST_PACE, fakeErpOptions } from './testing/scenario';

const recorded = (recording: string, loggedIn = true) => createFakeErp({ recording, loggedIn, account: ERP_ACCOUNT, invoices: [], projects: [], expenseItems: [] });
const handWritten = () => createFakeErp(fakeErpOptions());
const probe = (erp: FakeErp) => probeIdentity({
  origin: ERP_ORIGIN, waitMs: 1000, pollMs: 1, transport: 'chromium-cdp',
  listTabs: () => erp.browser.listPages(), evaluate: (_page, expression) => evalIn(erp.session, expression),
});
const page = (erp: FakeErp): WritePage => ({ session: erp.session, pace: FAST_PACE });
const newForm = async (erp: FakeErp) => {
  await openNewReimbursement(page(erp));
  return erp;
};
const labels = (grid: Grid) => (grid.ok ? grid.columns.map((column) => column.label) : []);
const dataRows = (grid: Grid) => (grid.ok ? grid.rows.filter((row) => row.kind === 'data') : []);
const kinds = (grid: Grid) => (grid.ok ? [...new Set(grid.rows.map((row) => row.kind))].sort() : []);
/** How many visible nodes whose own text is exactly `text`, in this document. */
const ownText = (text: string) => `(() => {
  const vis = (n) => { const b = n.getBoundingClientRect(); return b.width > 0 && b.height > 0 && getComputedStyle(n).display !== 'none'; };
  const own = (n) => [...n.childNodes].filter((c) => c.nodeType === 3).map((c) => c.textContent.trim()).join('').trim();
  return [...document.querySelectorAll('body *')].filter((n) => vis(n) && own(n) === ${JSON.stringify(text)}).length;
})()`;

describe('the fake ERP replaying the live new-form recording', () => {
  it('reads the recorded console as a logged-in identity, the fake account filled into the placeholders', async () => {
    const result = await probe(await recorded('new-form'));
    expect(result.status).toBe('matched');
    expect(result.identity).toEqual(ERP_ACCOUNT);
  });

  it('reads the recorded login page as not logged in', async () => {
    const result = await probe(await recorded('new-form', false));
    expect(result.status).toBe('not_logged_in');
  });

  // The whole recorded path, replayed: 10 s alone on the Mac, 59-63 s inside the full suite (2026-10-21).
  it('opens a new 费用报销单 along the recorded path, and reads the fingerprint the hand-written fake assumes', async () => {
    const erp = await recorded('new-form');
    const { manifest } = loadRecording('new-form');
    expect(await openNewReimbursement(page(erp))).toEqual({ ok: true, form: '费用报销单-新增' });
    expect(erp.recordedPage).toBe('new-form');
    const fingerprint = await evalIn<{ erpBuild: string; formIds: string[] }>(erp.session, COMPATIBILITY_SNIPPET);
    // Build and form ids as the live run read them. `activePanels` is left out: live read 0 a moment before the page
    // was captured with 1, Kendo moving `k-state-active` onto the new form's panel late (probe.ts COMPATIBILITY_SNIPPET).
    const live = (manifest.result as { fingerprint: { erpBuild: string; formIds: string[] } }).fingerprint;
    expect({ erpBuild: fingerprint.erpBuild, formIds: fingerprint.formIds }).toEqual({ erpBuild: live.erpBuild, formIds: live.formIds });
    // scenario.ts COMPATIBILITY is what every hand-written test expects ERP to answer.
    expect({ erpBuild: fingerprint.erpBuild, formId: fingerprint.formIds[0] }).toEqual(COMPATIBILITY);
  }, 120_000);

  it('finds 事由 and 单据编号 on the recorded new form by the one header-field rule, both empty, as on the fixture', async () => {
    for (const erp of [await newForm(await recorded('new-form')), await newForm(await handWritten())]) {
      for (const key of ['FCAUSA', 'FBILLNO']) {
        const field = await evalIn<HeaderField>(erp.session, headerFieldSnippet(key));
        expect(field, key).toMatchObject({ ok: true, visibleInstances: 1, value: '' });
      }
    }
  });

  it('reads the section anchors the fixture has, and one 新增 form tab on the live tab strip', async () => {
    const anchorsOf = async (erp: FakeErp) => (await sectionAnchors(erp.session)).map((anchor) => anchor.label);
    const live = await newForm(await recorded('new-form'));
    expect(await anchorsOf(live)).toEqual(expect.arrayContaining(await anchorsOf(await newForm(await handWritten()))));
    // tabs.ts on the recorded strip (the fixture draws no strip; tabs.test.ts has its own).
    const tabs = (await tabActions(live.session).tabs()).filter((tab) => tab.isForm);
    expect(tabs.map(({ text, isNew }) => ({ text, isNew }))).toEqual([{ text: '费用报销单-新增', isNew: true }]);
  });

  it('publishes the build and the stored login where the fixture does', async () => {
    const read = (erp: FakeErp) => evalIn<{ resVer: string; login: string[] }>(erp.session,
      `({ resVer: window.KDResVer, login: Object.keys(JSON.parse(localStorage.getItem('k3cloudloginInfo'))) })`);
    const live = await read(await recorded('new-form'));
    const fake = await read(await handWritten());
    expect(fake.resVer).toBe(live.resVer);
    expect(live.login).toEqual(expect.arrayContaining(fake.login));
  });

  it('shows the console menu and the 保存 command the fixture has', async () => {
    const erp = await recorded('new-form');
    expect(await evalIn<number>(erp.session, `document.querySelectorAll('.kd_SystemMenu').length`)).toBe(1);
    await newForm(erp);
    expect(await evalIn<number>(erp.session, ownText('保存'))).toBeGreaterThanOrEqual(1);
  });

  it('stays on the recorded page when a click lands anywhere but where the live click did', async () => {
    const erp = await recorded('new-form');
    const elsewhere = await evalIn<{ x: number; y: number }>(erp.session, `(() => {
      const target = [...document.querySelectorAll('body *')].find((n) => !n.hasAttribute('data-rec-click') && !n.querySelector('[data-rec-click]') && !n.closest('[data-rec-click]') && n.getBoundingClientRect().width > 0);
      const b = target.getBoundingClientRect();
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    })()`);
    await clickAt(erp.session, elsewhere.x, elsewhere.y);
    expect(erp.recordedPage).toBe('page-1');
    // Nor on something that contains it and shows more than it does.
    const around = await evalIn<{ x: number; y: number }>(erp.session, `(() => {
      const mark = document.querySelector('[data-rec-click]');
      let n = mark.parentElement;
      while (n.textContent.trim() === mark.textContent.trim()) n = n.parentElement;
      const b = n.getBoundingClientRect();
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    })()`);
    await clickAt(erp.session, around.x, around.y);
    expect(erp.recordedPage).toBe('page-1');
  });
});

describe('the strict read-back on recorded forms', () => {
  it('reads the recorded new form as the fixture reads: one 新增, no 单据编号, an empty 费用明细行 and no 收票行', async () => {
    const readingsOf = async (erp: FakeErp) => {
      const readings = protocolReadings(await readForm(erp.session));
      return {
        formMode: readings.formMode, billNo: readings.billNo,
        detail: { ok: readings.detailGrid.ok, data: dataRows(readings.detailGrid).length },
        receipts: { ok: readings.receiptsGrid.ok, data: dataRows(readings.receiptsGrid).length },
      };
    };
    const live = await newForm(await recorded('new-form'));
    const readings = await readingsOf(live);
    expect(readings).toEqual({
      formMode: { readable: true, value: 'new' }, billNo: { readable: true, value: null },
      detail: { ok: true, data: 1 }, receipts: { ok: true, data: 0 },
    });
    expect(await readingsOf(await newForm(await handWritten()))).toEqual(readings);
    // Live, an empty grid's total row reads 0.00 / 0 and so is read as a row; the fixture's is blank and skipped.
    expect(kinds(await readGridByColumn(live.session, DETAIL_COLUMN))).toEqual(['data', 'total']);
    expect(kinds(await readGridByColumn(live.session, RECEIPTS_COLUMN))).toEqual(['total']);
  });

  it('finds every column the fill and the read-back key by on the live grids, and every column the fixture has', async () => {
    const live = await newForm(await recorded('new-form'));
    const fake = await newForm(await handWritten());
    const detail = labels(await readGridByColumn(live.session, DETAIL_COLUMN));
    const receipts = labels(await readGridByColumn(live.session, RECEIPTS_COLUMN));
    // draft-flow.ts (detail rows, matchReceiptRows) and server/src/erp/readback.ts.
    expect(detail).toEqual(expect.arrayContaining(['项目', '费用项目', '发票类型', '开始日期', '结束日期', '费用金额', '税额', '申请报销金额', '申请付款金额', '收票单号']));
    expect(receipts).toEqual(expect.arrayContaining(['收票单', '发票号码', '不含税金额', '税额', '价税合计']));
    // The fixture's 费用明细 grid is a subset of the live one, in its own order (columns align by label). Its
    // 收票信息 grid says 销方名称 where live says 销售方名称, which nothing reads; the goldens pin the fixture's.
    expect(detail).toEqual(expect.arrayContaining(labels(await readGridByColumn(fake.session, DETAIL_COLUMN))));
    expect(receipts).toEqual(expect.arrayContaining(labels(await readGridByColumn(fake.session, RECEIPTS_COLUMN)).filter((label) => label !== '销方名称')));
  });

  it('sets 发票类型 on the recorded row, offering the six types the fixture offers, and leaves edit (detail-row)', async () => {
    const erp = await newForm(await recorded('detail-row'));
    const picked = await selectOption(erp.session, { column: '发票类型', option: '普通发票', pace: FAST_PACE });
    expect(picked).toMatchObject({ ok: true, after: '普通发票', options: ['普通发票', '增值税发票', '机票', '火车票', '其他运输票', '其他'] });
    const fake = await newForm(await handWritten());
    await addDetailRow(page(fake));
    expect((await selectOption(fake.session, { column: '发票类型', option: '普通发票', pace: FAST_PACE })).options).toEqual(picked.options);
    // `leaveEdit` goes through the 明细信息 anchor, as the fill does before its final read-back.
    expect(await leaveEdit(erp.session, { pace: FAST_PACE })).toMatchObject({ ok: true, stillEditing: false });
    expect(erp.recordedPage).toBe('detail-row');
    const readings = protocolReadings(await readForm(erp.session));
    expect(readings.formMode).toEqual({ readable: true, value: 'new' });
    expect(dataRows(readings.detailGrid)).toMatchObject([{ editing: false, values: { 发票类型: '普通发票', 项目: '', 费用金额: '', 税额: '', 收票单号: '' } }]);
  });
});

describe('the 发票无忧助手 recording (invoice-assistant)', () => {
  it('opens the assistant through 不生成费用明细, the one mode of the three the split menu offers that the product uses', async () => {
    const erp = await newForm(await recorded('invoice-assistant'));
    const opened = await openInvoiceAssistant(page(erp));
    expect(opened).toMatchObject({ ok: true, mode: '不生成费用明细' });
    expect(opened.menuItemIds.map((id) => id.replace(/^.*ENTRYBAR-/, ''))).toEqual(['tbMergeFillEntry', 'tbMappingFillEntry', 'tbNotFillEntry']);
    expect(erp.recordedPage).toBe('page-6');
    expect(erp.assistantDocument?.location.href).toBe('https://www.piaozone.com/m4-web/fpzs/index');
    // The window the fixture draws: a .k-window titled 发票无忧助手 with the Close anchor closeInvoiceAssistant clicks.
    expect(await evalIn<number>(erp.session, ownText('发票无忧助手'))).toBe(1);
    expect(await evalIn<number>(erp.session, `[...document.querySelectorAll('a[aria-label="Close"]')].filter((n) => n.getBoundingClientRect().width > 0).length`)).toBe(1);
  });

  it('walks from the entry menu (电脑端选取) to an empty upload view with one file input and one 发票导入单据', async () => {
    const erp = await newForm(await recorded('invoice-assistant'));
    const writePage = page(erp);
    await openInvoiceAssistant(writePage);
    const assistant = await openUploadView(writePage);
    expect(erp.recordedPage).toBe('upload-view');
    expect(erp.assistantDocument?.location.href).toBe('https://www.piaozone.com/m4-web/fpzs/kdInvoices');
    expect(await recognisedTotal(assistant)).toBe(0);
    expect(await readPanes(assistant)).toEqual([]);
    expect(await evalIn<number>(assistant, ownText('发票导入单据'))).toBe(1);
  });

  it('shows the entry menu and the upload view the hand-written assistant fixture draws', () => {
    const { manifest, html } = loadRecording('invoice-assistant');
    const texts = (source: string) => new JSDOM(source).window.document.body.textContent ?? '';
    const [entry, upload] = manifest.pages.filter((p) => p.child).map((p) => texts(html(p.child!)));
    const hand = texts(fixture('piaozone-assistant.html'));
    for (const caption of ['电脑端选取', '手机端选取', '扫码枪扫描', '扫描仪扫描']) {
      expect(entry, caption).toContain(caption);
      expect(hand, caption).toContain(caption);
    }
    for (const caption of ['上传发票影像', '发票导入单据', '已选取']) {
      expect(upload, caption).toContain(caption);
      expect(hand, caption).toContain(caption);
    }
  });
});

describe('committed recordings', () => {
  // Structure keeps its digits (ids, spans, the live boxes); values do not. The ERP build is the one value kept.
  const structural = (name: string) => structuralAttribute(name) || name === 'data-rec-box';
  it.each(recordingNames())('%s holds no value digit and no fake identity', (name) => {
    const { manifest, html } = loadRecording(name);
    const files = [manifest.loggedOut, ...manifest.pages].flatMap((p) => (p.child ? [p, p.child] : [p]));
    for (const file of files) {
      const { document } = new JSDOM(html(file)).window;
      const values: string[] = [];
      const walker = document.createTreeWalker(document, 4 /* NodeFilter.SHOW_TEXT */);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) values.push(node.nodeValue ?? '');
      for (const el of document.querySelectorAll('*')) for (const attr of el.attributes) if (!structural(attr.name)) values.push(attr.value);
      const digits = values.filter((value) => /[1-9]/.test(value.replaceAll(manifest.erpBuild ?? '\0', '')));
      expect(digits, `${name}/${file.file}`).toEqual([]);
      expect(html(file)).not.toContain(ERP_ACCOUNT.displayName);
    }
    expect(readFileSync(new URL(`./testing/recordings/${name}/manifest.json`, import.meta.url), 'utf8')).not.toMatch(/password|BAOX_ERP_TEST/i);
  });
});
