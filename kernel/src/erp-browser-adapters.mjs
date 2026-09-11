import * as egoWrite from './erpwrite-ego.mjs';
import * as cdpWrite from './erpwrite-cdp.mjs';
import * as egoForm from './erpform-ego.mjs';
import * as cdpForm from './erpform.mjs';
import { isCdpChromiumPage } from './chromium-cdp.mjs';

const unsupportedPage = () => {
  const error = new Error('ERP 写入需要 ego 或已连接的 Chromium 页面；不会回退到其他浏览器');
  error.code = 'CHROMIUM_AUTOMATION_REQUIRED';
  return error;
};

const cdpFormAdapter = Object.freeze({
  formTabs: (page) => cdpForm.formTabs(page.session),
  writeHeader: (page, key, value, options) =>
    cdpForm.writeHeader(page.session, key, value, options),
  writeCell: (page, options) => cdpForm.writeCell(page.session, options),
  selectOption: (page, options) => cdpForm.selectOption(page.session, options),
  leaveEdit: (page, options) => cdpForm.leaveEdit(page.session, options),
});

/** Select a connection adapter, never a browser-brand-specific ERP workflow. */
export function erpWriteAdapterFor(page) {
  if (page?.transport === 'ego') return egoWrite;
  if (isCdpChromiumPage(page)) return cdpWrite;
  throw unsupportedPage();
}

export function erpFormAdapterFor(page) {
  if (page?.transport === 'ego') return egoForm;
  if (isCdpChromiumPage(page)) return cdpFormAdapter;
  throw unsupportedPage();
}

export function isChromiumWritePage(page) {
  return page?.transport === 'ego' || isCdpChromiumPage(page);
}
