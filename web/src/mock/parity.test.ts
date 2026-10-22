// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PENDING_CHOICE_KEY, type TaskSnapshot } from '@baox/contract';
import { GOLDENS, GOLDEN_SCENARIOS, GOLDEN_TIME, type GoldenScenario } from '@baox/contract/goldens';
import { GENERATED_DIR, SAMPLE_MATERIALS } from '@baox/fixtures';
import { describe, expect, test, vi } from 'vitest';
import { createMockAdapter, type MockAdapter, type MockOptions } from './mock-adapter';

// Mock ↔ server parity (#316): each scenario the server records a golden for (server/src/snapshot-goldens.test.ts) is
// driven through the mock adapter the way the pages drive it, from a new task: the golden's own sample files uploaded,
// the inventory run, the stay-trio (住宿三件套) item answered, every line assigned to the golden's project, the review
// confirmed, then 去报销 (claim) with the mock fault that stands in for the server's scripted ERP outcome. No seed
// snapshot is used.
//
// The mock's snapshot must then equal the golden, after both are normalised the same way (`normalised`: ids and
// digests numbered by first appearance, timestamps set to GOLDEN_TIME). That covers the allowed actions, the mock's
// stand-in for taskPolicy (fixtures/allowed-actions.ts), in every scenario. `UNMATCHED` and `SCENE_UNMATCHED` name each
// field left out of the comparison, with the reason it cannot match.
//
// A failure here means the mock drifted from the server. Fix the mock flow (or its fixture) to do what the server does;
// never edit a golden by hand (re-record it on the server when the server's projection changed on purpose).

const RECOGNITION = "the mock's recognition profile of a sample file (fixtures/inventory.ts, shared with T1), not the server's parser";
// Fields the mock cannot reproduce, by path (`*` = any array index), and why. Everything else must match.
const UNMATCHED: Readonly<Record<string, string>> = {
  'step.stepToken': 'opaque to the pages; the server issues `<taskId>.<revision>`, the mock names the transition',
  revision: 'the mock also advances it on its timer pushes, which the server does not have',
  'materials.*.originalUrl': 'the mock serves the sample files from the build (fixtures/), not /api/tasks/:id/files/:sha',
  'materials.*.previewUrl': 'as materials.*.originalUrl',
  'materials.*.checkText': RECOGNITION,
  'materials.*.fields': RECOGNITION,
  'events.*.summary': RECOGNITION,
  'events.*.evidenceNote': RECOGNITION,
  'events.*.city': RECOGNITION,
  'lodgingEvidence.*.fields': RECOGNITION,
  'lines.*.description': RECOGNITION,
  'lines.*.city': RECOGNITION,
  'lines.*.invoiceTypeSource': RECOGNITION,
  'lines.*.expenseItemCode': "the mock ERP's expense-item catalog (T1's), not the server scenario's fixture catalog",
  'lines.*.expenseItemName': 'as lines.*.expenseItemCode',
  'readback.rows.*.description': 'the line description, see lines.*.description',
  'readback.rows.*.fields.2.local': '费用项目 (expense item), see lines.*.expenseItemName',
  'readback.rows.*.fields.2.erp': 'as readback.rows.*.fields.2.local',
  'erp.erpAccount.displayName': "the ERP login identity: the mock's fictional employee, the server scenario's TEST_ERP_ACCOUNT",
  'erp.erpAccount.account': 'as erp.erpAccount.displayName',
  'erp.erpAccount.tenant': 'as erp.erpAccount.displayName',
  'reconcile.capture.screenshotUrl': 'the mock has no ERP screenshot to serve',
};

// Differences that come from the server's scripted ERP job (server/src/erp/testing/fake-executor.ts), not from its
// projection, per scenario.
const SCRIPTED_STEPS = "the scripted job emits no navigate / receipt step; a real job (and the mock) does";
// 去报销进度 (#420): with no 明细 row progress on its 填写明细 events the server counts the scripted job coarsely, one unit
// per shown step; a real job (and the mock) reports each row.
const SCRIPTED_ROWS = 'the scripted job reports no 明细 row progress and no navigate / receipt step; a real job (and the mock) does';
const SCENE_UNMATCHED: Partial<Record<GoldenScenario, Readonly<Record<string, string>>>> = {
  'erp-unknown': { 'erp.steps.3.status': SCRIPTED_STEPS, 'erp.steps.5.status': SCRIPTED_STEPS, 'erp.progress.percent': SCRIPTED_ROWS },
  'reconcile-readback-mismatch': {
    'erp.steps.3.status': SCRIPTED_STEPS,
    'erp.steps.5.status': SCRIPTED_STEPS,
    'erp.progress.label': SCRIPTED_ROWS,
    'erp.progress.percent': SCRIPTED_ROWS,
    'erp.abortReason': "the read-back totals are invented by the script; the mock's are T1's No.6 (fixtures/erp.ts)",
    'reconcile.reasons': 'as erp.abortReason',
  },
  done: {
    'erp.review.url': "the 报销系统 the draft went to: the mock's fictional one, the server scenario's configured ERP",
    'readback.rows.*.fields.7.local': 'the scripted job reads back no 收票单号 (receipt number); a real one (and the mock) does',
    'readback.rows.*.fields.7.erp': 'as readback.rows.*.fields.7.local',
  },
};

const ID_KEYS = new Set([
  'taskId',
  'batchId',
  'fileId',
  'materialId',
  'voucherMaterialId',
  'defaultMaterialId',
  'excludableMaterialId',
  'itemId',
  'eventId',
  'lineId',
  'linkedMaterialIds',
  'referenceMaterialIds',
  'pendingItemIds',
  'materialIds',
  'ungroupedMaterialIds',
  'screenshotId',
  'screenshotIds',
]);
// Strings that carry an id inside them (file URLs name the task).
const EMBEDS_IDS = new Set(['originalUrl', 'previewUrl', 'url', 'screenshotUrl']);
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
// Placeholder task names are `<creation date> 新建报销`; the golden keeps the day it was recorded.
const PLACEHOLDER_NAME = /^\d{4}-\d{2}-\d{2} (?=新建报销$)/;

// The same snapshot with its per-run values replaced, so the mock's and the server's compare field by field.
function normalised(snapshot: TaskSnapshot): unknown {
  const ids = new Map<string, string>();
  const digests = new Map<string, string>();
  const number = (table: Map<string, string>, prefix: string, value: string) => {
    let name = table.get(value);
    if (!name) table.set(value, (name = `${prefix}${table.size + 1}`));
    return name;
  };
  const collect = (value: unknown, key: string | null): void => {
    if (typeof value === 'string' && key !== null && ID_KEYS.has(key)) number(ids, 'id-', value);
    else if (Array.isArray(value)) for (const item of value) collect(item, key);
    else if (value && typeof value === 'object') for (const [child, item] of Object.entries(value)) collect(item, child);
  };
  collect(snapshot, null);
  const known = [...ids.keys()].sort((a, b) => b.length - a.length);
  const rewrite = (value: unknown, key: string | null): unknown => {
    if (typeof value === 'string') {
      if (key !== null && ID_KEYS.has(key)) return ids.get(value);
      if (key === 'digest') return number(digests, 'digest-', value);
      if (TIMESTAMP.test(value)) return GOLDEN_TIME;
      if (key === 'name') return value.replace(PLACEHOLDER_NAME, '<created> ');
      if (key !== null && EMBEDS_IDS.has(key)) return known.reduce((text, id) => text.split(id).join(ids.get(id) ?? id), value);
      return value;
    }
    if (Array.isArray(value)) return value.map((item) => rewrite(item, key));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([child, item]) => [child, rewrite(item, child)]));
    return value;
  };
  return rewrite(snapshot, null);
}

// The value without the unmatched paths.
function compared(value: unknown, unmatched: readonly string[], path: readonly string[] = []): unknown {
  const skipped = (here: readonly string[]) =>
    unmatched.some((pattern) => {
      const parts = pattern.split('.');
      return parts.length === here.length && parts.every((part, index) => part === here[index] || (part === '*' && /^\d+$/.test(here[index] ?? '')));
    });
  if (Array.isArray(value)) return value.map((item, index) => compared(item, unmatched, [...path, String(index)]));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !skipped([...path, key]))
      .map(([key, item]) => [key, compared(item, unmatched, [...path, key])]),
  );
}

// Timers of the simulated server, shortened.
const FAST: Partial<MockOptions> = { inventoryPhaseMs: 1, erpStepMs: 1 };

async function settled(adapter: MockAdapter, taskId: string, done: (snapshot: TaskSnapshot) => boolean): Promise<TaskSnapshot> {
  await vi.waitFor(async () => expect(done(await adapter.getSnapshot(taskId))).toBe(true));
  return adapter.getSnapshot(taskId);
}

function ok<T extends { ok: boolean }>(outcome: T): T {
  expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
  return outcome;
}

function snapshotOf(outcome: { ok: boolean; snapshot: TaskSnapshot | null }): TaskSnapshot {
  const { snapshot } = ok(outcome);
  if (!snapshot) throw new Error('the action returned no snapshot');
  return snapshot;
}

type Driven = { adapter: MockAdapter; taskId: string; snapshot: TaskSnapshot };

// The server's scenario uploads these sample files (@baox/fixtures) into a new task; the mock recognises them by
// business file name and hashes the same bytes.
function sampleFile(fileName: string): File {
  const sample = SAMPLE_MATERIALS.find((candidate) => candidate.fileName === fileName);
  if (!sample) throw new Error(`no sample material named ${fileName}`);
  return new File([readFileSync(join(GENERATED_DIR, sample.file))], fileName, { type: 'application/pdf' });
}
const UPLOADED = GOLDENS.upload.batches.flatMap((batch) => batch.files.map((file) => file.fileName));
// The scenario's project book (SCENARIO_PROJECTS in server/src/test/scenario.ts).
const SCENARIO_PROJECTS = new Set(GOLDENS.project.projectAssignment.projects.map((project) => project.number));

// The scenario builder's ladder (server/src/test/scenario.ts), one rung per call.
const ladder = {
  async upload(fault: MockOptions['fault'] = null): Promise<Driven> {
    const adapter = createMockAdapter({ seed: null, fault, ...FAST });
    // The mock's fixture book has more projects than the scenario's; the user removes them.
    for (const project of (await adapter.getProjectBook()).projects) {
      if (!SCENARIO_PROJECTS.has(project.number)) ok(await adapter.deleteProject({ number: project.number }));
    }
    const taskId = snapshotOf(await adapter.createTask({ homeCity: GOLDENS.upload.task.homeCity })).task.taskId;
    const snapshot = snapshotOf(await adapter.uploadBatch(taskId, UPLOADED.map(sampleFile)));
    return { adapter, taskId, snapshot };
  },
  async pending(fault: MockOptions['fault'] = null): Promise<Driven> {
    const { adapter, taskId, snapshot } = await ladder.upload(fault);
    ok(await adapter.startInventory(taskId, snapshot.step.stepToken));
    return { adapter, taskId, snapshot: await settled(adapter, taskId, (current) => current.inventory.status === 'done') };
  },
  // The builder answers the stay-trio item 确认没有 (confirm none).
  async project(fault: MockOptions['fault'] = null): Promise<Driven> {
    const { adapter, taskId } = await ladder.pending(fault);
    let snapshot = await adapter.getSnapshot(taskId);
    for (const item of snapshot.pendingItems.filter((candidate) => candidate.status === 'open')) {
      snapshot = snapshotOf(await adapter.answerPendingItem(taskId, item.itemId, { [PENDING_CHOICE_KEY]: 'confirm_none' }, snapshot.step.stepToken));
    }
    return { adapter, taskId, snapshot };
  },
  async review(fault: MockOptions['fault'] = null): Promise<Driven> {
    const { adapter, taskId, snapshot: before } = await ladder.project(fault);
    const { purpose, assignments } = GOLDENS.review.projectAssignment;
    const project = assignments[0]?.projectNumber ?? '';
    const input = { purpose: purpose ?? '', projects: Object.fromEntries(before.lines.map((line) => [line.lineId, project])) };
    return { adapter, taskId, snapshot: snapshotOf(await adapter.submitProjectAssignment(taskId, input, before.step.stepToken)) };
  },
  async actions(fault: MockOptions['fault'] = null): Promise<Driven> {
    const { adapter, taskId, snapshot: before } = await ladder.review(fault);
    return { adapter, taskId, snapshot: snapshotOf(await adapter.confirmReview(taskId, before.confirmation.digest ?? '', before.step.stepToken)) };
  },
};

// 去报销 (claim) from choose_action, with `fault` playing the server's scripted ERP outcome, until `done`.
// The mock signs in by itself, like the 本地执行器 and the scenario builder's scripts do.
async function afterErpWrite(fault: MockOptions['fault'], done: (snapshot: TaskSnapshot) => boolean): Promise<TaskSnapshot> {
  const { adapter, taskId, snapshot } = await ladder.actions(fault);
  ok(await adapter.startErpWrite(taskId, snapshot.step.stepToken));
  return settled(adapter, taskId, done);
}

const SCENES: Record<GoldenScenario, () => Promise<TaskSnapshot>> = {
  upload: async () => (await ladder.upload()).snapshot,
  pending: async () => (await ladder.pending()).snapshot,
  project: async () => (await ladder.project()).snapshot,
  review: async () => (await ladder.review()).snapshot,
  'choose-action': async () => (await ladder.actions()).snapshot,
  'catalog-mismatch': () => afterErpWrite('catalog-mismatch', (snapshot) => snapshot.catalog.status === 'mismatch'),
  'erp-stopped-before-write': () => afterErpWrite('erp-stopped-before-write', (snapshot) => snapshot.stage === 'actions'),
  'erp-unknown': () => afterErpWrite('erp-write-aborted', (snapshot) => snapshot.stage === 'reconcile'),
  'reconcile-readback-mismatch': () => afterErpWrite('readback-mismatch', (snapshot) => snapshot.stage === 'reconcile'),
  done: () => afterErpWrite(null, (snapshot) => snapshot.stage === 'done'),
  async voided() {
    const { adapter, taskId } = await ladder.upload();
    ok(await adapter.abandonTask(taskId));
    return adapter.getSnapshot(taskId);
  },
};

describe('mock ↔ server parity (golden snapshots)', () => {
  test.each([...GOLDEN_SCENARIOS])('%s', async (name) => {
    const snapshot = await SCENES[name]();
    const unmatched = [...Object.keys(UNMATCHED), ...Object.keys(SCENE_UNMATCHED[name] ?? {})];
    const mock = compared(normalised(snapshot), unmatched);
    const golden = compared(normalised(GOLDENS[name]), unmatched);
    expect(mock).toEqual(golden);
  });
});
