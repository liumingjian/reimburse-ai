import { resolveDataDir } from './data-dir';
import { cdpExecutors } from './erp/cdp-executor';
import { catalogMismatch, loginWall, noFormOpen, scripted, uncertainSave, type Script } from './erp/testing/fake-executor';
import { invoiceVariantFixtureParser } from './parse/testing/invoice-variants';
import { run, type RunOverrides } from './run';

// The e2e-only entry, built into `dist/e2e-main.mjs` only when `BAOX_BUILD_E2E=1` (the root `test:e2e` script sets it).
// It is the same server as `main.ts` plus the scripted ERP doubles and the CDP executor the Playwright `server` project
// needs, which is why it lives apart: `main.ts` must import neither, or they ship to users.
//
// `BAOX_ERP_FAKE` picks which ERP the job meets. Without it the CDP executor is used, which the Playwright server
// project runs with `BAOX_ERP_CHROMIUM=off`: a job finds no browser and stops before any attempt.
//   uncertain_save    the fill job ends in ERP 写入结果未知 after its save attempt (#192)
//   login_wall        ERP sits on its login page: the job pauses, nothing is written
//   catalog_mismatch  报销信息核对 finds the first project renamed and aborts before importing anything
const SCRIPTS: Readonly<Record<string, Script>> = { uncertain_save: uncertainSave, login_wall: loginWall, catalog_mismatch: catalogMismatch };

const script = SCRIPTS[process.env['BAOX_ERP_FAKE'] ?? ''];
const parser = process.env['BAOX_PARSE_FIXTURE'] === 'invoice-variants' ? invoiceVariantFixtureParser() : undefined;
// A reconcile job only ever reads, so the same stand-in serves every fake: it finds no open form.
const executors: RunOverrides = { ...(script ? { erpExecutor: scripted(script), reconcileExecutor: noFormOpen } : cdpExecutors(resolveDataDir())), ...(parser ? { parser } : {}) };
await run(executors);
