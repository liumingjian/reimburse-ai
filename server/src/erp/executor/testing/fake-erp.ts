// The fake ERP: a stateful fake CDP session over recorded DOM fixtures (./fixtures), after the kernel's
// kernel/test/fake-session.mjs. Every executor expression really runs against a jsdom document; clicks and keys
// arrive as CDP `Input.*` events at viewport coordinates and are turned into the behaviour the research recorded
// (docs/research/erp-expense-flow): edit-on-click cells, select-all + typing + Enter/Tab commit, F7 code -> name,
// the invoice-type dropdown, linked recalculation, the piaozone assistant as a child target, save -> 修改 mode.
//
// Layout: jsdom has none, so every visible element gets a unique 8x8 box on a 10px grid inside the viewport, in
// the order it is first measured. Hidden (display:none / visibility:hidden / [hidden]) elements measure 0x0.
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
};
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
  selectAllOn: any = null;

  constructor(html: string, url: string) {
    const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true });
    this.window = dom.window;
    this.document = this.window.document;
    const self = this;
    const proto = this.window.HTMLElement.prototype;
    proto.getBoundingClientRect = function (this: any) {
      if (!this.isConnected || self.hidden(this)) return { ...ZERO };
      let slot = self.slotOf.get(this);
      if (slot === undefined) {
        slot = self.slots.length;
        self.slots.push(this);
        self.slotOf.set(this, slot);
      }
      const x = ORIGIN + (slot % COLS) * SLOT;
      const y = ORIGIN + Math.floor(slot / COLS) * SLOT;
      return { x, y, left: x, top: y, width: BOX, height: BOX, right: x + BOX, bottom: y + BOX };
    };
    Object.defineProperty(proto, 'innerText', { configurable: true, get(this: any) { return self.visibleText(this); } });
    proto.scrollIntoView = function () { /* every box is already in view */ };
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

  /** The element whose box centre is (x, y), as the executor computes centres. */
  elementAt(x: number, y: number): any {
    const col = (x - ORIGIN - BOX / 2) / SLOT;
    const row = (y - ORIGIN - BOX / 2) / SLOT;
    if (!Number.isInteger(col) || !Number.isInteger(row) || col < 0 || col >= COLS) return null;
    const el = this.slots[row * COLS + col];
    return el && el.isConnected && !this.hidden(el) ? el : null;
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
  const erpBuild = options.erpBuild ?? '8.2.0.20250701';
  const formId = options.formId ?? 'ER_ExpReimbursement';
  const today = options.today ?? '2026/9/15';
  const billNo = options.billNo ?? 'FYBX2026090001';
  const invoicesBySha = new Map(options.invoices.map((invoice) => [sha256(invoice.bytes), invoice]));

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

  function emitEvent(method: string, params: Record<string, unknown>) {
    for (const listener of listeners.get(method) ?? []) listener(params, null);
  }

  async function openAssistant() {
    show(q('#assistant-window'), true);
    const doc = new FakeDocument(fixture('piaozone-assistant.html'), 'https://www.piaozone.com/pwy-assistant/index.html');
    await doc.ready();
    child = { doc, sessionId: 'piaozone-session-1', targetId: 'piaozone-1' };
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
    const tbody = grid('receipts').querySelector('tbody');
    const footer = tbody.querySelector('tr.k-footer-template');
    const imported: string[] = [];
    for (const row of rows as any[]) {
      const invoice = invoicesBySha.get(row.getAttribute('data-sha256'))!;
      const tr = main.document.createElement('tr');
      tr.className = 'k-master-row';
      const masked = `${invoice.invoiceNumber.slice(0, 4)}************${invoice.invoiceNumber.slice(-4)}`;
      tr.innerHTML = [invoice.receiptNumber, masked, invoice.seller, invoice.issueDate, invoice.net, invoice.tax, invoice.gross, invoice.category]
        .map((value) => `<td>${escapeHtml(value)}</td>`).join('');
      tbody.insertBefore(tr, footer);
      imported.push(invoice.receiptNumber);
    }
    updateTotals();
    show(q('#assistant-window'), false);
    const closing = child;
    mutate('import', imported.join(','));
    // The iframe target goes away after this click completes: its own mouseReleased still reaches it.
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
      case 'new-form': show(q('#expense-list'), false); return show(q('#expense-form'), true);
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
    if (el.matches('input.ant-checkbox-input')) { el.checked = !el.checked; return; }
    const action = el.closest('[data-action]')?.getAttribute('data-action');
    if (action === 'import') show(child.doc.document.querySelector('.import-dialog'), true);
    if (action === 'not-fill') importInvoices();
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

  function setFiles(files: string[]) {
    if (!child) return;
    const tbody = child.doc.document.querySelector('tbody');
    for (const path of files) {
      const hash = sha256(readFileSync(path));
      const invoice = invoicesBySha.get(hash);
      if (!invoice || tbody.querySelector(`tr[data-sha256="${hash}"]`)) continue; // unknown files are not recognised; duplicates dedupe by number
      const tr = child.doc.document.createElement('tr');
      tr.setAttribute('data-sha256', hash);
      tr.innerHTML = `<td><input type="checkbox" class="ant-checkbox-input"></td><td>${invoice.invoiceNumber}</td><td>${invoice.gross}</td>`;
      tbody.appendChild(tr);
    }
  }

  const session: CdpSession = {
    async send(method, params = {}, { sessionId = null } = {}) {
      commands.push({ method, params, sessionId });
      if (sessionId && (!child || sessionId !== child.sessionId)) throw new Error(`No session with given id: ${sessionId}`);
      if (!sessionId && !targetAlive) throw new Error('CDP 连接已关闭');
      const doc = sessionId ? child!.doc : main;
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
    browser: {
      listPages: async () => (targetAlive ? [page] : []),
      attach: async (candidate: ChromiumPage) => ({ ...candidate, automation: 'cdp' as const, session }),
    },
    /** The user logs in on the same page (same URL, new DOM). */
    async login() { loggedIn = true; main = await render(); },
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
