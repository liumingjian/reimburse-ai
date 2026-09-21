import { createHash } from 'node:crypto';
import { EXTENSION_PAIR_PATH, EXTENSION_VERSION, ExtensionPairingSchema, ExtensionTokenSchema, extensionBlobPath, type TaskSnapshot } from '@baox/contract';
import type { FillPlan } from '@baox/erp-executor/protocol';
import { RECONNECT_WINDOW_MS } from '@baox/erp-executor/wire';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixtureCatalog } from './catalog/project-catalog';
import { loginWall } from './erp/testing/fake-executor';
import { fakeExtension, type FakeExtension } from './erp/testing/fake-extension';
import { COMPATIBILITY, ERP_ORIGIN } from './erp/testing/scenario';
import { api, sample } from './test/api';
import { BACKSTOP_MS } from './test/deadlines';
import { createTestServer, type TestClient, type TestServer } from './test/harness';
import { manualTimers } from './test/timers';

// #256 at seam 3: the route the extension fetches invoice originals from. It is authorised by the pairing token, not a
// session, and serves only the originals named in the plan of the 去报销 running in that 应用账号's extension
// (user story 25: a compromised extension must not be able to walk the employee's archive).

const CATALOG = fixtureCatalog([{ number: 'P-2307', name: '华东客户交付', audited: true, forbidden: false }]);
const EXTENSION_ORIGIN = 'chrome-extension://kmbhfnaoapecjdgphfnbkejnnojfeeih';
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

let server: TestServer;
let alice: TestClient;
beforeEach(async () => {
  server = await createTestServer({ projectCatalog: CATALOG, erpConfig: { origin: ERP_ORIGIN, compatibility: COMPATIBILITY } });
  alice = await server.signIn('alice');
  expect((await alice.post('/api/project-book/intake', { number: 'P-2307', name: '华东客户交付' })).status).toBe(200);
});
afterEach(() => server.close());
const client = api(() => alice);

async function pair(owner: TestClient): Promise<string> {
  const issued = ExtensionPairingSchema.parse(await (await owner.post('/api/extension/pairing/code', {})).json());
  const redeemed = await server.app.request(EXTENSION_PAIR_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: EXTENSION_ORIGIN },
    body: JSON.stringify({ code: issued.code, browser: 'Chrome 142 Windows', version: EXTENSION_VERSION }),
  });
  return ExtensionTokenSchema.parse(await redeemed.json()).token;
}

// As the extension asks: a GET from its own origin, the token as a bearer.
const fetchBlob = (sha256: string, token: string | null) =>
  server.app.request(extensionBlobPath(sha256), { headers: { origin: EXTENSION_ORIGIN, ...(token ? { authorization: `Bearer ${token}` } : {}) } });

// A hotel invoice with its folio, confirmed: the plan names the invoice, not the folio.
async function confirmed(): Promise<TaskSnapshot> {
  const { task } = await client.createTask('杭州');
  const uploaded = await client.upload(task.taskId, [sample('m01'), sample('m02')]);
  await client.accepted(await client.act(uploaded, 'start-inventory'));
  const done = await client.withoutStayGaps(await client.settled(task.taskId));
  const review = await client.accepted(await client.act(done, 'submit-project-assignment', { purpose: '上海产品评审出差', projects: Object.fromEntries(done.lines.map((line) => [line.lineId, 'P-2307'])) }));
  return client.accepted(await client.act(review, 'confirm-review', { digest: review.confirmation.digest }));
}

/** A 去报销 held open in alice's extension until `finish` is called, so the test can fetch while it runs. */
async function running(token: string): Promise<{ plan: FillPlan; taskId: string; extension: FakeExtension; finish(): Promise<void> }> {
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  let started!: (plan: FillPlan) => void;
  const planned = new Promise<FillPlan>((resolve) => { started = resolve; });
  const extension = fakeExtension(server.app.extensionChannel, token, {
    fill: async (plan, channel) => {
      started(plan);
      await gate;
      return loginWall(plan, channel);
    },
  });
  await extension.connect();
  const ready = await confirmed();
  await client.accepted(await client.act(ready, 'start-erp-write'));
  const plan = await planned;
  const taskId = ready.task.taskId;
  return {
    plan, taskId, extension,
    async finish() {
      finish();
      const deadline = Date.now() + BACKSTOP_MS;
      while ((await client.current(taskId)).erp.status === 'running') {
        if (Date.now() > deadline) throw new Error('ERP job still running');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    },
  };
}

describe('the extension\'s invoice originals', () => {
  it('serves the running job\'s invoices to its own extension, by content, and nothing it could cache', async () => {
    const token = await pair(alice);
    const job = await running(token);
    const invoice = sample('m01');

    expect(job.plan.invoices.map((ref) => ref.sha256)).toEqual([sha(invoice.bytes)]);
    const served = await fetchBlob(sha(invoice.bytes), token);

    expect(served.status).toBe(200);
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(new Uint8Array(invoice.bytes));
    expect(served.headers.get('content-type')).toBe('application/pdf');
    expect(served.headers.get('cache-control')).toBe('no-store');
    expect(served.headers.get('x-content-type-options')).toBe('nosniff');
    await job.finish();
  });

  it('serves nothing the running plan does not name, even the same task\'s other originals', async () => {
    // Alice's own originals: one in an earlier task of hers (voided, since an account has one open task at a time),
    // and the folio of this one.
    const earlier = await client.createTask('杭州');
    await client.upload(earlier.task.taskId, [sample('m03')]);
    expect((await alice.post(`/api/tasks/${earlier.task.taskId}/abandon`, {})).status).toBe(200);
    const token = await pair(alice);
    const job = await running(token);
    const otherTask = sha(sample('m03').bytes);
    const folio = sha(sample('m02').bytes);

    for (const sha256 of [folio, otherTask, '0'.repeat(64), 'not-a-sha']) {
      expect((await fetchBlob(sha256, token)).status, sha256).toBe(404);
    }
    await job.finish();
  });

  it('serves nothing once the job has ended, and nothing when no job runs', async () => {
    const token = await pair(alice);
    const job = await running(token);
    const invoice = sha(sample('m01').bytes);
    expect((await fetchBlob(invoice, token)).status).toBe(200);

    await job.finish();

    expect((await fetchBlob(invoice, token)).status).toBe(404);
  });

  it('serves another 应用账号\'s extension nothing of this account\'s running job', async () => {
    const job = await running(await pair(alice));
    const bob = await server.signIn('bob');
    const bobs = await pair(bob);

    expect((await fetchBlob(job.plan.invoices[0]!.sha256, bobs)).status).toBe(404);
    await job.finish();
  });

  it('refuses without a token and with a wrong one, even while the job runs', async () => {
    const token = await pair(alice);
    const job = await running(token);
    const invoice = job.plan.invoices[0]!.sha256;

    expect((await fetchBlob(invoice, null)).status).toBe(401);
    expect((await fetchBlob(invoice, 'not-a-token')).status).toBe(401);
    // A session cookie is not the extension's credential.
    expect((await alice.request(extensionBlobPath(invoice))).status).toBe(401);
    await job.finish();
  });

  it('is behind the same Host guard as every other route', async () => {
    const token = await pair(alice);
    const job = await running(token);

    const rebound = await server.app.request(`http://evil.example.com${extensionBlobPath(job.plan.invoices[0]!.sha256)}`, { headers: { authorization: `Bearer ${token}` } });

    expect(rebound.status).toBe(403);
    await job.finish();
  });
});

// An interrupted job (ADR-0020) has not ended: it may still need its invoices when it resumes. It stops serving only
// once the server has ended it, here by letting the reconnection window close.
describe('the extension\'s invoice originals across an interruption', () => {
  let timers: ReturnType<typeof manualTimers>;
  beforeEach(async () => {
    await server.close();
    timers = manualTimers();
    server = await createTestServer({ projectCatalog: CATALOG, erpConfig: { origin: ERP_ORIGIN, compatibility: COMPATIBILITY }, schedule: timers.schedule });
    alice = await server.signIn('alice');
    expect((await alice.post('/api/project-book/intake', { number: 'P-2307', name: '华东客户交付' })).status).toBe(200);
  });

  it('keeps serving an interrupted job\'s invoices, and stops once the window has closed', async () => {
    const token = await pair(alice);
    const job = await running(token);
    const invoice = sha(sample('m01').bytes);

    job.extension.disconnect();

    // The socket went, so the job is interrupted and its window is open: it has not ended.
    expect(timers.pending(RECONNECT_WINDOW_MS)).toBe(1);
    expect((await fetchBlob(invoice, token)).status).toBe(200);

    timers.elapse(RECONNECT_WINDOW_MS);

    expect((await fetchBlob(invoice, token)).status).toBe(404);
    await job.finish();
  });

  it('refuses a revoked token at once, and the job its socket carried ends by the window', async () => {
    const token = await pair(alice);
    const job = await running(token);
    const invoice = job.plan.invoices[0]!.sha256;

    expect((await alice.post('/api/extension/pairing/revoke', {})).status).toBe(200);

    // Revoking closed the socket, so the job is interrupted like any lost connection; the token serves nothing.
    expect(server.app.extensionChannel.connected(alice.account.accountId)).toBe(false);
    expect(timers.pending(RECONNECT_WINDOW_MS)).toBe(1);
    expect((await fetchBlob(invoice, token)).status).toBe(401);

    timers.elapse(RECONNECT_WINDOW_MS);
    await job.finish();
  });
});
