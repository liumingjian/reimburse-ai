import { describe, expect, it } from 'vitest';
import { checkCatalog, PROJECT_FORM } from './catalog';
import { createFakeErp } from './testing/fake-erp';
import { fakeErpOptions } from './testing/scenario';

describe('project catalog identity', () => {
  it.each([
    { rows: [['39163', null, 'C', 'A']], verdict: 'unusable' },
    { rows: [['39163', '', 'C', 'A']], verdict: 'unusable' },
    { rows: [['another-project', '正式名称', 'C', 'A']], verdict: 'missing' },
    { rows: [['39163', '正式名称', 'A', 'A']], verdict: 'unusable' },
    { rows: [['39163', '正式名称', 'C', 'B']], verdict: 'unusable' },
    { rows: [['39163', '正式名称', 'C', 'A'], ['39163', '另一个', 'C', 'A']], verdict: 'ambiguous' },
  ])('refuses malformed or unusable project facts: $verdict', async ({ rows, verdict }) => {
    const fake = await createFakeErp(fakeErpOptions());
    const send = fake.session.send.bind(fake.session);
    fake.session.send = (method, params, options) => method === 'Runtime.evaluate' && String(params?.expression).includes(PROJECT_FORM)
      ? Promise.resolve({ result: { value: { parsed: rows } } }) : send(method, params, options);
    expect(await checkCatalog(fake.session, { projects: [{ code: '39163', name: '简名' }], expenseItems: [] }))
      .toMatchObject({ ok: true, projects: [], problems: [{ code: '39163', verdict }] });
  });

  it('returns the official project name for the matching usable number', async () => {
    const fake = await createFakeErp(fakeErpOptions({ projects: [{ code: '39163', name: '完整正式项目名' }] }));
    expect(await checkCatalog(fake.session, { projects: [{ code: '39163', name: '简名' }], expenseItems: [] }))
      .toEqual({ ok: true, problems: [], projects: [{ code: '39163', name: '完整正式项目名' }] });
  });
});
