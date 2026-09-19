// The fake ERP: a stateful fake CDP session over recorded DOM fixtures (./fixtures), after the kernel's
// 50931a3:kernel/test/fake-session.mjs. Every executor expression really runs against a jsdom document; clicks and keys
// arrive as CDP `Input.*` events at viewport coordinates and are turned into the behaviour the research recorded
// (docs/research/erp-expense-flow): edit-on-click cells, select-all + typing + Enter/Tab commit, F7 code -> name,
// the invoice-type dropdown, linked recalculation, the piaozone assistant as a child target, save -> 修改 mode.
//
// Layout: jsdom has none, so every visible element gets a unique 8x8 box on a 10px grid in DOCUMENT coordinates, in
// the order it is first measured. Hidden (display:none / visibility:hidden / [hidden]) elements measure 0x0.
// `data-below-fold` puts a box at an explicit document y instead, so a test can place a control past the bottom of
// the viewport. Rects are document y minus `scrollTop`, `scrollIntoView` centres the box, and a click outside the
// viewport hits nothing — which is what the real browser does, and what the invoice assistant broke on.
//
// `assumeReceiptLink` is an UNVERIFIED assumption, off by default: research says that in 不生成费用明细 mode ERP
// leaves the detail row's 收票单号 empty, while the strict read-back requires it. With the flag on, committing 税额
// links the row to the unique receipt with the same net and tax, so the save path can be exercised end to end.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import type { CdpListener, CdpSession } from '../cdp';
import type { ChromiumPage } from '../chromium';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

export type FakeInvoice = {
  bytes: Uint8Array; invoiceNumber: string; receiptNumber: string; seller: string; issueDate: string;
  net: string; tax: string; gross: string; category: string;
  /**
   * ERP's verbatim refusal for this invoice, or undefined for an invoice it accepts. `重复报销，禁止导入` is the one
   * the recovery path cannot fix: the invoice is bound to a 历史费用报销单 (a past reimbursement bill), not to the
   * unsaved one we abandoned, so nothing is imported and ERP says why in the 提示 window.
   */
  importRefusal?: string;
};

/**
 * The 收票单 (receipt records) ERP already holds, keyed by 收票单, with the row values it holds for each. ADR-0026:
 * a 收票单 outlives the bill that created it, and it outlives the page instance too, so a recovery run over a second
 * `createFakeErp` can be given the ledger the first one left behind. Sharing it is what makes re-import a re-import.
 */
export type FakeReceiptLedger = Map<string, string[]>;
export type FakeMasterData = { code: string; name: string; documentStatus?: string; forbidStatus?: string };
export type FakeErpOptions = {
  origin?: string;
  loggedIn?: boolean;
  account?: { displayName: string; account: string; tenant: string };
  erpBuild?: string;
  formId?: string;
  invoices: FakeInvoice[];
  projects: FakeMasterData[];
  expenseItems: FakeMasterData[];
  assumeReceiptLink?: boolean;
  today?: string;
  billNo?: string;
  /** The 收票单 ERP already holds. Defaults to an empty ledger: an ERP that has never seen these invoices. */
  receiptLedger?: FakeReceiptLedger;
  /** 电脑端选取 does nothing, so the assistant never leaves its entry menu and no upload is possible. */
  assistantStuckOnEntryMenu?: boolean;
  /**
   * The 不生成费用明细 menu item opens past the bottom of the viewport, where a real mouse event reaches nothing.
   * Live on 2026-09-19 the 收票信息 anchor had not finished scrolling, so the item landed at y=941 in a viewport
   * 908 high; the click was lost and the run died on INVOICE_ASSISTANT_NOT_FOUND 90s later.
   */
  notFillEntryBelowFold?: boolean;
  /** Clicking a 票种 tab does nothing: the pane never changes, so rows in the other 票种 stay out of reach. */
  assistantPaneSwitchDead?: boolean;
  /** 发票号码 whose checkbox refuses to toggle — a click that lands and still leaves the row unticked. */
  assistantDeadTickNumbers?: string[];
  /**
   * The 发票号码 whose tick point is painted over: `document.elementFromPoint` there answers the overlay `<img>`,
   * exactly as it did live on 2026-09-19 for the row sitting at the bottom edge of the 800x530 iframe viewport.
   */
  assistantCoveredTickNumbers?: string[];
  /**
   * Recognition of every upload batch after the first lands this many assistant evaluations later, and lands in
   * its own 票种 pane. The first batch's rows stay on screen throughout, so `rows.length > 0` is true the whole
   * time and cannot say whether the second batch has been recognised.
   */
  assistantRecognitionTicks?: number;
  /**
   * How many ERP-page evaluations after 新增 Kendo takes to move `k-state-active` onto the new form's tab panel.
   * Until then the only active panel is the console's own, which answers with its own form id — the live shape
   * behind `compatibility_mismatch` on a build that matched (2026-09-19).
   */
  formPanelActiveTicks?: number;
  /**
   * How many ERP-page evaluations after 发票导入单据 the 处理结果 report needs to finish painting. Until then the
   * window is on screen carrying nothing but its title; above 2 it also paints its grid a row at a time as it goes.
   * The live shape of 2026-09-19: at T+90s the window held the word 处理结果 and nothing else, and minutes later
   * held the complete ten-row all-success report. Default 2: on screen empty, complete one read later.
   */
  importReportTicks?: number;
  /** The window opens and its report never arrives at all: the hang the budget's stall clock has to catch. */
  importReportStalled?: boolean;
  /** 新增 is clicked and no form opens — the navigation that reports success while achieving nothing. */
  newFormClickDead?: boolean;
};
export type FakeMutation = { kind: 'import' | 'cell' | 'option' | 'header' | 'addRow' | 'save'; detail: string };

const SLOT = 10;
const COLS = 100;
const BOX = 8;
const ORIGIN = 4;
const ZERO = { x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
const READONLY_COLUMNS = new Set(['收票单号', '申请报销金额', '申请付款金额']);
const INVOICE_TYPES = ['普通发票', '增值税发票', '其他运输票'];
const DETAIL_COLUMNS = ['收票单号', '项目', '费用项目', '发票类型', '开始日期', '结束日期', '住宿/出差地', '出发地', '目的地', '费用金额', '税额', '申请报销金额', '申请付款金额'];
const RECEIPT_COLUMNS = ['收票单', '发票号码', '销方名称', '开票日期', '不含税金额', '税额', '价税合计', '发票类别'];
// The recognised-row grid of the 发票助手, as probe-grid.ts measured it live on 2026-09-19.
const ASSISTANT_COLUMNS = ['', '销方名称', '发票号码', '价税合计', '税额', '开票日期', '发票信息', '操作'];
// Rows are laid out down a page taller than the viewport, so the later ones are out of reach until something
// scrolls them in — live, rows 0-4 of 10 were inside the 530-high iframe viewport and rows 6-9 were not.
const ASSISTANT_ROW_TOP = 300;
const ASSISTANT_ROW_STEP = 250;

const cents = (text: string | null | undefined) => {
  const s = String(text ?? '').replace(/[¥￥,\s]/g, '');
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  return m ? Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0')) : null;
};
const money = (value: number) => `¥${(value / 100).toFixed(2)}`;
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/** One jsdom document with fake layout, visible-only innerText, and CDP-style evaluation. */
class FakeDocument {
  readonly window: any;
  readonly document: any;
  private readonly slots: any[] = [];
  private readonly slotOf = new WeakMap<object, number>();
  private scrollTop = 0;
  selectAllOn: any = null;

  constructor(html: string, url: string) {
    const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true });
    this.window = dom.window;
    this.document = this.window.document;
    const self = this;
    const proto = this.window.HTMLElement.prototype;
    proto.getBoundingClientRect = function (this: any) {
      if (!this.isConnected || self.hidden(this)) return { ...ZERO };
      const { x, docY, height } = self.layout(this);
      const y = docY - self.scrollTop;
      return { x, y, left: x, top: y, width: BOX, height, right: x + BOX, bottom: y + height };
    };
    Object.defineProperty(proto, 'innerText', { configurable: true, get(this: any) { return self.visibleText(this); } });
    // jsdom has no hit testing, so the fake answers `elementFromPoint` with its own layout — the same answer a
    // click at that point gets, which is the whole point of asking.
    this.document.elementFromPoint = (x: number, y: number) => self.elementAt(x, y);
    proto.scrollIntoView = function (this: any) {
      if (!this.isConnected || self.hidden(this)) return;
      const { docY, height } = self.layout(this);
      self.scrollTop = Math.max(0, Math.round(docY + height / 2 - self.window.innerHeight / 2));
    };
  }

  ready(): Promise<void> {
    if (this.document.readyState === 'complete') return Promise.resolve();
    return new Promise((resolve) => this.window.addEventListener('load', () => resolve()));
  }

  hidden(el: any): boolean {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      if (n.hidden) return true;
      if (n.style?.display === 'none' || n.style?.visibility === 'hidden') return true;
    }
    return false;
  }

  visibleText(node: any): string {
    if (node.nodeType === 3) return node.nodeValue ?? '';
    if (node.nodeType !== 1 || this.hidden(node) || node.tagName === 'SCRIPT' || node.tagName === 'STYLE') return '';
    let out = '';
    for (const child of node.childNodes) out += this.visibleText(child);
    return out;
  }

  /** This element's box in document coordinates: its grid slot, or the explicit y `data-below-fold` gives it. */
  layout(el: any): { x: number; docY: number; height: number } {
    let slot = this.slotOf.get(el);
    if (slot === undefined) {
      slot = this.slots.length;
      this.slots.push(el);
      this.slotOf.set(el, slot);
    }
    const below = el.getAttribute?.('data-below-fold');
    // `data-zero-height` models an inline element whose only child is a block box: laid out, hit-testable, but
    // measuring 0 high. The 发票助手's 电脑端选取 anchor is one (76x0 live, 2026-09-19).
    return {
      x: ORIGIN + (slot % COLS) * SLOT,
      docY: below === null || below === undefined ? ORIGIN + Math.floor(slot / COLS) * SLOT : Number(below),
      height: el.hasAttribute?.('data-zero-height') ? 0 : BOX,
    };
  }

  /**
   * The element whose box centre is (x, y), as the executor computes centres — and `null` for a point outside the
   * viewport, where a real `Input.dispatchMouseEvent` reaches nothing and `document.elementFromPoint` returns null.
   */
  elementAt(x: number, y: number): any {
    if (y < 0 || y >= this.window.innerHeight || x < 0 || x >= this.window.innerWidth) return null;
    const col = (x - ORIGIN - BOX / 2) / SLOT;
    const row = (y + this.scrollTop - ORIGIN - BOX / 2) / SLOT;
    if (Number.isInteger(col) && Number.isInteger(row) && col >= 0 && col < COLS) {
      const el = this.slots[row * COLS + col];
      if (el && el.isConnected && !this.hidden(el) && el.getAttribute?.('data-below-fold') === null) return this.covering(el);
    }
    // A `data-below-fold` box is off the slot grid, so it is found by measuring the few that exist.
    for (const el of this.slots) {
      if (!el.isConnected || this.hidden(el) || el.getAttribute?.('data-below-fold') === null) continue;
      const b = el.getBoundingClientRect();
      if (Math.round(b.x + b.width / 2) === x && Math.round(b.y + b.height / 2) === y) return this.covering(el);
    }
    return null;
  }

  /** `data-covered-by` names an element painted over this one: what is at the point is the cover, not the target. */
  covering(el: any): any {
    const selector = el.getAttribute?.('data-covered-by');
    return selector ? this.document.querySelector(selector) ?? el : el;
  }

  async evaluate(expression: string) {
    try {
      let value = this.window.eval(expression);
      if (value && typeof value.then === 'function') value = await value;
      return { result: { value: value === undefined ? undefined : JSON.parse(JSON.stringify(value)) } };
    } catch (error: any) {
      return { exceptionDetails: { exception: { description: String(error?.stack ?? error) } } };
    }
  }
}

export type FakeErp = Awaited<ReturnType<typeof createFakeErp>>;

export async function createFakeErp(options: FakeErpOptions) {
  const origin = options.origin ?? 'http://erp.antute.com.cn';
  const url = `${origin}/k3cloud/html5/index.aspx`;
  const account = options.account ?? { displayName: '刘明建', account: 'luo.liu', tenant: 'tenant-a' };
  const erpBuild = options.erpBuild ?? '8.2.830.9';
  const formId = options.formId ?? 'ER_ExpReimbursement';
  const today = options.today ?? '2026/9/15';
  const billNo = options.billNo ?? 'FYBX2026090001';
  const invoicesBySha = new Map(options.invoices.map((invoice) => [sha256(invoice.bytes), invoice]));
  const receiptLedger: FakeReceiptLedger = options.receiptLedger ?? new Map();

  const mutations: FakeMutation[] = [];
  const commands: Array<{ method: string; params: Record<string, any>; sessionId: string | null }> = [];
  const listeners = new Map<string, Set<CdpListener>>();
  const hooks: { onMutation?: (mutation: FakeMutation) => void } = {};
  let loggedIn = options.loggedIn ?? true;
  let targetAlive = true;
  let autoAttach = false;
  let formUuid = 'a1b2c3d4e5f6';
  let main: FakeDocument = await render();
  let child: { doc: FakeDocument; sessionId: string; targetId: string } | null = null;
  let editor: { td: any; tr: any; input: any; column: string } | null = null;
  let activePane: string | null = null;
  let uploadBatches = 0;
  let assistantTicks = 0;
  let mainTicks = 0;
  let formPanelActiveAt: number | null = null;
  let pendingReport: { start: number; due: number; summary: string; rows: readonly string[] } | null = null;
  const pendingRecognition: Array<{ due: number; files: string[] }> = [];
  let dropdown: { td: any; tr: any; list: any; span: any } | null = null;

  function mutate(kind: FakeMutation['kind'], detail: string) {
    const mutation = { kind, detail };
    mutations.push(mutation);
    hooks.onMutation?.(mutation);
  }

  async function render() {
    const html = (loggedIn ? fixture('erp-main.html') : fixture('erp-login.html'))
      .replaceAll('{{UUID}}', formUuid).replaceAll('{{DISPLAY_NAME}}', escapeHtml(account.displayName))
      .replaceAll('{{BUILD}}', erpBuild).replaceAll('{{FORM_ID}}', formId).replaceAll('{{TODAY}}', today);
    const doc = new FakeDocument(html, url);
    // K3Cloud states its front-end resource version nowhere in the DOM, only on this global, which is where the
    // compatibility fingerprint reads it. jsdom runs no inline script, so the fake sets it directly.
    (doc.window as unknown as { KDResVer: string }).KDResVer = `?ver=${erpBuild}`;
    // localStorage keeps the last account even on the login page (probe.mjs fact 4).
    doc.window.localStorage.setItem('k3cloudloginInfo', JSON.stringify({ user: account.account, acc: account.tenant }));
    doc.window.fetch = async (_input: string, init: { body: string }) => {
      const payload = JSON.parse(JSON.parse(init.body).parameters[0]);
      const source = payload.FormId === 'BD_Expense' ? options.expenseItems : payload.FormId === 'BJYC_ProJect' ? options.projects : null;
      const codes = [...String(payload.FilterString).matchAll(/'([^']*)'/g)].map((m) => m[1]);
      const body = source === null
        ? [[{ Result: { ResponseStatus: { Errors: [{ Message: `未知业务对象 ${payload.FormId}` }] } } }]]
        : source.filter((row) => codes.includes(row.code)).map((row) => [row.code, row.name, row.documentStatus ?? 'C', row.forbidStatus ?? 'A']);
      return { status: 200, text: async () => JSON.stringify(body) };
    };
    await doc.ready();
    if (options.notFillEntryBelowFold) doc.document.querySelector('a[id$="tbNotFillEntry"]')?.setAttribute('data-below-fold', '1240');
    return doc;
  }

  const q = (selector: string) => main.document.querySelector(selector);
  const grid = (name: 'detail' | 'receipts') => main.document.querySelector(`.kd-grid-panel[data-grid="${name}"]`);
  const dataRows = (name: 'detail' | 'receipts') => [...grid(name).querySelectorAll('tbody tr')].filter((tr: any) => !tr.classList.contains('k-footer-template'));
  const columnsOf = (name: 'detail' | 'receipts') => (name === 'detail' ? DETAIL_COLUMNS : RECEIPT_COLUMNS);
  const cellOf = (tr: any, name: 'detail' | 'receipts', column: string) => tr.children[columnsOf(name).indexOf(column)];
  const textOf = (tr: any, name: 'detail' | 'receipts', column: string) => String(cellOf(tr, name, column)?.textContent ?? '').trim();
  const setText = (tr: any, name: 'detail' | 'receipts', column: string, text: string) => {
    const td = cellOf(tr, name, column);
    const inner = td.querySelector('span, a');
    if (inner) inner.textContent = text; else td.textContent = text;
  };
  const show = (el: any, on: boolean) => { if (el) el.style.display = on ? '' : 'none'; };
  const visible = (el: any) => !!el && !main.hidden(el);

  function display(column: string, raw: string) {
    switch (column) {
      case '项目': return options.projects.find((p) => p.code === raw)?.name ?? '';
      case '费用项目': return options.expenseItems.find((p) => p.code === raw)?.name ?? '';
      case '费用金额':
      case '税额': return cents(raw) === null ? '' : money(cents(raw)!);
      default: return raw;
    }
  }

  function recalc(tr: any) {
    const net = cents(textOf(tr, 'detail', '费用金额'));
    const tax = cents(textOf(tr, 'detail', '税额')) ?? 0;
    const total = net === null ? '' : money(net + tax);
    setText(tr, 'detail', '申请报销金额', total);
    setText(tr, 'detail', '申请付款金额', total);
  }

  function updateTotals() {
    const footer = (name: 'detail' | 'receipts') => grid(name).querySelector('tr.k-footer-template');
    const detailSum = dataRows('detail').map((tr) => cents(textOf(tr, 'detail', '申请报销金额')));
    setText(footer('detail'), 'detail', '申请报销金额', detailSum.some((v) => v !== null) ? money(detailSum.reduce<number>((a, v) => a + (v ?? 0), 0)) : '');
    const receiptSum = dataRows('receipts').map((tr) => cents(textOf(tr, 'receipts', '价税合计')) ?? 0);
    setText(footer('receipts'), 'receipts', '价税合计', receiptSum.length ? (receiptSum.reduce((a, v) => a + v, 0) / 100).toFixed(2) : '');
  }

  function linkReceipt(tr: any) {
    if (!options.assumeReceiptLink || textOf(tr, 'detail', '收票单号')) return;
    const net = cents(textOf(tr, 'detail', '费用金额'));
    const tax = cents(textOf(tr, 'detail', '税额'));
    const linked = new Set(dataRows('detail').map((row) => textOf(row, 'detail', '收票单号')).filter(Boolean));
    const hits = dataRows('receipts').filter((row) => cents(textOf(row, 'receipts', '不含税金额')) === net
      && cents(textOf(row, 'receipts', '税额')) === tax && !linked.has(textOf(row, 'receipts', '收票单')));
    if (hits.length === 1) setText(tr, 'detail', '收票单号', textOf(hits[0], 'receipts', '收票单'));
  }

  function commitEditor() {
    if (!editor) return;
    const { td, tr, input, column } = editor;
    editor = null;
    const text = display(column, String(input.value).trim());
    td.textContent = text;
    tr.classList.remove('k-grid-edit-row');
    mutate('cell', `${column}=${text}`);
    // Linked recalculation: a new 费用金额 clears 税额 (kernel erpform settleGrid note).
    if (column === '费用金额') setText(tr, 'detail', '税额', '');
    recalc(tr);
    if (column === '税额') linkReceipt(tr);
    updateTotals();
  }

  function closeDropdown() {
    if (!dropdown) return;
    dropdown.list.remove();
    dropdown.tr.classList.remove('k-grid-edit-row');
    dropdown.span.blur();
    dropdown = null;
  }

  function editCell(td: any) {
    const tr = td.parentElement;
    const column = DETAIL_COLUMNS[[...tr.children].indexOf(td)]!;
    if (READONLY_COLUMNS.has(column)) return;
    commitEditor();
    closeDropdown();
    tr.classList.add('k-grid-edit-row');
    if (column === '发票类型') {
      const span = td.querySelector('span') ?? td.appendChild(main.document.createElement('span'));
      span.setAttribute('tabindex', '0');
      span.focus();
      const list = main.document.createElement('ul');
      list.className = 'k-list';
      for (const option of INVOICE_TYPES) {
        const li = main.document.createElement('li');
        li.setAttribute('role', 'option');
        li.textContent = option;
        list.appendChild(li);
      }
      main.document.body.appendChild(list);
      dropdown = { td, tr, list, span };
      return;
    }
    const current = String(td.textContent).trim().replace(/^[¥￥]/, '');
    td.textContent = '';
    const input = main.document.createElement('input');
    input.value = current;
    td.appendChild(input);
    input.focus();
    editor = { td, tr, input, column };
  }

  function pickOption(text: string) {
    if (!dropdown) return;
    const { tr, span } = dropdown;
    const before = span.textContent;
    span.textContent = text;
    closeDropdown();
    mutate('option', `发票类型=${text}`);
    // Changing the invoice type clears an entered tax (save-contract order note).
    if (before !== text) { setText(tr, 'detail', '税额', ''); recalc(tr); }
    updateTotals();
  }

  function defaultRow() {
    const tr = main.document.createElement('tr');
    tr.className = 'k-master-row';
    tr.innerHTML = DETAIL_COLUMNS.map((column) => (column === '收票单号' ? '<td><a class="disabled"></a></td>'
      : column === '发票类型' ? '<td><span class="k-input">普通发票</span></td>'
        : column === '开始日期' || column === '结束日期' ? `<td>${today}</td>` : '<td></td>')).join('');
    return tr;
  }

  function message(text: string) {
    const win = q('#message-window');
    win.querySelector('.k-window-message').textContent = text;
    show(win, true);
  }

  /**
   * ERP's 处理结果 window: its answer to 发票导入单据 — a summary line over a grid of 序号 / 关键字 / 状态 / 问题描述,
   * one row per invoice. 退出 closes it.
   *
   * The summary has two wordings, both measured live, and the fake writes whichever the outcome calls for. With
   * failures: 「执行成功：10；执行失败：2」. With none: 「全部执行成功：10」 — which names no 执行失败 at all. The fake
   * used to format both halves always, so the all-success wording never reached the judge and a live import of 10
   * of 10 was read as «still loading» until the budget ran out.
   *
   * It opens empty and fills in a moment later — live 2026-09-19 a read on first sight of the window returned the
   * text 「处理结果」 alone, with no summary in it yet.
   */
  function result(summary: string, rows: readonly string[]) {
    const win = q('#result-window');
    win.querySelector('.k-window-message').textContent = '';
    show(win, true);
    if (options.importReportStalled) return;
    const ticks = Math.max(1, options.importReportTicks ?? 2);
    pendingReport = { start: mainTicks, due: mainTicks + ticks, summary, rows };
    paintReport();
  }

  /**
   * The report as much of it as has been painted by now. The toolbar words and the grid header are part of what a
   * reader of this window actually sees, and the header carries 序号 / 关键字 / 状态 with no 序号 of its own — the
   * fake keeps them so a judge cannot pass by counting a header row as an invoice. The summary lands last, which
   * is why a half-painted grid of nothing but 成功 may not be read as a verdict.
   */
  function paintReport() {
    if (!pendingReport) return;
    const { start, due, summary, rows } = pendingReport;
    const done = mainTicks >= due;
    // A report that takes its time paints its grid a row at a time; the default two-tick one is empty, then whole.
    const progress = (mainTicks - start) / (due - start);
    const painted = done ? rows : (options.importReportTicks ?? 0) > 2 ? rows.slice(0, Math.floor(rows.length * progress)) : [];
    // Live, the window is on screen with NOTHING in it — no toolbar, no header, no summary — until it starts
    // painting its grid, so nothing here appears before the first row does.
    const text = painted.length === 0 && !done ? '' : [
      '打开 引出全部记录 引出失败记录 （您可以单击字段链接定位到所在位置）',
      ...(done ? [summary] : []),
      '设置 序号 设置 关键字 设置 状态 设置 问题描述',
      ...painted.map((row, index) => `${index + 1} ${row}`),
    ].join(' ');
    q('#result-window .k-window-message').textContent = text;
    if (done) pendingReport = null;
  }

  function emitEvent(method: string, params: Record<string, unknown>) {
    for (const listener of listeners.get(method) ?? []) listener(params, null);
  }

  async function openAssistant() {
    show(q('#assistant-window'), true);
    const doc = new FakeDocument(fixture('piaozone-assistant.html'), 'https://www.piaozone.com/pwy-assistant/index.html');
    await doc.ready();
    child = { doc, sessionId: 'piaozone-session-1', targetId: 'piaozone-1' };
    activePane = null;
    uploadBatches = 0;
    assistantTicks = 0;
    pendingRecognition.length = 0;
    if (autoAttach) {
      const { sessionId, targetId } = child;
      setTimeout(() => {
        emitEvent('Target.attachedToTarget', { sessionId, targetInfo: { targetId, type: 'iframe', url: 'about:blank' } });
        emitEvent('Target.targetInfoChanged', { targetInfo: { targetId, type: 'iframe', url: doc.window.location.href } });
      }, 0);
    }
  }

  function importInvoices() {
    if (!child) return;
    const rows = [...child.doc.document.querySelectorAll('tbody tr')].filter((tr: any) => tr.querySelector('input.ant-checkbox-input')?.checked);
    const selected = (rows as any[]).map((row) => invoicesBySha.get(row.getAttribute('data-sha256'))!);
    // A refusal is per invoice, not per import: measured live 2026-09-19, two invoices already bound to a SAVED
    // 费用报销单 were refused by name while the other ten bound in the same click (「执行成功：10；执行失败：2」).
    // ERP's own words come back in the 处理结果 window, one line per invoice (ADR-0027 judges on that list).
    const refused = selected.filter((invoice) => invoice.importRefusal);
    const accepted = selected.filter((invoice) => !invoice.importRefusal);
    const tbody = grid('receipts').querySelector('tbody');
    const footer = tbody.querySelector('tr.k-footer-template');
    const rowFor = (receiptNumber: string) => dataRows('receipts').find((tr: any) => textOf(tr, 'receipts', '收票单') === receiptNumber);
    const appendRow = (values: readonly string[]) => {
      const tr = main.document.createElement('tr');
      tr.className = 'k-master-row';
      tr.innerHTML = values.map((value) => `<td>${escapeHtml(value)}</td>`).join('');
      tbody.insertBefore(tr, footer);
      return tr;
    };
    const imported: string[] = [];
    const report: string[] = [];
    for (const invoice of accepted) {
      const masked = `${invoice.invoiceNumber.slice(0, 4)}************${invoice.invoiceNumber.slice(-4)}`;
      const values = [invoice.receiptNumber, masked, invoice.seller, invoice.issueDate, invoice.net, invoice.tax, invoice.gross, invoice.category];
      // A 收票单 ERP already holds is re-bound to the bill being imported into, rather than minted a second time:
      // that is what「已存在对应的收票单，已进行覆盖」means, and it is why an import that was never saved can be
      // replayed onto a fresh 新增单 (ADR-0026). The fake shows a bound 收票单 as a row of the 收票信息 grid, so
      // re-binding puts the record's row back on this bill; the overwrite rule below then rewrites it.
      const bound = receiptLedger.get(invoice.receiptNumber);
      if (bound && !rowFor(invoice.receiptNumber)) appendRow(bound);
      // ERP identifies a 收票行 (receipt row) by its 收票单 (receipt number): importing an invoice the bill already
      // holds rewrites that row in place instead of adding a second one (ADR-0026). Because the identity that
      // decides this is the one the row keeps, a rewrite cannot strand a detail row's 收票单号 link.
      const held = rowFor(invoice.receiptNumber);
      if (held) {
        RECEIPT_COLUMNS.forEach((column, index) => setText(held, 'receipts', column, values[index]!));
      } else {
        appendRow(values);
      }
      // Minting a 收票单 and overwriting one ERP already holds read differently in the report, and the difference
      // is how ADR-0026's overwrite shows up on screen.
      report.push(`接收发票 成功 号码为【${invoice.invoiceNumber}】的发票${bound
        ? `已存在对应的收票单【${invoice.receiptNumber}】，已进行覆盖！`
        : `接收成功，生成收票单【${invoice.receiptNumber}】`}`);
      receiptLedger.set(invoice.receiptNumber, values);
      imported.push(invoice.receiptNumber);
    }
    for (const invoice of refused) report.push(`接收发票 失败 号码为【${invoice.invoiceNumber}】的发票${invoice.importRefusal}`);
    updateTotals();
    show(q('#assistant-window'), false);
    result(refused.length === 0
      ? `全部执行成功：${accepted.length}`
      : `执行成功：${accepted.length}；执行失败：${refused.length}`, report);
    const closing = child;
    mutate('import', imported.join(','));
    // The iframe target goes away after this click completes, and NOTHING replaces it: the whole answer to the
    // click is on the ERP page. Its own mouseReleased still reaches it.
    setTimeout(() => {
      if (child === closing) child = null;
      emitEvent('Target.detachedFromTarget', { sessionId: closing.sessionId });
    }, 0);
  }

  function save() {
    commitEditor();
    closeDropdown();
    const purpose = String(q(`[id$="-FCAUSA-EDITOR"]`).value).trim();
    if (!purpose) { message('事由不能为空，保存失败'); return; }
    q('.form-tab').textContent = '费用报销单-修改';
    q(`[id$="-FBILLNO-EDITOR"]`).value = billNo;
    mutate('save', billNo);
  }

  async function clickMain(el: any) {
    const assistant = q('#assistant-window');
    if (visible(assistant) && !assistant.contains(el)) return; // the modal assistant swallows clicks
    if (dropdown) {
      const li = el.closest('ul.k-list li');
      if (li) return pickOption(String(li.textContent).trim());
      closeDropdown();
    }
    if (editor && editor.td.contains(el)) { editor.input.focus(); return; }
    const action = el.closest('[data-action]')?.getAttribute('data-action');
    const td = el.closest('.kd-grid-panel[data-grid="detail"] td');
    if (td && !td.parentElement.classList.contains('k-footer-template')) return editCell(td);
    commitEditor();
    switch (action) {
      case 'open-list': return show(q('#expense-list'), true);
      case 'new-form':
        if (options.newFormClickDead) return undefined;
        show(q('#expense-list'), false);
        show(q('#expense-form'), true);
        formPanelActiveAt = mainTicks + (options.formPanelActiveTicks ?? 0);
        return syncFormPanel();
      case 'section': return undefined;
      case 'split-arrow': return show(q('a[id$="tbNotFillEntry"]'), true);
      case 'not-fill-entry': show(q('a[id$="tbNotFillEntry"]'), false); return openAssistant();
      case 'new-row': {
        const tbody = grid('detail').querySelector('tbody');
        tbody.insertBefore(defaultRow(), tbody.querySelector('tr.k-footer-template'));
        return mutate('addRow', String(dataRows('detail').length));
      }
      case 'save': return save();
      case 'close-window': return show(el.closest('.k-window'), false);
      default:
        if (el.matches('input') && String(el.id).endsWith('-EDITOR') && !el.readOnly) el.focus();
        return undefined;
    }
  }

  function clickAssistant(el: any) {
    if (!child) return;
    // The 票种 tab strip. Switching hides one pane and shows another; it touches no checkbox, which is why a tick
    // survives a switch (measured live 2026-09-19: 4/10 ticked, switch away, switch back, still 4/10).
    const tab = el.closest?.('.ant-tabs-tab');
    if (tab) {
      if (!options.assistantPaneSwitchDead) showPane(String(tab.getAttribute('data-pane')));
      return;
    }
    if (el.matches('input.ant-checkbox-input')) {
      if (el.closest('thead')) return; // the header 全选 is on the never-click list; the fake refuses it too
      const number = assistantKeyOf(el.closest('tr'));
      if ((options.assistantDeadTickNumbers ?? []).includes(number)) return;
      el.checked = !el.checked;
      return;
    }
    const doc = child.doc.document;
    const action = el.closest('[data-action]')?.getAttribute('data-action');
    // 电脑端选取 leaves the entry menu for the upload view; that is where the file input and the grid live.
    if (action === 'computer-picker' && !options.assistantStuckOnEntryMenu) {
      show(doc.querySelector('.fpzsHome'), false);
      show(doc.querySelector('#assistant-upload'), true);
    }
    if (action === 'notice-ok') show(doc.querySelector('#assistant-notice'), false);
    // 发票导入单据 imports in the mode already chosen on the ERP's split-button menu. It asks nothing further:
    // measured live 2026-09-19, no 是否生成费用明细 dialog exists on this path, in the iframe or anywhere else.
    if (action === 'import') importInvoices();
  }

  function key(doc: FakeDocument, params: Record<string, any>) {
    const active = doc.document.activeElement;
    if (params.type === 'rawKeyDown' && Array.isArray(params.commands) && params.commands.includes('selectAll')) { doc.selectAllOn = active; return; }
    if (params.type === 'keyDown' && typeof params.text === 'string') {
      if (active && /^(INPUT|TEXTAREA)$/.test(active.tagName)) {
        if (doc.selectAllOn === active) { active.value = params.text; doc.selectAllOn = null; } else active.value += params.text;
      }
      return;
    }
    if (params.type !== 'rawKeyDown' || doc !== main) return;
    if (params.key === 'Enter' || params.key === 'Tab') {
      if (editor && active === editor.input) return commitEditor();
      if (active && String(active.id).endsWith('-EDITOR')) { active.blur(); mutate('header', `${String(active.id).split('-').slice(-2, -1)[0]}=${active.value}`); }
      return;
    }
    if (params.key === 'Escape') closeDropdown();
  }

  const assistantKeyOf = (tr: any) =>
    String(tr?.children?.[ASSISTANT_COLUMNS.indexOf('发票号码')]?.textContent ?? '').trim();

  /** The `<tbody>` of one 票种 pane, and its tab, created on first sight of that 票种. */
  function paneOf(label: string) {
    const doc = child!.doc.document;
    const existing = doc.querySelector(`tbody[data-pane="${label}"]`);
    if (existing) return existing;
    const tbody = doc.createElement('tbody');
    tbody.setAttribute('data-pane', label);
    doc.querySelector('.ant-table').appendChild(tbody);
    const tab = doc.createElement('div');
    tab.className = 'ant-tabs-tab';
    tab.setAttribute('data-pane', label);
    doc.querySelector('#assistant-tabs').appendChild(tab);
    // The first 票种 to arrive is the one the grid opens on; later ones start hidden.
    showPane(doc.querySelectorAll('tbody[data-pane]').length === 1 ? label : activePane);
    return tbody;
  }

  function showPane(label: string | null) {
    activePane = label;
    const doc = child!.doc.document;
    for (const tbody of doc.querySelectorAll('tbody[data-pane]')) show(tbody, tbody.getAttribute('data-pane') === label);
    for (const tab of doc.querySelectorAll('.ant-tabs-tab')) {
      tab.className = tab.getAttribute('data-pane') === label ? 'ant-tabs-tab-active ant-tabs-tab' : ' ant-tabs-tab';
    }
  }

  /** Tab captions (`<票种> <count>`) and the 已选取N张发票 footer, which counts UPLOADS and never ticks. */
  function refreshAssistant() {
    const doc = child!.doc.document;
    let uploaded = 0;
    for (const tbody of doc.querySelectorAll('tbody[data-pane]')) {
      const label = tbody.getAttribute('data-pane');
      const count = tbody.querySelectorAll('tr').length;
      uploaded += count;
      doc.querySelector(`.ant-tabs-tab[data-pane="${label}"]`).textContent = `${label} ${count}`;
    }
    doc.querySelector('#assistant-selected').textContent = `已选取${uploaded}张发票 所有已选发票已选0份附件`;
  }

  function recognise(files: string[]) {
    if (!child) return;
    const doc = child.doc.document;
    for (const path of files) {
      const hash = sha256(readFileSync(path));
      const invoice = invoicesBySha.get(hash);
      if (!invoice || doc.querySelector(`tr[data-sha256="${hash}"]`)) continue; // unknown files are not recognised; duplicates dedupe by number
      // 票种 is what the grid groups by, so the fake groups by the invoice's own 发票类别.
      const tbody = paneOf(invoice.category);
      const tr = doc.createElement('tr');
      tr.setAttribute('data-sha256', hash);
      tr.innerHTML = ASSISTANT_COLUMNS.map((column) => {
        switch (column) {
          case '': return '<td><input type="checkbox" class="ant-checkbox-input"></td>';
          case '销方名称': return `<td>${escapeHtml(invoice.seller)}</td>`;
          case '发票号码': return `<td>${escapeHtml(invoice.invoiceNumber)}</td>`;
          case '价税合计': return `<td>${escapeHtml(invoice.gross)}</td>`;
          case '税额': return `<td>${escapeHtml(invoice.tax)}</td>`;
          case '开票日期': return `<td>${escapeHtml(invoice.issueDate)}</td>`;
          default: return '<td></td>';
        }
      }).join('');
      tbody.appendChild(tr);
      // Each row sits one row-height further down a page taller than the viewport: the later ones are unreachable
      // until something scrolls them in.
      const input = tr.querySelector('input.ant-checkbox-input');
      input.setAttribute('data-below-fold', String(ASSISTANT_ROW_TOP + (tbody.querySelectorAll('tr').length - 1) * ASSISTANT_ROW_STEP));
      if ((options.assistantCoveredTickNumbers ?? []).includes(invoice.invoiceNumber)) input.setAttribute('data-covered-by', '#assistant-overlay');
    }
    refreshAssistant();
  }

  /** Kendo moving `k-state-active` from the console's tab panel onto the newly opened form's, a few reads late. */
  function syncFormPanel() {
    if (formPanelActiveAt === null || mainTicks < formPanelActiveAt) return;
    q('#console-panel').classList.remove('k-state-active');
    q('#form-panel').classList.add('k-state-active');
    formPanelActiveAt = null;
  }

  /** Recognition that has not landed yet, because `assistantRecognitionTicks` holds this batch back. */
  function flushRecognition() {
    while (pendingRecognition.length && pendingRecognition[0]!.due <= assistantTicks) recognise(pendingRecognition.shift()!.files);
  }

  function setFiles(files: string[]) {
    if (!child) return;
    const delay = options.assistantRecognitionTicks ?? 0;
    if (delay > 0 && uploadBatches > 0) pendingRecognition.push({ due: assistantTicks + delay, files });
    else recognise(files);
    uploadBatches += 1;
  }

  const session: CdpSession = {
    async send(method, params = {}, { sessionId = null } = {}) {
      commands.push({ method, params, sessionId });
      if (sessionId && (!child || sessionId !== child.sessionId)) throw new Error(`No session with given id: ${sessionId}`);
      if (!sessionId && !targetAlive) throw new Error('CDP 连接已关闭');
      const doc = sessionId ? child!.doc : main;
      if (sessionId) { assistantTicks += 1; flushRecognition(); }
      else { mainTicks += 1; syncFormPanel(); paintReport(); }
      switch (method) {
        case 'Runtime.evaluate': return doc.evaluate(String(params.expression));
        case 'Input.dispatchMouseEvent':
          if (params.type === 'mousePressed') {
            const el = doc.elementAt(Number(params.x), Number(params.y));
            if (el) { if (doc === main) await clickMain(el); else clickAssistant(el); }
          }
          return {};
        case 'Input.dispatchKeyEvent': key(doc, params); return {};
        case 'Target.setAutoAttach': autoAttach = true; return {};
        case 'DOM.getDocument': return { root: { nodeId: 1 } };
        case 'DOM.querySelector': return { nodeId: doc.document.querySelector(params.selector) ? 2 : 0 };
        case 'DOM.setFileInputFiles': setFiles(params.files as string[]); return {};
        case 'Page.captureScreenshot': return { data: Buffer.from(`fake-screenshot ${JSON.stringify(params.clip ?? null)}`).toString('base64') };
        default: return {};
      }
    },
    on(method, listener) {
      if (!listeners.has(method)) listeners.set(method, new Set());
      listeners.get(method)!.add(listener);
      return () => listeners.get(method)?.delete(listener);
    },
    close() {},
  };

  const page: ChromiumPage = {
    transport: 'default', automation: 'cdp', browserFamily: 'chromium', tabId: 'erp-page-1', index: null,
    url, title: '金蝶云星空', active: false, origin, pageId: 'erp-page-1', cdpPort: 9333,
    cdpTargetId: 'erp-page-1', cdpUrl: 'ws://127.0.0.1:9333/devtools/page/erp-page-1',
  };

  return {
    session, mutations, commands, hooks,
    get document() { return main.document; },
    /** The 发票助手's own document while it is open — its 票种 panes, their rows and their ticks. */
    get assistantDocument() { return child?.doc.document ?? null; },
    browser: {
      listPages: async () => (targetAlive ? [page] : []),
      attach: async (candidate: ChromiumPage) => ({ ...candidate, automation: 'cdp' as const, session }),
    },
    /** The user logs in on the same page (same URL, new DOM). */
    async login() { loggedIn = true; main = await render(); },
    /**
     * The employee clicks 保存 (save) themselves. baox never does (ADR-0028), so this is the only way a fake ERP
     * reaches 已保存 — exactly as it happens in production, by a human at the keyboard.
     */
    employeeSaves() { save(); },
    /** Drift: ERP re-renders the form under a new form-instance UUID. */
    replaceFormInstance() {
      const next = 'f0e1d2c3b4a5';
      for (const el of main.document.querySelectorAll(`[id^="${formUuid}-"]`)) el.id = el.id.replace(formUuid, next);
      formUuid = next;
    },
    /** Drift: the CDP target goes away. */
    closeTarget() { targetAlive = false; },
  };
}
