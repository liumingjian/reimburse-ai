// Fills and submits the ERP login form. The recorder, the live harness (server/scripts/test-erp-live.ts), probe-login.ts
// and the headless path's `sign-in.ts` (ADR-0033) all sign in with this one snippet; on the extension path the employee
// logs in themselves. The secret goes into the page it authenticates and nowhere else.
//
// Measured on 金蝶云星空 8.2.0.20250701: the login page carries #user (account) and #password, plus a second visible
// #CAuser for certificate login that must not be mistaken for the account box. Ids first, shape as fallback. The
// form is plain HTML, so a native-setter write plus input/change is enough.

export const signInSnippet = (user: string, secret: string) => `(() => {
  const seen = (el) => !!el && (() => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; })();
  const byId = (id) => { const el = document.getElementById(id); return seen(el) ? el : null; };
  const secretBox = byId('password') || [...document.querySelectorAll('input[type=password]')].filter(seen)[0];
  if (!secretBox) return { ok: false, why: 'no visible password input' };
  const userBox = byId('user') || [...document.querySelectorAll('input')].filter((el) => el !== secretBox && seen(el) && !/^(checkbox|radio|hidden|submit|button|file)$/i.test(el.type))[0];
  if (!userBox) return { ok: false, why: 'no visible account input' };
  const put = (el, value) => {
    el.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  put(userBox, ${JSON.stringify(user)});
  put(secretBox, ${JSON.stringify(secret)});
  const button = [...document.querySelectorAll('button, a, input[type=submit], div[role=button]')].filter(seen)
    .find((el) => ((el.innerText || el.value || '').trim() === '登录'));
  if (!button) return { ok: false, why: 'no visible 登录 button' };
  button.click();
  return { ok: true };
})()`;
