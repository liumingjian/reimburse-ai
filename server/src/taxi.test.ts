import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
  }, 180_000);
});
