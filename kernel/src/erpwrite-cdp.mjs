import { autoAttach, clickAt, evalIn } from './chrome.mjs';
import { showSection } from './erpform.mjs';
import { invoiceUploadGroups } from './invoice-upload.mjs';
import { isCdpChromiumPage } from './chromium-cdp.mjs';

const pageRequired = () => {
  const error = new Error('ERP 写入需要已连接的 Chromium 页面');
  error.code = 'CHROMIUM_CDP_REQUIRED';
  return error;
};

const assertPage = (page) => {
  if (!isCdpChromiumPage(page)) throw pageRequired();
  return page.session;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (probe, predicate, timeoutMs, intervalMs = 300) => {
  const deadline = Date.now() + timeoutMs;
  let last = await probe();
  while (!predicate(last) && Date.now() < deadline) {
    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
    last = await probe();
  }
  return last;
};

const visible = `(n) => {
  const b = n.getBoundingClientRect();
  const s = getComputedStyle(n);
  return b.width > 0 && b.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
}`;

const textPoint = (text, { exact = true } = {}) => `(() => {
  const wanted = ${JSON.stringify(String(text))};
  const vis = ${visible};
  const nodes = [...document.querySelectorAll('body *')].filter((n) => {
    if (!vis(n) || n.children.length !== 0) return false;
    const value = String(n.textContent || '').replace(/\\s+/g, ' ').trim();
    return ${exact ? 'value === wanted' : 'value.includes(wanted)'};
  });
  if (nodes.length !== 1) return { ok: false, count: nodes.length };
  const b = nodes[0].getBoundingClientRect();
  return { ok: true, x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
})()`;

const cssPoint = (selector) => `(() => {
  const vis = ${visible};
  const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})].filter(vis);
  if (nodes.length !== 1) return { ok: false, count: nodes.length };
  const b = nodes[0].getBoundingClientRect();
  return { ok: true, x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
})()`;

async function clickPoint(session, expression, label) {
  const point = await evalIn(session, expression);
  if (!point?.ok) {
    const error = new Error(`${label}不可唯一定位（匹配 ${point?.count ?? 0} 个）`);
    error.code = 'CHROMIUM_TARGET_NOT_UNIQUE';
    throw error;
  }
  await clickAt(session, point.x, point.y);
  return point;
}

async function clickText(session, text, options = {}) {
  const point = await waitFor(
    () => evalIn(session, textPoint(text, options)),
    (result) => result?.ok === true,
    options.timeoutMs ?? 15_000,
  );
  if (!point?.ok) {
    const error = new Error(`找不到唯一的「${text}」按钮或菜单项`);
    error.code = 'CHROMIUM_TARGET_NOT_FOUND';
    throw error;
  }
  await clickAt(session, point.x, point.y);
  return point;
}

async function clickCss(session, selector, label) {
  return clickPoint(session, cssPoint(selector), label);
}

const containsText = (needle) => `(document.body?.innerText || '').includes(${JSON.stringify(needle)})`;

const waitText = (session, needle, timeoutMs = 15_000) => waitFor(
  () => evalIn(session, containsText(needle)), Boolean, timeoutMs,
);

const waitVisibleText = async (session, text, timeoutMs = 15_000) => {
  const point = await waitFor(
    () => evalIn(session, textPoint(text)),
    (result) => result?.ok === true,
    timeoutMs,
  );
  return point?.ok === true;
};

async function assistantPage(page, timeoutMs = 45_000) {
  const session = assertPage(page);
  page.children ??= await autoAttach(session);
  const child = await page.children.waitFor((url) => url.includes('piaozone'), { timeout: timeoutMs });
  if (!child) {
    const error = new Error('发票无忧助手没有建立 Chromium 页面连接');
    error.code = 'INVOICE_ASSISTANT_NOT_FOUND';
    throw error;
  }
  return child;
}

/** Navigate from the current ERP session to one unique new reimbursement form. */
export async function openNewReimbursement(page, { timeoutMs = 45_000 } = {}) {
  const session = assertPage(page);
  const has = (text) => waitVisibleText(session, text, 1200);
  if (await has('费用报销单-新增')) {
    await clickText(session, '费用报销单-新增', { timeoutMs });
  } else if (await has('我的费用报销')) {
    await clickText(session, '我的费用报销', { timeoutMs });
    await clickText(session, '新增', { timeoutMs });
  } else {
    await clickCss(session, '.kd_SystemMenu', 'ERP 主菜单');
    await clickText(session, '员工服务', { timeoutMs });
    await clickText(session, '我的费用报销', { timeoutMs });
    await clickText(session, '新增', { timeoutMs });
  }
  await waitVisibleText(session, '费用报销单-新增', timeoutMs);
  return { ok: true, form: '费用报销单-新增' };
}

/** Open the fixed no-expense-generation invoice assistant entry. */
export async function openInvoiceAssistant(page, { timeoutMs = 90_000 } = {}) {
  const session = assertPage(page);
  page.children ??= await autoAttach(session);
  const section = await showSection(session, '收票信息');
  if (!section.ok) {
    const error = new Error(section.reason);
    error.code = 'INVOICE_ASSISTANT_ENTRY_NOT_FOUND';
    throw error;
  }
  await clickCss(session,
    'div[id*="FRECINVINFO_ENTRYBAR-tbReceiveInv_wrapper"] > a.k-split-button-arrow',
    '选择发票下拉按钮');
  await sleep(1200);
  const menuVisible = await evalIn(session, `(() => {
    const vis = ${visible};
    return [...document.querySelectorAll('a[id$="tbNotFillEntry"]')].some(vis);
  })()`);
  if (!menuVisible) {
    await evalIn(session, `(() => {
      const wrapper = document.querySelector('div[id*="FRECINVINFO_ENTRYBAR-tbReceiveInv_wrapper"]');
      const split = wrapper && window.jQuery?.(wrapper).data()?.splitButton;
      if (!split || typeof split.toggle !== 'function') return false;
      split.toggle();
      return true;
    })()`);
    await sleep(300);
  }
  await clickText(session, '不生成费用明细', { timeoutMs });
  await sleep(1200);
  await assistantPage(page, timeoutMs);
  return { ok: true, mode: '不生成费用明细' };
}

const fileInput = async (session, files) => {
  await session.send('DOM.enable');
  const { root } = await session.send('DOM.getDocument', { depth: -1, pierce: true });
  const { nodeId } = await session.send('DOM.querySelector', {
    nodeId: root.nodeId, selector: 'input[type=file]',
  });
  if (!nodeId) {
    const error = new Error('发票助手中找不到文件上传控件');
    error.code = 'INVOICE_FILE_INPUT_NOT_FOUND';
    throw error;
  }
  await session.send('DOM.setFileInputFiles', { nodeId, files });
};

const dataCheckboxes = (session) => evalIn(session, `(() => {
  const vis = ${visible};
  return [...document.querySelectorAll('input.ant-checkbox-input')]
    .filter((n) => vis(n) && !n.closest('thead'))
    .map((n) => {
      const b = n.getBoundingClientRect();
      return { checked: n.checked, x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
    });
})()`);

const uploadState = (session) => evalIn(session, `(() => {
  const vis = ${visible};
  const rows = [...document.querySelectorAll('input.ant-checkbox-input')]
    .filter((n) => vis(n) && !n.closest('thead'));
  return {
    processing: (document.body?.innerText || '').includes('上传处理中'),
    rows: rows.map((n) => ({ checked: n.checked })),
  };
})()`);

const selectionError = (message, code) => {
  const error = new Error(message);
  error.code = code;
  return error;
};

/** Upload, select, and import invoice files through the common Chromium protocol. */
export async function uploadAndImportInvoices(page, paths = [], { timeoutMs = 210_000 } = {}) {
  const session = assertPage(page);
  if (!Array.isArray(paths) || paths.length === 0) {
    const error = new Error('没有可上传的主要发票文件');
    error.code = 'INVOICE_FILES_REQUIRED';
    throw error;
  }
  const groups = invoiceUploadGroups(paths);
  const assistant = await assistantPage(page, Math.min(timeoutMs, 45_000));
  const existing = await dataCheckboxes(assistant);
  if (existing.length > 0) {
    throw selectionError(
      '发票助手中已有未归属的发票行，拒绝把它们混入当前任务',
      'INVOICE_ASSISTANT_NOT_EMPTY',
    );
  }
  if (!await waitText(assistant, '上传发票影像', 3000)) {
    await clickText(assistant, '上传发票影像', { timeoutMs: 15_000 });
  }
  for (const files of groups) {
    await fileInput(assistant, files);
    const rows = await waitFor(
      () => uploadState(assistant),
      (value) => Array.isArray(value?.rows) && value.rows.length > 0 && !value.processing,
      90_000,
    );
    if (!Array.isArray(rows?.rows) || rows.rows.length === 0) {
      throw selectionError('发票助手没有返回可勾选的识别结果', 'INVOICE_SELECTION_EMPTY');
    }
    if (rows.rows.some((row) => row.checked)) {
      throw selectionError(
        '发票助手返回了预先勾选的识别结果，拒绝继续导入',
        'INVOICE_SELECTION_PRESELECTED',
      );
    }
  }
  const rows = await dataCheckboxes(assistant);
  if (rows.some((row) => row.checked)) {
    throw selectionError(
      '发票助手返回了预先勾选的识别结果，拒绝继续导入',
      'INVOICE_SELECTION_PRESELECTED',
    );
  }
  let selected = 0;
  for (const row of rows) {
    await clickAt(assistant, row.x, row.y);
    const checked = await waitFor(
      () => dataCheckboxes(assistant),
      (value) => Array.isArray(value) && value.filter((item) => item.checked).length >= selected + 1,
      5000,
    );
    if (!Array.isArray(checked) || checked.filter((item) => item.checked).length < selected + 1) {
      const error = new Error('发票识别结果没有确认勾选，拒绝继续导入');
      error.code = 'INVOICE_SELECTION_UNCONFIRMED';
      throw error;
    }
    selected += 1;
  }
  if (!selected) {
    throw selectionError('发票助手没有可导入的识别结果', 'INVOICE_SELECTION_EMPTY');
  }
  await clickText(assistant, '发票导入单据', { timeoutMs: 15_000 });
  await clickText(assistant, '不生成费用明细', { timeoutMs: 45_000 });
  await waitText(session, '收票信息', 120_000);
  return { ok: true, selectedRows: rows.length };
}

export async function addDetailRow(page) {
  const session = assertPage(page);
  await clickCss(session, 'a[id$="tbNewList"]', '新增明细行');
  return { ok: true };
}

export async function saveReimbursement(page) {
  const session = assertPage(page);
  await clickText(session, '保存', { timeoutMs: 15_000 });
  return { ok: true };
}

export async function closeInvoiceAssistant(page) {
  const session = assertPage(page);
  try {
    await clickCss(session, 'a[aria-label="Close"]', '关闭发票助手');
    return { ok: true };
  } catch {
    return { ok: false };
  }
}
