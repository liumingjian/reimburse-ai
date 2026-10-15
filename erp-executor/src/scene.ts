import { evalIn, type CdpSession } from './cdp';

/**
 * The page as it stood when a navigation click failed (opening the 新增单): how many nodes carry each caption of the
 * menu path (all and visible, with the visible ones' tag, class, parent class, form id, tab panel and box), whether the main menu exists
 * and is shown, what floats over the page, and the tab strip. ERP's own captions and counts only, never business text,
 * so it may go into a log. Live 2026-10-12 a run refused to click one of two visible 新增 and nothing showed why.
 */
export const NAVIGATION_SCENE = `(() => {
  const vis = (n) => { const b = n.getBoundingClientRect(); const st = getComputedStyle(n); return b.width > 0 && b.height > 0 && st.visibility !== 'hidden' && st.display !== 'none'; };
  const leaves = (text) => [...document.querySelectorAll('body *')].filter((n) => n.children.length === 0 && String(n.textContent || '').replace(/\\s+/g, ' ').trim() === text);
  const box = (n) => { const b = n.getBoundingClientRect(); return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)]; };
  const captions = {};
  for (const text of ['员工服务', '我的费用报销', '新增', '费用报销单-新增']) {
    const all = leaves(text);
    const shown = all.filter(vis);
    captions[text] = { all: all.length, visible: shown.length, shown: shown.slice(0, 4).map((n) => ({ tag: n.tagName, cls: String(n.className || '').slice(0, 60), parent: String(n.parentElement?.className || '').slice(0, 60), form: n.closest('[data-kdformid]')?.getAttribute('data-kdformid') || null, panel: String(n.closest('.k-content')?.id || '').slice(0, 60) || null, box: box(n) })) };
  }
  const menus = [...document.querySelectorAll('.kd_SystemMenu')];
  const floating = [...document.querySelectorAll('.k-window, .k-overlay, [class*="mask"], [class*="loading"], [class*="modal"]')].filter(vis)
    .slice(0, 8).map((n) => ({ cls: String(n.className || '').slice(0, 60), box: box(n) }));
  const tabs = [...document.querySelectorAll('[class*="tabstrip"] li, .k-tabstrip-items li')].map((n) => String(n.textContent || '').trim().slice(0, 20)).slice(0, 12);
  const passwords = [...document.querySelectorAll('input[type="password"]')];
  return { path: location.pathname, title: document.title.slice(0, 40), passwordInputs: { all: passwords.length, visible: passwords.filter(vis).length },
    ready: document.readyState, sinceLoadMs: Math.round(performance.now()), captions,
    systemMenu: { all: menus.length, visible: menus.filter(vis).length }, floating, tabs };
})()`;

export const navigationScene = (session: CdpSession) => evalIn(session, NAVIGATION_SCENE);
