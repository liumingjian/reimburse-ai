import { noFormOpen, scripted, uncertainSave } from './erp/testing/fake-executor';
import { run } from './run';

// The e2e-only entry, built into `dist/e2e-main.mjs` only when `BAOX_BUILD_E2E=1` (the root `test:e2e` script sets it).
// It is the same server as `main.ts` plus the scripted ERP doubles the Playwright `server` project needs, which is why
// it lives apart: `main.ts` must never import `erp/testing/`, or the doubles ship to users.
//
// `BAOX_ERP_FAKE=uncertain_save`: the fill job ends in ERP 写入结果未知 after a save, and reconcile finds no form open.
const fake = process.env['BAOX_ERP_FAKE'] === 'uncertain_save' ? { erpExecutor: scripted(uncertainSave), reconcileExecutor: noFormOpen } : {};
await run(fake);
