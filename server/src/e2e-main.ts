import { catalogMismatch, loginWall, noFormOpen, scripted, uncertainSave, type Script } from './erp/testing/fake-executor';
import { run, type RunOverrides } from './run';

// The e2e-only entry, built into `dist/e2e-main.mjs` only when `BAOX_BUILD_E2E=1` (the root `test:e2e` script sets it).
// It is the same server as `main.ts` plus the scripted ERP doubles the Playwright `server` project needs, which is why
// it lives apart: `main.ts` must never import `erp/testing/`, or the doubles ship to users.
//
// `BAOX_ERP_FAKE` picks which ERP the job meets. Without it the real CDP executor is used, as in production.
//   uncertain_save    the fill job ends in ERP 写入结果未知 after its save attempt (#192)
//   login_wall        ERP sits on its login page: the job pauses, nothing is written
//   catalog_mismatch  报销信息核对 finds the first project renamed and aborts before importing anything
const SCRIPTS: Readonly<Record<string, Script>> = { uncertain_save: uncertainSave, login_wall: loginWall, catalog_mismatch: catalogMismatch };

const script = SCRIPTS[process.env['BAOX_ERP_FAKE'] ?? ''];
// A reconcile job only ever reads, so the same stand-in serves every fake: it finds no open form.
const fake: RunOverrides = script ? { erpExecutor: scripted(script), reconcileExecutor: noFormOpen } : {};
await run(fake);
