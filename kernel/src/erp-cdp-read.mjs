import { evalIn } from './chrome.mjs';
import { readFormTabs, readHeaderField, readGridByColumn, readErpForm } from './erpread.mjs';
import { isCdpChromiumPage } from './chromium-cdp.mjs';

const assertPage = (page) => {
  if (!isCdpChromiumPage(page)) {
    const error = new Error('ERP Chromium 回读需要已连接的 CDP 页面');
    error.code = 'CHROMIUM_CDP_REQUIRED';
    throw error;
  }
  return page.session;
};

const evaluate = (page, expression, options = {}) => {
  assertPage(page);
  return evalIn(page.session, expression, { timeout: options.timeoutMs ?? 15_000 });
};

export const cdpReadOptions = Object.freeze({
  readTabs: (page) => readFormTabs(page, { evaluate }),
  readHeader: (page, key) => readHeaderField(page, key, { evaluate }),
  readGrid: (page, column) => readGridByColumn(page, column, { evaluate }),
});

export const readCdpErpForm = (page) => readErpForm(page, { evaluate });
