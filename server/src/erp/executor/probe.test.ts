// Origin: 50931a3:kernel/test/probe.test.mjs (translated to Vitest; inputs and expected outputs kept).
// Observations come from a read-only probe of K3Cloud 8.2.0 on 2026-09-05: the login page and the main console
// share one URL, so the samples differ only in DOM signals.
import { describe, expect, it } from 'vitest';
import { identityFromObservation, probeIdentity, sameOrigin, type Observation } from './probe';

const loginPage: Observation = {
  url: 'http://erp.antute.com.cn/k3cloud/html5/index.aspx',
  ready: 'complete',
  title: '金蝶云星空',
  displayName: null,
  // After logout localStorage still holds the last account: a measured fact.
  account: 'luo.liu',
  tenant: '5f1f13f6dde29e',
  onMainConsole: false,
  loginFormVisible: true,
};

const console_: Observation = { ...loginPage, displayName: '刘明建', onMainConsole: true, loginFormVisible: false };

const defaultPage = {
  transport: 'default', browserBundleId: 'com.google.Chrome', browserFamily: 'chromium',
  windowId: '7', tabId: '11', index: 0, url: 'http://erp.antute.com.cn/k3cloud/html5/index.aspx',
  origin: 'http://erp.antute.com.cn', pageId: '11',
};

describe('ERP login probe (登录探测)', () => {
  it('reports the login page as not logged in, not as an unreadable identity', () => {
    const r = identityFromObservation(loginPage)!;
    expect(r.status).toBe('not_logged_in');
    expect('hint' in r && r.hint).toMatch(/登录页/);
  });

  it('does not count the account readable on the login page as a logged-in identity', () => {
    const r = identityFromObservation(loginPage)!;
    expect(r.status).toBe('not_logged_in');
    expect((r as { identity?: unknown }).identity).toBeUndefined();
  });

  it('treats no user name and no login form as an unknown state for a person to look at', () => {
    expect(identityFromObservation({ ...loginPage, loginFormVisible: false })!.status).toBe('unknown');
  });

  it('reads the session fact on the main console: who is logged in, with account and 账套', () => {
    const r = identityFromObservation(console_)!;
    expect(r.status).toBe('matched');
    expect(r.status === 'matched' && r.identity).toEqual({ displayName: '刘明建', account: 'luo.liu', tenant: '5f1f13f6dde29e' });
  });

  it('is not matched on the console without account or 账套', () => {
    for (const missing of [{ account: null }, { tenant: null }]) {
      const r = identityFromObservation({ ...console_, ...missing })!;
      expect(r.status).toBe('unknown');
      expect('hint' in r && r.hint).toMatch(/身份不能确定/);
    }
  });

  it('does not judge whether this person should file the reimbursement', () => {
    expect(identityFromObservation({ ...console_, displayName: '张三', account: 'zhang.san' })!.status).toBe('matched');
  });

  it('draws no conclusion before the page has loaded', () => {
    expect(identityFromObservation({ ...loginPage, ready: 'loading' })).toBeNull();
  });

  it('keeps the typed page identity and the origin transport of the default-browser probe', async () => {
    const result = await probeIdentity({
      origin: 'http://erp.antute.com.cn', waitMs: 0, transport: { transport: 'default' },
      listTabs: async (options) => {
        expect(options.origin).toBe('http://erp.antute.com.cn');
        expect((options.transport as { transport: string }).transport).toBe('default');
        return [defaultPage];
      },
      evaluate: async (received, expression, options) => {
        expect(received).toBe(defaultPage);
        expect(options.origin).toBe('http://erp.antute.com.cn');
        expect(expression).toMatch(/k3cloudloginInfo/);
        return { ...console_, url: defaultPage.url };
      },
    });
    expect(result.status).toBe('matched');
    expect(result.transport).toBe('default');
    expect(result.targetId).toBe('11');
    expect(result.page).toBe(defaultPage);
  });

  it('never picks one of several default-browser ERP pages', async () => {
    const pages = [defaultPage, { ...defaultPage, windowId: '8', tabId: '21', pageId: '21' }];
    let evaluated = 0;
    const result = await probeIdentity({
      origin: 'http://erp.antute.com.cn', waitMs: 0, transport: { transport: 'default' },
      listTabs: async () => pages,
      evaluate: async () => { evaluated += 1; return console_; },
    });
    expect(result.status).toBe('unknown');
    expect(result.transport).toBe('default');
    expect(result.pageCount).toBe(2);
    expect(result.hint).toMatch(/发现 \d+ 个 ERP 页面/);
    expect(result.hint).toMatch(/保留唯一/);
    expect(evaluated, 'must not read and pick the first of several pages').toBe(0);
  });

  it('does not turn a JS/automation permission error into "not logged in"', async () => {
    await expect(probeIdentity({
      origin: 'http://erp.antute.com.cn', waitMs: 0, transport: { transport: 'default' },
      listTabs: async () => [{ ...defaultPage }],
      evaluate: async () => { throw Object.assign(new Error('Allow JavaScript from Apple Events'), { code: 'DEFAULT_BROWSER_JAVASCRIPT_PERMISSION_REQUIRED' }); },
    })).rejects.toMatchObject({ code: 'DEFAULT_BROWSER_JAVASCRIPT_PERMISSION_REQUIRED' });
  });

  it('filters ERP tabs by exact origin, refusing a same-prefix fake domain', () => {
    expect(sameOrigin('http://erp.antute.com.cn/k3cloud/html5/index.aspx', 'http://erp.antute.com.cn')).toBe(true);
    expect(sameOrigin('http://erp.antute.com.cn.attacker.test/k3cloud/html5/index.aspx', 'http://erp.antute.com.cn')).toBe(false);
    expect(sameOrigin('https://erp.antute.com.cn/k3cloud/html5/index.aspx', 'http://erp.antute.com.cn')).toBe(false);
  });
});
