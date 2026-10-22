import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TaskSnapshotSchema } from '@baox/contract';
import { GOLDEN_SCENARIOS, type GoldenScenario } from '@baox/contract/goldens/scenarios';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { abortBeforeAttempt, catalogMismatch, readbackMismatch, uncertainSave, type Script } from './erp/testing/fake-executor';
import { goldenJson } from './test/goldens';
import { scenario, scenarioServer, type Scene, type ScenarioServer } from './test/scenario';

// The golden snapshots the web mock is checked against (@baox/contract/goldens): each scenario is driven through the
// public HTTP actions by the scenario builder, and the task's snapshot must equal the recorded golden. A projection
// change that alters any of them fails here. Re-record after an intended change, and review the JSON diff:
//
//   UPDATE_SNAPSHOT_GOLDENS=1 pnpm --filter @baox/server exec vitest run src/snapshot-goldens.test.ts

const UPDATE = process.env['UPDATE_SNAPSHOT_GOLDENS'] === '1';
const GOLDENS_DIR = fileURLToPath(new URL('../../contract/src/goldens/', import.meta.url));

// 去报销 started from choose_action with the fill job playing `script`, for outcomes the ladder does not stop on.
async function afterErpWrite(server: ScenarioServer, script: Script): Promise<Scene> {
  const scene = await scenario(server).at('actions', { erp: script });
  await scene.run('start-erp-write');
  return scene;
}

const SCENES: Record<GoldenScenario, (server: ScenarioServer) => Promise<Scene>> = {
  upload: (server) => scenario(server).at('upload'),
  pending: (server) => scenario(server).at('pending'),
  project: (server) => scenario(server).at('project'),
  review: (server) => scenario(server).at('review'),
  'choose-action': (server) => scenario(server).at('actions'),
  'catalog-mismatch': (server) => afterErpWrite(server, catalogMismatch),
  'erp-stopped-before-write': (server) => afterErpWrite(server, abortBeforeAttempt),
  'erp-unknown': (server) => afterErpWrite(server, uncertainSave),
  'reconcile-readback-mismatch': (server) => scenario(server).at('reconcile', { erp: readbackMismatch }),
  done: (server) => scenario(server).at('done'),
  async voided(server) {
    const scene = await scenario(server).at('upload');
    expect((await scene.client.post(`/api/tasks/${scene.task.taskId}/abandon`, {})).status).toBe(200);
    return scene;
  },
};

describe('snapshot goldens', () => {
  let server: ScenarioServer;
  beforeEach(async () => {
    server = await scenarioServer();
  });
  afterEach(async () => {
    await server.close();
  });

  it.each(GOLDEN_SCENARIOS)('%s', async (name) => {
    const start = Date.now();
    const scene = await SCENES[name](server);
    // The raw response, not the contract-parsed one: a field the schema would strip still shows in the diff.
    const raw: unknown = await (await scene.client.request(`/api/tasks/${scene.task.taskId}`)).json();
    const actual = goldenJson(raw, { start, end: Date.now() });
    const file = `${GOLDENS_DIR}${name}.json`;
    if (UPDATE) writeFileSync(file, actual);
    expect(JSON.parse(actual)).toEqual(JSON.parse(readFileSync(file, 'utf8')));
    // The mock serves goldens as snapshots: each must be one the contract accepts unchanged.
    expect(TaskSnapshotSchema.parse(JSON.parse(actual))).toEqual(JSON.parse(actual));
  });

  // After the scenarios, so a first recording has written the files.
  it('record exactly the golden scenarios', () => {
    const files = readdirSync(GOLDENS_DIR).filter((file) => file.endsWith('.json')).sort();
    expect(files).toEqual(GOLDEN_SCENARIOS.map((name) => `${name}.json`).sort());
  });
});
