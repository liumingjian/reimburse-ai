import { PROJECT_CHANGED_NOTICE, type TaskSnapshot } from '@baox/contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixtureCatalog } from './catalog/project-catalog';
import { api, sample } from './test/api';
import { createTestServer, type TestClient, type TestServer } from './test/harness';

// Slice 10 (#189): 整单明细确认 (whole-list detail confirmation) through `app.request()`. The confirmation stores
// `{digest, confirmedAt}`; its status is derived by comparing that digest with the current one (ADR-0014).

const CATALOG = fixtureCatalog([
  { number: 'P-2307', name: '华东客户交付', audited: true, forbidden: false },
  { number: 'P-9001', name: '公共平台建设', audited: true, forbidden: false },
]);

let server: TestServer;
let alice: TestClient;
beforeEach(async () => {
  server = await createTestServer({ projectCatalog: CATALOG });
  alice = await server.signIn('alice');
  expect((await alice.post('/api/project-book/intake', { number: 'P-2307' })).status).toBe(200);
});
afterEach(() => server.close());
const client = api(() => alice);

const PURPOSE = '上海产品评审出差';

// Hotel e-invoice + rail ticket, inventoried, every line on P-2307, purpose submitted: stage review.
async function submitted(): Promise<TaskSnapshot> {
  const { task } = await client.createTask('杭州');
  const uploaded = await client.upload(task.taskId, [sample('m01'), sample('m07')]);
  await client.accepted(await client.act(uploaded, 'start-inventory'));
  const done = await client.withoutStayGaps(await client.settled(task.taskId));
  return submit(done, PURPOSE);
}

function submit(snapshot: TaskSnapshot, purpose: string): Promise<TaskSnapshot> {
  return client.act(snapshot, 'submit-project-assignment', { purpose, projects: Object.fromEntries(snapshot.lines.map((line) => [line.lineId, 'P-2307'])) }).then((r) => client.accepted(r));
}

async function confirmed(): Promise<TaskSnapshot> {
  const review = await submitted();
  return client.accepted(await client.act(review, 'confirm-review', { digest: review.confirmation.digest }));
}

async function refused(response: Response, code: string) {
  expect(response.status).toBe(400);
  expect(((await response.json()) as { error: { code: string } }).error.code).toBe(code);
}

describe('confirmation status', () => {
  it('an edit after confirmation invalidates it; reverting the edit restores it', async () => {
    const done = await confirmed();
    const [line] = done.lines;
    if (!line) throw new Error('expected a line');
    const edit = `edit.${line.voucherMaterialId}.description`;

    const edited = await client.accepted(await client.act(done, 'answer-pending', { itemId: edit, answer: { value: '改过的描述' } }));
    expect(edited).toMatchObject({ stage: 'review', step: { kind: 'confirm_review' }, confirmation: { status: 'invalidated', confirmedAt: null } });
    expect(edited.confirmation.notice).toEqual(expect.any(String));
    expect(edited.confirmation.digest).not.toBe(done.confirmation.digest);

    const reverted = await client.accepted(await client.act(edited, 'answer-pending', { itemId: edit, answer: { value: line.description } }));
    expect(reverted).toMatchObject({ stage: 'actions', step: { kind: 'choose_action' }, confirmation: { status: 'confirmed', digest: done.confirmation.digest, confirmedAt: done.confirmation.confirmedAt } });
  });

  it('covers the purpose and the home city', async () => {
    const done = await confirmed();
    const purpose = await submit(done, '别的事由');
    expect(purpose.confirmation.status).toBe('invalidated');
    const back = await submit(purpose, PURPOSE);
    expect(back.confirmation.status).toBe('confirmed');

    const moved = await client.accepted(await client.act(back, 'set-home-city', { homeCity: '上海' }));
    expect(moved.confirmation.status).toBe('invalidated');
    const home = await client.accepted(await client.act(moved, 'set-home-city', { homeCity: '杭州' }));
    expect(home.confirmation.status).toBe('confirmed');
  });

  it('reopen-upload after confirmation invalidates it for good and returns to upload', async () => {
    const done = await confirmed();
    const reopened = await client.accepted(await client.act(done, 'reopen-upload'));
    expect(reopened).toMatchObject({ stage: 'upload', confirmation: { status: 'invalidated', digest: null } });
    expect(reopened.confirmation.notice).toEqual(expect.any(String));

    // The same materials inventoried again: the lines match, but the reopened confirmation stays void.
    await client.accepted(await client.act(reopened, 'start-inventory'));
    const again = await client.settled(done.task.taskId);
    expect(again).toMatchObject({ stage: 'review', confirmation: { status: 'invalidated', digest: done.confirmation.digest } });
    const reconfirmed = await client.accepted(await client.act(again, 'confirm-review', { digest: again.confirmation.digest }));
    expect(reconfirmed.confirmation.status).toBe('confirmed');
  });

  it('a public project deactivated after confirmation invalidates it; reviving it restores it (#194)', async () => {
    expect((await alice.post('/api/public-project-book/intake', { number: 'P-9001' })).status).toBe(200);
    const { task } = await client.createTask('杭州');
    const uploaded = await client.upload(task.taskId, [sample('m01'), sample('m07')]);
    await client.accepted(await client.act(uploaded, 'start-inventory'));
    const done = await client.withoutStayGaps(await client.settled(task.taskId));
    const review = await client.accepted(
      await client.act(done, 'submit-project-assignment', { purpose: PURPOSE, projects: Object.fromEntries(done.lines.map((line) => [line.lineId, 'P-9001'])) }),
    );
    expect(review.projectAssignment.assignments.every((line) => line.projectSource === 'public')).toBe(true);
    const onPublic = await client.accepted(await client.act(review, 'confirm-review', { digest: review.confirmation.digest }));
    expect(onPublic.confirmation.status).toBe('confirmed');

    // Deactivated: the standing submission keeps its pin (#194), but the confirmation no longer holds.
    expect((await alice.post('/api/public-project-book/remove', { number: 'P-9001' })).status).toBe(200);
    const deactivated = await client.settled(task.taskId);
    expect(deactivated).toMatchObject({ stage: 'review', step: { kind: 'confirm_review' }, confirmation: { status: 'invalidated', notice: PROJECT_CHANGED_NOTICE } });

    expect((await alice.post('/api/public-project-book/intake', { number: 'P-9001' })).status).toBe(200);
    const revived = await client.settled(task.taskId);
    expect(revived).toMatchObject({ stage: 'actions', confirmation: { status: 'confirmed', digest: onPublic.confirmation.digest } });
  });
});

describe('confirm-review', () => {
  it('is refused with a digest other than the current one', async () => {
    const review = await submitted();
    expect(review).toMatchObject({ stage: 'review', step: { kind: 'confirm_review' }, confirmation: { status: 'unconfirmed' } });
    expect(review.confirmation.digest).toEqual(expect.any(String));
    await refused(await client.act(review, 'confirm-review', { digest: 'not-the-digest' }), 'digest_mismatch');
    expect((await client.current(review.task.taskId)).confirmation.status).toBe('unconfirmed');
  });

  it('confirms the current digest and offers print and ERP', async () => {
    const done = await confirmed();
    expect(done).toMatchObject({
      stage: 'actions',
      step: { kind: 'choose_action' },
      confirmation: { status: 'confirmed', lineCount: 2, invoiceCount: 2, notice: null },
    });
    expect(done.confirmation.confirmedAt).toEqual(expect.any(String));
    expect(done.confirmation.grossTotal).toEqual(expect.stringMatching(/^\d+\.\d{2}$/));
  });

  it('is refused once confirmed, and with a stale stepToken', async () => {
    const done = await confirmed();
    await refused(await client.act(done, 'confirm-review', { digest: done.confirmation.digest }), 'not_ready');
    const stale = await client.act(done, 'confirm-review', { digest: done.confirmation.digest }, `${done.task.taskId}.1`);
    expect(stale.status).toBe(409);
  });
});
