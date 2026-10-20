import { describe, expect, it } from 'vitest';
import { SIGN_IN_TIMING, signInWith, type LoginLook, type SignInPorts } from './sign-in';
import type { Reach } from './hit';

const reach: Reach = { x: 10, y: 10, inView: true, onTarget: true, cover: null };

const loginPage = (over: Partial<LoginLook> = {}): LoginLook => ({
  verdict: 'not_logged_in', onMainConsole: false, form: true, dataCentreReady: true, languageMissing: null, alreadyOnline: null,
  secondFactor: [], errors: [], requests: 40, ...over,
});
const console_: LoginLook = { ...loginPage(), verdict: 'matched', onMainConsole: true, form: false };

/**
 * A login page on a virtual clock. `afterSubmit(n)` says what the page shows after the n-th submit (1-based); the
 * page stays on it until something else changes it.
 */
function scriptedPage(start: LoginLook | null, afterSubmit: (n: number, page: LoginLook | null) => LoginLook | null, afterReload: (n: number, page: LoginLook | null) => LoginLook | null = (_n, p) => p) {
  let t = 0;
  let page = start;
  const log: string[] = [];
  let submits = 0;
  const ports: SignInPorts = {
    look: async () => page,
    submit: async () => {
      if (!page?.form) return false;
      submits += 1;
      log.push(`submit ${submits}`);
      page = afterSubmit(submits, page);
      return true;
    },
    confirm: async (_reach, label) => {
      log.push(`confirm ${label}`);
      if (label.includes('语言未加载')) page = loginPage({ requests: (page?.requests ?? 0) + 5 });
      if (label.includes('已登录在线')) page = console_;
    },
    reload: async () => { log.push('reload'); page = afterReload(log.filter((l) => l === 'reload').length, page); },
    prefetch: async () => { log.push('prefetch'); },
    now: () => t,
    sleep: async (ms) => { t += ms; },
  };
  return { ports, log, get submits() { return submits; }, get t() { return t; } };
}

describe('signing in to ERP', () => {
  it('does nothing on a page that is already the console', async () => {
    const page = scriptedPage(console_, () => console_);
    expect(await signInWith(page.ports)).toMatchObject({ ok: true, submitted: false });
    expect(page.log).toEqual([]);
  });

  it('waits for the page to settle, fetches the console scripts, submits once and reaches the console', async () => {
    const page = scriptedPage(loginPage(), () => console_);
    expect(await signInWith(page.ports)).toMatchObject({ ok: true, submitted: true });
    expect(page.log).toEqual(['prefetch', 'submit 1']);
  });

  it('never submits a refused login again, so the ERP account cannot be locked', async () => {
    const page = scriptedPage(loginPage(), () => loginPage({ errors: ['用户名或密码错误'], requests: 41 }));
    const outcome = await signInWith(page.ports);
    expect(outcome).toMatchObject({ ok: false, code: 'erp_sign_in_refused' });
    expect(outcome.ok === false && outcome.message).toMatch(/不会再用它重试/);
    expect(page.submits).toBe(1);
  });

  it('confirms 「语言未加载」 and submits again', async () => {
    const page = scriptedPage(loginPage(), (n) => (n === 1 ? loginPage({ languageMissing: { text: '金蝶提示：语言未加载。', reach }, requests: 41 }) : console_));
    expect(await signInWith(page.ports)).toMatchObject({ ok: true });
    expect(page.log).toEqual(['prefetch', 'submit 1', 'confirm 「语言未加载」的确定', 'submit 2']);
  });

  it('confirms 「该帐号已登录在线」 once, knocking the other session off', async () => {
    const page = scriptedPage(loginPage(), () => loginPage({ form: false, alreadyOnline: { text: '该帐号已登录在线', reach }, requests: 41 }));
    expect(await signInWith(page.ports)).toMatchObject({ ok: true });
    expect(page.log).toEqual(['prefetch', 'submit 1', 'confirm 「该帐号已登录在线」的确认']);
  });

  it('submits again when the click started no request at all', async () => {
    const page = scriptedPage(loginPage(), (n, before) => (n === 1 ? before : console_));
    expect(await signInWith(page.ports)).toMatchObject({ ok: true });
    expect(page.submits).toBe(2);
    expect(page.t).toBeGreaterThan(SIGN_IN_TIMING.noEffectMs);
  });

  it('stops on a second factor that appeared after submitting', async () => {
    const page = scriptedPage(loginPage(), () => loginPage({ secondFactor: ['input#smscode'], requests: 41 }));
    expect(await signInWith(page.ports)).toMatchObject({ ok: false, code: 'erp_sign_in_second_factor' });
    expect(page.submits).toBe(1);
  });

  it('stops when the login form never appears, having loaded the entry page again twice', async () => {
    const page = scriptedPage(loginPage({ form: false }), (_n, p) => p);
    expect(await signInWith(page.ports)).toMatchObject({ ok: false, code: 'erp_sign_in_no_form' });
    expect(page.submits).toBe(0);
    expect(page.log).toEqual(['reload', 'reload']);
    expect(page.t).toBeLessThanOrEqual(SIGN_IN_TIMING.formMs + SIGN_IN_TIMING.pollMs);
  });

  // Live 2026-10-20 2 of 21 sign-ins met an entry page whose body stayed empty for 90 s (once a timed-out load);
  // loading the entry page again brought the form in 2-30 s.
  it('loads the entry page again when no login form has come, and signs in on the one that comes', async () => {
    const blank = loginPage({ verdict: 'unknown', form: false, dataCentreReady: false });
    const page = scriptedPage(blank, () => console_, () => loginPage());
    expect(await signInWith(page.ports)).toMatchObject({ ok: true, submitted: true });
    expect(page.log).toEqual(['reload', 'prefetch', 'submit 1']);
  });
});
