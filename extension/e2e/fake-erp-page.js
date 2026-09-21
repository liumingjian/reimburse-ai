// The fake ERP's behaviour, run INSIDE the served pages of the real-browser harness (spec #246 seam 4, #259).
//
// The jsdom fake ERP (`erp-executor/src/testing/fake-erp.ts`) supplies its behaviour from outside the page: it is a
// fake CDP session that turns `Input.*` commands at its own fake layout into DOM changes. A real Chromium sends real
// events to a real layout, so the same behaviour has to live in the page. This is that behaviour for the default
// options only — no live-quirk option is modelled — ported rule for rule from `fake-erp.ts`, which stays the
// reference: when the two disagree, `fake-erp.ts` is right and this file is stale. `assumeReceiptLink` is on, as in
// every server test that reaches hand-over, so the strict read-back can pass.
//
// Plain browser JS, served as a file and started by `window.__FAKE_ERP__` (set inline by `harness.ts`):
//   { role: 'erp', assistantUrl, assistantOrigin, invoices, projects, expenseItems, today }
//   { role: 'assistant', invoices, erpOrigin }
// The ERP page keeps its own record of every mutation in `window.fakeErp.mutations`, the same `{ kind, detail }`
// shape `fake-erp.ts` records, so a test can read what the ERP was made to do — a `save` included.
(() => {
  const config = window.__FAKE_ERP__;
  const show = (el, on) => { if (el) el.style.display = on ? '' : 'none'; };
  const hidden = (el) => {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      if (n.hidden || n.style.display === 'none' || n.style.visibility === 'hidden') return true;
    }
    return false;
  };
  const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const bySha = new Map(config.invoices.map((invoice) => [invoice.sha256, invoice]));

  if (config.role === 'assistant') assistant();
  else erp();

  function erp() {
    const READONLY_COLUMNS = new Set(['收票单号', '申请报销金额', '申请付款金额']);
    const INVOICE_TYPES = ['普通发票', '增值税发票', '机票', '火车票', '其他运输票', '其他'];
    const DETAIL_COLUMNS = ['收票单号', '项目', '费用项目', '发票类型', '开始日期', '结束日期', '住宿/出差地', '出发地', '目的地', '费用金额', '税额', '申请报销金额', '申请付款金额'];
    const RECEIPT_COLUMNS = ['收票单', '发票号码', '销方名称', '开票日期', '不含税金额', '税额', '价税合计', '发票类别'];
    const DATE_COLUMNS = new Set(['开始日期', '结束日期']);
    const record = { mutations: [], importMode: null };
    window.fakeErp = record;
    const mutate = (kind, detail) => record.mutations.push({ kind, detail });

    const q = (selector) => document.querySelector(selector);
    const grid = (name) => q(`.kd-grid-panel[data-grid="${name}"]`);
    const dataRows = (name) => [...grid(name).querySelectorAll('tbody tr')].filter((tr) => !tr.classList.contains('k-footer-template'));
    const columnsOf = (name) => (name === 'detail' ? DETAIL_COLUMNS : RECEIPT_COLUMNS);
    const cellOf = (tr, name, column) => tr.children[columnsOf(name).indexOf(column)];
    const textOf = (tr, name, column) => String(cellOf(tr, name, column)?.textContent ?? '').trim();
    const setText = (tr, name, column, text) => {
      const td = cellOf(tr, name, column);
      const inner = td.querySelector('span, a');
      if (inner) inner.textContent = text; else td.textContent = text;
    };
    const cents = (text) => {
      const s = String(text ?? '').replace(/[¥￥,\s]/g, '');
      const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s);
      return m ? Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0')) : null;
    };
    const money = (value) => `¥${(value / 100).toFixed(2)}`;
    const kendoDate = (raw) => {
      const m = /^\s*(\d{4})[/-](\d{1,2})[/-](\d{1,2})/.exec(String(raw));
      return m ? `${m[1]}/${Number(m[2])}/${Number(m[3])}` : null;
    };
    const setCaret = (el, at) => { try { el.setSelectionRange(at, at); } catch { /* not a text input */ } };

    let editor = null;
    let dropdown = null;

    function display(column, raw) {
      switch (column) {
        case '项目': return config.projects.find((p) => p.code === raw)?.name ?? '';
        case '费用项目': return config.expenseItems.find((p) => p.code === raw)?.name ?? '';
        case '费用金额':
        case '税额': return cents(raw) === null ? '' : money(cents(raw));
        default: return raw;
      }
    }

    function recalc(tr) {
      const net = cents(textOf(tr, 'detail', '费用金额'));
      const tax = cents(textOf(tr, 'detail', '税额')) ?? 0;
      const total = net === null ? '' : money(net + tax);
      setText(tr, 'detail', '申请报销金额', total);
      setText(tr, 'detail', '申请付款金额', total);
    }

    function updateTotals() {
      const footer = (name) => grid(name).querySelector('tr.k-footer-template');
      const detailSum = dataRows('detail').map((tr) => cents(textOf(tr, 'detail', '申请报销金额')));
      setText(footer('detail'), 'detail', '申请报销金额', detailSum.some((v) => v !== null) ? money(detailSum.reduce((a, v) => a + (v ?? 0), 0)) : '');
      const receiptSum = dataRows('receipts').map((tr) => cents(textOf(tr, 'receipts', '价税合计')) ?? 0);
      setText(footer('receipts'), 'receipts', '价税合计', receiptSum.length ? (receiptSum.reduce((a, v) => a + v, 0) / 100).toFixed(2) : '');
    }

    // `assumeReceiptLink`: committing 税额 links the row to the one unlinked 收票单 with the same net and tax.
    function linkReceipt(tr) {
      if (textOf(tr, 'detail', '收票单号')) return;
      const net = cents(textOf(tr, 'detail', '费用金额'));
      const tax = cents(textOf(tr, 'detail', '税额'));
      const linked = new Set(dataRows('detail').map((row) => textOf(row, 'detail', '收票单号')).filter(Boolean));
      const hits = dataRows('receipts').filter((row) => cents(textOf(row, 'receipts', '不含税金额')) === net
        && cents(textOf(row, 'receipts', '税额')) === tax && !linked.has(textOf(row, 'receipts', '收票单')));
      if (hits.length === 1) setText(tr, 'detail', '收票单号', textOf(hits[0], 'receipts', '收票单'));
    }

    function commitEditor() {
      if (!editor) return;
      const { td, tr, input, column, before } = editor;
      editor = null;
      const text = DATE_COLUMNS.has(column) ? kendoDate(String(input.value)) ?? before : display(column, String(input.value).trim());
      td.textContent = text;
      tr.classList.remove('k-grid-edit-row');
      mutate('cell', `${column}=${text}`);
      // Linked recalculation: a new 费用金额 clears 税额.
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

    function editCell(td) {
      const tr = td.parentElement;
      const column = DETAIL_COLUMNS[[...tr.children].indexOf(td)];
      if (READONLY_COLUMNS.has(column)) return;
      commitEditor();
      closeDropdown();
      tr.classList.add('k-grid-edit-row');
      if (column === '发票类型') {
        const span = td.querySelector('span') ?? td.appendChild(document.createElement('span'));
        span.setAttribute('tabindex', '0');
        span.focus();
        const list = document.createElement('ul');
        list.className = 'k-list';
        for (const option of INVOICE_TYPES) {
          const li = document.createElement('li');
          li.setAttribute('role', 'option');
          li.textContent = option;
          list.appendChild(li);
        }
        document.body.appendChild(list);
        dropdown = { td, tr, list, span };
        return;
      }
      const current = String(td.textContent).trim().replace(/^[¥￥]/, '');
      td.textContent = '';
      const input = document.createElement('input');
      if (DATE_COLUMNS.has(column)) input.setAttribute('data-role', 'datepicker');
      input.value = current;
      td.appendChild(input);
      input.focus();
      // The caret lands where the click landed, not at the end of the value (fake-erp.ts `editCell`).
      setCaret(input, Math.max(0, current.length - 1));
      editor = { td, tr, input, column, before: current };
    }

    function pickOption(text) {
      if (!dropdown) return;
      const { tr, span } = dropdown;
      const before = span.textContent;
      span.textContent = text;
      closeDropdown();
      mutate('option', `发票类型=${text}`);
      // Changing the invoice type clears an entered tax.
      if (before !== text) { setText(tr, 'detail', '税额', ''); recalc(tr); }
      updateTotals();
    }

    function defaultRow() {
      const tr = document.createElement('tr');
      tr.className = 'k-master-row';
      tr.innerHTML = DETAIL_COLUMNS.map((column) => (column === '收票单号' ? '<td><a class="disabled"></a></td>'
        : column === '发票类型' ? '<td><span class="k-input">普通发票</span></td>'
          : column === '开始日期' || column === '结束日期' ? `<td>${config.today}</td>` : '<td></td>')).join('');
      return tr;
    }

    function insertDetailRow() {
      const tbody = grid('detail').querySelector('tbody');
      tbody.insertBefore(defaultRow(), tbody.querySelector('tr.k-footer-template'));
      mutate('addRow', String(dataRows('detail').length));
    }

    function message(text) {
      const win = q('#message-window');
      win.querySelector('.k-window-message').textContent = text;
      show(win, true);
    }

    // 处理结果, painted whole at once (the default report of fake-erp.ts is complete one read after it opens).
    function result(summary, rows) {
      show(q('#result-window'), true);
      q('#result-window .k-window-message').textContent = [
        '打开 引出全部记录 引出失败记录 （您可以单击字段链接定位到所在位置）',
        summary,
        '设置 序号 设置 关键字 设置 状态 设置 问题描述',
        ...rows.map((row, index) => `${index + 1} ${row}`),
      ].join(' ');
    }

    // The 发票无忧助手 window, holding the assistant's cross-origin page: its own CDP target, as live.
    function openAssistant() {
      const win = q('#assistant-window');
      const frame = document.createElement('iframe');
      frame.src = config.assistantUrl;
      frame.style.cssText = 'display:block;width:800px;height:530px;border:0';
      win.appendChild(frame);
      show(win, true);
    }

    function closeAssistant() {
      const win = q('#assistant-window');
      win.querySelector('iframe')?.remove();
      show(win, false);
    }

    function importInvoices(shas) {
      const selected = shas.map((sha) => bySha.get(sha)).filter(Boolean);
      const tbody = grid('receipts').querySelector('tbody');
      const footer = tbody.querySelector('tr.k-footer-template');
      const imported = [];
      const report = [];
      for (const invoice of selected) {
        const masked = `${invoice.invoiceNumber.slice(0, 4)}************${invoice.invoiceNumber.slice(-4)}`;
        const values = [invoice.receiptNumber, masked, invoice.seller, invoice.issueDate, invoice.net, invoice.tax, invoice.gross, invoice.category];
        const tr = document.createElement('tr');
        tr.className = 'k-master-row';
        tr.innerHTML = values.map((value) => `<td>${escapeHtml(value)}</td>`).join('');
        tbody.insertBefore(tr, footer);
        report.push(`接收发票 成功 号码为【${invoice.invoiceNumber}】的发票接收成功，生成收票单【${invoice.receiptNumber}】`);
        imported.push(invoice.receiptNumber);
      }
      updateTotals();
      closeAssistant();
      result(`全部执行成功：${selected.length}`, report);
      mutate('import', imported.join(','));
    }

    function save() {
      commitEditor();
      closeDropdown();
      const purpose = String(q('[id$="-FCAUSA-EDITOR"]').value).trim();
      if (!purpose) { message('事由不能为空，保存失败'); return; }
      q('.form-tab').textContent = '费用报销单-修改';
      mutate('save', '');
    }

    function clickMain(el) {
      const assistantWindow = q('#assistant-window');
      if (!hidden(assistantWindow) && !assistantWindow.contains(el)) return; // the modal assistant swallows clicks
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
          show(q('#expense-list'), false);
          show(q('#expense-form'), true);
          q('#console-panel').classList.remove('k-state-active');
          q('#form-panel').classList.add('k-state-active');
          return undefined;
        case 'split-arrow':
          for (const item of document.querySelectorAll('a.kdmenuitem[data-mode]')) show(item, true);
          return undefined;
        case 'fill-entry':
          record.importMode = el.closest('[data-mode]').getAttribute('data-mode');
          for (const item of document.querySelectorAll('a.kdmenuitem[data-mode]')) show(item, false);
          return openAssistant();
        case 'new-row': return insertDetailRow();
        case 'save': return save();
        case 'close-window': {
          const win = el.closest('.k-window');
          return win.id === 'assistant-window' ? closeAssistant() : show(win, false);
        }
        default:
          if (el.matches('input') && String(el.id).endsWith('-EDITOR') && !el.readOnly) el.focus();
          return undefined;
      }
    }

    document.addEventListener('click', (event) => clickMain(event.target), true);
    document.addEventListener('keydown', (event) => {
      const active = document.activeElement;
      if (event.key === 'Enter' || event.key === 'Tab') {
        if (event.key === 'Tab') event.preventDefault();
        if (editor && active === editor.input) return commitEditor();
        if (active && String(active.id).endsWith('-EDITOR')) {
          active.blur();
          mutate('header', `${String(active.id).split('-').slice(-2, -1)[0]}=${active.value}`);
        }
        return undefined;
      }
      if (event.key === 'Escape') closeDropdown();
      return undefined;
    }, true);
    // 发票导入单据, clicked in the assistant: ERP answers on this page a moment later, as live.
    window.addEventListener('message', (event) => {
      if (event.origin !== config.assistantOrigin || event.data?.kind !== 'fake-erp-import') return;
      setTimeout(() => importInvoices(event.data.shas), 300);
    });
  }

  function assistant() {
    const ASSISTANT_COLUMNS = ['', '销方名称', '发票号码', '价税合计', '税额', '开票日期', '发票信息', '操作'];
    let activePane = null;
    const hex = (buffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');

    function showPane(label) {
      activePane = label;
      for (const tbody of document.querySelectorAll('tbody[data-pane]')) show(tbody, tbody.getAttribute('data-pane') === label);
      for (const tab of document.querySelectorAll('.ant-tabs-tab')) {
        tab.className = tab.getAttribute('data-pane') === label ? 'ant-tabs-tab-active ant-tabs-tab' : ' ant-tabs-tab';
      }
    }

    function paneOf(label) {
      const existing = document.querySelector(`tbody[data-pane="${label}"]`);
      if (existing) return existing;
      const tbody = document.createElement('tbody');
      tbody.setAttribute('data-pane', label);
      document.querySelector('.ant-table').appendChild(tbody);
      const tab = document.createElement('div');
      tab.className = 'ant-tabs-tab';
      tab.setAttribute('data-pane', label);
      document.querySelector('#assistant-tabs').appendChild(tab);
      showPane(document.querySelectorAll('tbody[data-pane]').length === 1 ? label : activePane);
      return tbody;
    }

    function refresh() {
      let uploaded = 0;
      for (const tbody of document.querySelectorAll('tbody[data-pane]')) {
        const label = tbody.getAttribute('data-pane');
        const count = tbody.querySelectorAll('tr').length;
        uploaded += count;
        document.querySelector(`.ant-tabs-tab[data-pane="${label}"]`).textContent = `${label} ${count}`;
      }
      document.querySelector('#assistant-selected').textContent = `已选取${uploaded}张发票 所有已选发票已选0份附件`;
    }

    // Recognition keys on the bytes' sha256, as in fake-erp.ts; a file it does not know is not recognised.
    function recognise(shas) {
      for (const sha of shas) {
        const invoice = bySha.get(sha);
        if (!invoice || document.querySelector(`tr[data-sha256="${sha}"]`)) continue;
        const tr = document.createElement('tr');
        tr.setAttribute('data-sha256', sha);
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
        paneOf(invoice.category).appendChild(tr);
      }
      refresh();
    }

    // The harness's hold point on the one irreversible click: a synchronous request, so the click's
    // `Input.dispatchMouseEvent` stays in flight for exactly as long as the harness keeps the answer back.
    function holdImportClick() {
      const request = new XMLHttpRequest();
      request.open('POST', '/__fake/import-click', false);
      request.send();
    }

    const input = document.querySelector('input[type=file]');
    input.addEventListener('change', async () => {
      const files = [...(input.files ?? [])];
      recognise(await Promise.all(files.map(async (file) => hex(await crypto.subtle.digest('SHA-256', await file.arrayBuffer())))));
    });

    document.addEventListener('click', (event) => {
      const el = event.target;
      const tab = el.closest('.ant-tabs-tab');
      if (tab) return showPane(String(tab.getAttribute('data-pane')));
      // The header 全选 is on the never-click list; the fake refuses it too.
      if (el.matches('input.ant-checkbox-input') && el.closest('thead')) return event.preventDefault();
      const action = el.closest('[data-action]')?.getAttribute('data-action');
      // 电脑端选取 leaves the entry menu for the upload view, in place.
      if (action === 'computer-picker') {
        event.preventDefault();
        show(document.querySelector('.fpzsHome'), false);
        show(document.querySelector('#assistant-upload'), true);
      }
      if (action === 'notice-ok') show(document.querySelector('#assistant-notice'), false);
      if (action === 'import') {
        holdImportClick();
        const shas = [...document.querySelectorAll('tbody tr')]
          .filter((tr) => tr.querySelector('input.ant-checkbox-input')?.checked)
          .map((tr) => tr.getAttribute('data-sha256'));
        window.parent.postMessage({ kind: 'fake-erp-import', shas }, config.erpOrigin);
      }
      return undefined;
    }, true);
  }
})();
