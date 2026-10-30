import { EmployeeProfileResultSchema } from '@baox/contract';
import { evalIn, type CdpSession } from './cdp';
import { HIT_JS, clickReach, type Reach } from './hit';
import { waitFor } from './pace';
import { READ_ONLY_SNIPPET, type Observation } from './probe';

export const EMPLOYEE_INFORMATION_SNIPPET = `(() => {
  const shown = n => { const r = n.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(n).display !== 'none'; };
  const names = [...document.querySelectorAll('[id$="-FNAMELABLE"]')].filter(shown);
  if (names.length !== 1) return null;
  const node = names[0];
  const prefix = node.id.slice(0, -'FNAMELABLE'.length);
  const departments = [...document.querySelectorAll('[id]')].filter(n => n.id.startsWith(prefix) && /^FLABEL\\d+DEP$/.test(n.id.slice(prefix.length)) && shown(n));
  const name = node.textContent.trim().replace(/[（(].*$/, '').trim();
  const department = departments.at(-1)?.textContent.trim() || '';
  return { name, department, appointments: departments.length };
})()`;

async function press(session: CdpSession, selector: string, label: string) {
  const reach = await waitFor(() => evalIn<Reach | null>(session, `(() => { const n = [...document.querySelectorAll(${JSON.stringify(selector)})].find(n => n.getBoundingClientRect().width > 0); return n ? (${HIT_JS})(n) : null; })()`), r => !!r?.onTarget, 10_000, 200);
  await clickReach(session, reach, label);
}

export async function readEmployeeProfile(session: CdpSession) {
  try {
    if (!await evalIn(session, EMPLOYEE_INFORMATION_SNIPPET)) {
      await press(session, 'a[id$="-FBTNUSER-FBTNUSER"]', '用户菜单');
      await press(session, 'span[id$="-FBTNUSER-tbPersonInfo"]', '个人信息');
    }
    const data = await waitFor(() => evalIn<{ name: string; department: string; appointments: number } | null>(session, EMPLOYEE_INFORMATION_SNIPPET), d => !!d?.name && !!d.department, 10_000, 200);
    const identity = await evalIn<Observation>(session, READ_ONLY_SNIPPET);
    return EmployeeProfileResultSchema.parse({ status: 'ready', erpAccount: identity?.account, tenant: identity?.tenant, name: data?.name, department: data?.department });
  } catch {
    return EmployeeProfileResultSchema.parse({ status: 'failed', message: '无法读取 ERP 个人信息中的姓名或末条任职部门，请核对 ERP 个人信息后重新试登录。' });
  }
}
