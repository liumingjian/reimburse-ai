import { describe, expect, it } from 'vitest';
import { evalIn } from './cdp';
import { readEmployeeProfile } from './employee-profile';
import { createFakeErp } from './testing/fake-erp';
import { ERP_ACCOUNT } from './testing/scenario';

const recorded = () => createFakeErp({ recording: 'employee-profile', loggedIn: true, account: ERP_ACCOUNT, invoices: [], projects: [], expenseItems: [] });

// The live recording has nine appointments. Values are redacted. Synthetic values below vary only the data in
// that recorded DOM, so the test can distinguish display order without retaining any employee's departments.
async function withSyntheticValues() {
  const erp = await recorded();
  expect(await readEmployeeProfile(erp.session)).toMatchObject({ status: 'ready', erpAccount: ERP_ACCOUNT.account, tenant: ERP_ACCOUNT.tenant });
  await evalIn(erp.session, `(() => {
    document.querySelector('[id$="-FNAMELABLE"]').textContent = '测试员工(员工编码:0000)';
    const nodes = [...document.querySelectorAll('[id]')].filter(n => /-FLABEL\\d+DEP$/.test(n.id));
    nodes.forEach((n, i) => { n.textContent = i === nodes.length - 1 ? '末条任职部门' : '前条任职部门'; });
  })()`);
  return erp;
}

describe('ERP personal information on the recorded real page', () => {
  it('opens only personal information and chooses the last displayed appointment', async () => {
    const erp = await withSyntheticValues();
    expect(await readEmployeeProfile(erp.session)).toEqual({ status: 'ready', erpAccount: ERP_ACCOUNT.account, tenant: ERP_ACCOUNT.tenant, name: '测试员工', department: '末条任职部门' });
    expect(erp.mutations).toEqual([]);
    expect(erp.recordedPage).toBe('employee-profile');
  });

  it('reads a single appointment in the same recorded page structure', async () => {
    const erp = await withSyntheticValues();
    await evalIn(erp.session, `(() => { const nodes = [...document.querySelectorAll('[id]')].filter(n => /-FLABEL\\d+DEP$/.test(n.id)); nodes.slice(0, -1).forEach(n => n.remove()); })()`);
    expect(await readEmployeeProfile(erp.session)).toMatchObject({ status: 'ready', name: '测试员工', department: '末条任职部门' });
  });

  it.each(['name', 'department'])('requires an actionable retry when %s is unreadable', async (field) => {
    const erp = await withSyntheticValues();
    await evalIn(erp.session, field === 'name'
      ? `document.querySelector('[id$="-FNAMELABLE"]').textContent = ''`
      : `document.querySelector('[id$="-FLABEL12DEP"]').textContent = ''`);
    expect(await readEmployeeProfile(erp.session)).toMatchObject({ status: 'failed', message: expect.stringContaining('重新试登录') });
  }, 20_000);
});
