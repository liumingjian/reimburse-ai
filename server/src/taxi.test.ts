import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KINDS } from './kind-policy';
import { COMPANY_RULES, deriveCategory } from './rules/company-rules';
import { api, byFileName, fieldValues, sample } from './test/api';
import { createTestServer, type TestClient, type TestServer } from './test/harness';

// Slice 07 (#186): 出租车车费发票 (taxi receipt) photos, straightened and read by the in-process OCR, through the real
// parse worker_thread and the `taxi_receipt/machine_printed` layout.

let server: TestServer;
let signedIn: TestClient;
beforeEach(async () => {
  server = await createTestServer();
  signedIn = await server.signIn();
});
afterEach(() => server.close());
const client = api(() => signedIn);

const TAXI = 'rule:taxi_receipt/machine_printed';

async function inventoried(prefixes: readonly string[]) {
  const { task } = await client.createTask();
  const uploaded = await client.upload(task.taskId, prefixes.map(sample));
  await client.accepted(await client.act(uploaded, 'start-inventory'));
  return client.settled(task.taskId, 120_000);
}

describe('the taxi_receipt/machine_printed layout on generated photos', () => {
  it('reads amount, date and invoice code from m09 and m10', async () => {
    const snapshot = await inventoried(['m09', 'm10']);

    const m09 = byFileName(snapshot, sample('m09').name);
    expect(m09).toMatchObject({ kind: 'taxi_receipt', layout: 'machine_printed', role: 'primary_voucher', status: 'ok' });
    expect(fieldValues(m09, TAXI)).toMatchObject({ invoiceCode: '131002325021', invoiceNumber: '04213377', totalAmount: '32.00' });
    // The receipt prints a two-digit year (`26-08-15`); the full date is a derived candidate naming its rule.
    expect(fieldValues(m09, `${TAXI}.year_from_suffix`)).toMatchObject({ travelDate: '2026-08-15' });

    const m10 = byFileName(snapshot, sample('m10').name);
    expect(m10).toMatchObject({ kind: 'taxi_receipt', layout: 'machine_printed', status: 'ok' });
    expect(fieldValues(m10, TAXI)).toMatchObject({ invoiceCode: '131002325021', invoiceNumber: '04219052', totalAmount: '47.00' });
    expect(fieldValues(m10, `${TAXI}.year_from_suffix`)).toMatchObject({ travelDate: '2026-08-19' });

    expect(snapshot.lines.map((line) => line.grossAmount).sort()).toEqual(['32.00', '47.00']);
    // The city from the 开票地区码 (上海) is not the home city (杭州): out-of-town city transport, never undivided.
    for (const line of snapshot.lines) expect(line.category).toEqual({ code: 'remote_city_transport', label: '外地市内交通' });
    // Every candidate on a photo is OCR'd, so every one is correctable.
    expect(m09.fields.length).toBeGreaterThan(0);
    expect(m09.fields.every((field) => field.editClass === 'fact_correctable')).toBe(true);
  }, 180_000);
});

describe('taxi_receipt kind hooks', () => {
  const values = { invoiceCode: '131002325021', invoiceNumber: '04213377', travelDate: '2026-08-15', totalAmount: '32.00' };

  it('identifies by 发票代码 + 发票号码 and checks their formats', () => {
    const spec = KINDS.taxi_receipt;
    expect(spec.identity?.(values)).toBe('vat-legacy:131002325021:04213377');
    expect(spec.check?.(values)).toBeNull();
    expect(spec.check?.({ ...values, invoiceNumber: '0421337' })).toMatch(/8 位/);
    expect(spec.faceInvoiceType?.(values)).toBe('普通发票');
  });

  it('derives local vs out-of-town from its city, and blocks without one', () => {
    const draft = (city?: string) => KINDS.taxi_receipt.event(city ? { ...values, city } : values)!;
    expect(deriveCategory(draft('上海').category, draft('上海').city ?? null, '上海市', COMPANY_RULES)).toMatchObject({ category: { code: 'local_city_transport' } });
    expect(deriveCategory(draft('上海').category, draft('上海').city ?? null, '杭州', COMPANY_RULES)).toMatchObject({ category: { code: 'remote_city_transport' } });
    expect(deriveCategory(draft().category, draft().city ?? null, '杭州', COMPANY_RULES)).toEqual({ blocked: 'category_city_missing' });
  });
});
