import { TaskSnapshotSchema, type TaskSnapshot } from '../snapshot';
import { GOLDEN_SCENARIOS, GOLDEN_TIME, type GoldenScenario } from './scenarios';
import catalogMismatch from './catalog-mismatch.json';
import chooseAction from './choose-action.json';
import done from './done.json';
import erpLoginWall from './erp-login-wall.json';
import erpStoppedBeforeWrite from './erp-stopped-before-write.json';
import erpUnknown from './erp-unknown.json';
import pending from './pending.json';
import project from './project.json';
import reconcileReadbackMismatch from './reconcile-readback-mismatch.json';
import review from './review.json';
import upload from './upload.json';
import voided from './voided.json';

// Golden snapshots (@baox/contract/goldens): what the server's snapshot projection (server/src/task-snapshot.ts)
// answers for a task the scenario builder drove to each GOLDEN_SCENARIOS entry. The web mock is checked against them.
// Recorded, never hand-edited; per-run values (ids, digests, timestamps) are replaced as server/src/test/goldens.ts
// describes. Re-record after an intended projection change:
//
//   UPDATE_SNAPSHOT_GOLDENS=1 pnpm --filter @baox/server exec vitest run src/snapshot-goldens.test.ts

export { GOLDEN_SCENARIOS, GOLDEN_TIME, type GoldenScenario };

const RECORDED: Record<GoldenScenario, unknown> = {
  upload,
  pending,
  project,
  review,
  'choose-action': chooseAction,
  'catalog-mismatch': catalogMismatch,
  'erp-login-wall': erpLoginWall,
  'erp-stopped-before-write': erpStoppedBeforeWrite,
  'erp-unknown': erpUnknown,
  'reconcile-readback-mismatch': reconcileReadbackMismatch,
  done,
  voided,
};

export const GOLDENS = Object.fromEntries(GOLDEN_SCENARIOS.map((name) => [name, TaskSnapshotSchema.parse(RECORDED[name])])) as Record<GoldenScenario, TaskSnapshot>;
