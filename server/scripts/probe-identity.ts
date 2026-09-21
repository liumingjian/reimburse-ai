// Throwaway read-only probe: why does `probeIdentity` read no user name on a hand-logged-in ERP console?
// It evaluates read expressions only; it never navigates, clicks or calls a business service.
// Identity strings are masked here: the probe reports structure, not the person or the account.
import { connect, evalIn, targets } from '../src/erp/executor/cdp';
import { cdpPortOf, safeUrl } from '../src/erp/executor/chromium';
import { READ_ONLY_SNIPPET, identityFromObservation } from '../src/erp/executor/probe';

const SNIPPET = `(() => {
  const mask = (v) => { if (v === null || v === undefined) return null; const s = String(v); if (!s.length) return '<empty>'; return s.length <= 2 ? '*'.repeat(s.length) : s[0] + '*'.repeat(Math.max(1, s.length - 2)) + s[s.length - 1]; };
  const vis = (n) => { const r = n.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const own = (n) => [...n.childNodes].filter((c) => c.nodeType === 3).map((c) => c.textContent.trim()).join('').trim();
  const desc = (n) => ({ tag: n.tagName, cls: String(n.className || '').slice(0, 80), id: n.id || null, vis: vis(n), text: mask(own(n)), len: own(n).length });

  const scan = (doc, path) => {
    const out = { path, url: null, ready: null, err: null };
    try {
      out.url = (doc.location.origin || '') + (doc.location.pathname || '');
      out.ready = doc.readyState;
      out.exactSelector = doc.querySelectorAll('span.kd-mainconsole-usernametext').length;
      out.anyUsernameClass = [...doc.querySelectorAll('*')]
        .filter((n) => /username|usertext|user-name/i.test(String(n.className || '')) || /username|user-name/i.test(String(n.id || '')))
        .slice(0, 12).map(desc);
      out.mainconsoleClass = [...doc.querySelectorAll('[class*=mainconsole]')].slice(0, 12)
        .map((n) => String(n.className || '').slice(0, 90));
      out.userishVisible = [...doc.querySelectorAll('*')].filter(vis)
        .filter((n) => /user|person|avatar|login|head|account/i.test(String(n.className || '') + ' ' + String(n.id || '')))
        .slice(0, 20).map(desc);
      const pw = [...doc.querySelectorAll('input[type=password]')];
      out.passwordInputs = { total: pw.length, visible: pw.filter(vis).length };
      out.loginFormVisible = pw.some(vis) && [...doc.querySelectorAll('button, input[type=submit]')]
        .some((n) => vis(n) && /登\\s*录|sign\\s*in|log\\s*in/i.test(n.textContent || n.value || ''));
      out.frames = [...doc.querySelectorAll('iframe, frame')].map((f) => {
        let reachable = false;
        try { reachable = !!f.contentDocument; } catch {}
        return { src: String(f.getAttribute('src') || '').split('?')[0].slice(0, 90), vis: vis(f), reachable, id: f.id || null };
      });
    } catch (e) { out.err = String((e && e.message) || e); }
    return out;
  };

  const docs = [scan(document, 'top')];
  const walk = (doc, path, depth) => {
    if (depth > 3) return;
    for (const f of [...doc.querySelectorAll('iframe, frame')]) {
      let inner = null;
      try { inner = f.contentDocument; } catch {}
      if (!inner) continue;
      const p = path + ' > ' + (f.id || f.getAttribute('name') || String(f.getAttribute('src') || '').split('?')[0].slice(-40));
      docs.push(scan(inner, p));
      walk(inner, p, depth + 1);
    }
  };
  try { walk(document, 'top', 0); } catch {}

  let stored = null; let storedErr = null;
  try { const raw = localStorage.getItem('k3cloudloginInfo'); stored = raw ? JSON.parse(raw) : null; } catch (e) { storedErr = String((e && e.message) || e); }
  const storedShape = stored && typeof stored === 'object'
    ? Object.fromEntries(Object.entries(stored).map(([k, v]) => [k, v === null || v === undefined || v === '' ? '<empty>' : (typeof v === 'object' ? '<object>' : mask(v))]))
    : stored;

  return {
    kdResVer: String(window.KDResVer || ''),
    localStorageKeys: (() => { try { return Object.keys(localStorage).slice(0, 40); } catch { return ['<denied>']; } })(),
    k3cloudloginInfo: storedShape, k3cloudloginInfoErr: storedErr,
    docs,
  };
})()`;

const port = cdpPortOf();
const all = await targets(port);
console.log('== all CDP targets ==');
for (const t of all) console.log(JSON.stringify({ type: t.type, url: safeUrl(t.url), title: String(t.title || '').slice(0, 40), id: String(t.id || '').slice(0, 8) }));

const erpTargets = all.filter((t) => String(t.url).includes('erp.antute.com.cn') && t.webSocketDebuggerUrl);
console.log('\n== erp-origin targets: %d ==', erpTargets.length);
for (const t of erpTargets) {
  console.log('\n--- target %s type=%s url=%s', String(t.id || '').slice(0, 8), t.type, safeUrl(t.url));
  const session = await connect(t.webSocketDebuggerUrl!);
  try {
    const obs: any = await evalIn(session, READ_ONLY_SNIPPET);
    const masked = {
      ...obs,
      displayName: obs?.displayName ? `<len ${String(obs.displayName).length}>` : obs?.displayName,
      account: obs?.account ? `<len ${String(obs.account).length}>` : obs?.account,
      tenant: obs?.tenant ? `<len ${String(obs.tenant).length}>` : obs?.tenant,
    };
    console.log('READ_ONLY_SNIPPET:', JSON.stringify(masked));
    console.log('verdict:', JSON.stringify(identityFromObservation(obs, { transport: 'chromium-cdp' })?.status ?? null));
    console.log('detail:', JSON.stringify(await evalIn(session, SNIPPET), null, 1));
  } catch (error: any) {
    console.log('eval failed:', error?.message ?? String(error));
  } finally { session.close(); }
}
