import { describe, expect, it } from 'vitest';
import { project, type TaskFacts } from './projection';

// The pure projection (ADR-0014): every stage reachable in slice #180, from facts alone.
const base: TaskFacts = { taskId: 't', revision: 7, lifecycle: 'open', versionNo: 0, includedMaterialCount: 0, lastRun: null, lastReopenRevision: null };
const facts = (patch: Partial<TaskFacts>): TaskFacts => ({ ...base, ...patch });

describe('project(facts)', () => {
  it.each<[string, Partial<TaskFacts>, string, string]>([
    ['a new task waits for materials', {}, 'upload', 'upload_materials'],
    ['an un-inventoried version asks to start inventory', { versionNo: 1, includedMaterialCount: 2 }, 'upload', 'start_inventory'],
    ['every material excluded: nothing to inventory', { versionNo: 1, includedMaterialCount: 0 }, 'upload', 'upload_materials'],
    ['the current version inventoried', { versionNo: 1, includedMaterialCount: 2, lastRun: { versionNo: 1, revision: 5 } }, 'inventory', 'none'],
    ['a batch after the run forms an un-inventoried version', { versionNo: 2, includedMaterialCount: 3, lastRun: { versionNo: 1, revision: 5 } }, 'upload', 'start_inventory'],
    ['upload reopened after the run', { versionNo: 1, includedMaterialCount: 2, lastRun: { versionNo: 1, revision: 5 }, lastReopenRevision: 6 }, 'upload', 'start_inventory'],
    ['a reopen older than the latest run is spent', { versionNo: 1, includedMaterialCount: 2, lastRun: { versionNo: 1, revision: 5 }, lastReopenRevision: 4 }, 'inventory', 'none'],
    ['voided, whatever else is true', { lifecycle: 'voided', versionNo: 1, includedMaterialCount: 2 }, 'voided', 'none'],
  ])('%s', (_name, patch, stage, step) => {
    const projection = project(facts(patch));
    expect(projection.stage).toBe(stage);
    expect(projection.step.kind).toBe(step);
    expect(projection.blockers).toEqual([]);
  });

  it('the stepToken is the task id and revision', () => {
    expect(project(base).step.stepToken).toBe('t.7');
    expect(project(facts({ revision: 8 })).step.stepToken).not.toBe(project(base).step.stepToken);
  });
});
