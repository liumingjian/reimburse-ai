// @vitest-environment node
import { describe, expect, test } from 'vitest';
import { MOCK_ACCOUNT, createAuth } from './auth';
import { createBus } from './bus';
import { T1_ID, t1Snapshot } from './fixtures/tasks';
import { createMockBookState, createProjectBook } from './project-book';
import type { MockOptions } from './options';

describe('mock project-book refreshes', () => {
  test('leaves an unchanged task untouched while propagating real option and confirmation changes', async () => {
    const options: MockOptions = { seed: 'actions', fault: null };
    const bus = createBus(options);
    bus.put(t1Snapshot('actions'));
    const auth = createAuth(options);
    const state = createMockBookState(options, MOCK_ACCOUNT.accountId);
    const book = createProjectBook(options, bus, auth, state, () => MOCK_ACCOUNT.accountId);
    book.prepareSeed(T1_ID);

    const before = bus.draft(T1_ID);
    book.refreshTasks();
    const unchanged = bus.draft(T1_ID);
    expect(unchanged.revision).toBe(before.revision);
    expect(unchanged.step.stepToken).toBe(before.step.stepToken);

    expect(await book.deactivateProject({ number: 'P-2307' })).toMatchObject({ ok: true, result: { status: 'deactivated' } });
    const changed = bus.draft(T1_ID);
    expect(changed.revision).toBe(before.revision + 1);
    expect(changed.step.stepToken).not.toBe(before.step.stepToken);
    expect(changed.projectAssignment.projects.some((project) => project.number === 'P-2307')).toBe(false);
    expect(changed.confirmation.status).toBe('invalidated');
  });
});
