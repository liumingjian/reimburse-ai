import { resolveDataDir } from './data-dir';
import { cdpExecutors } from './erp/cdp-executor';
import { catalogMismatch, drafted, noFormOpen, notSignedIn, scripted, uncertainSave, type Script } from './erp/testing/fake-executor';
import { invoiceVariantFixtureParser } from './parse/testing/invoice-variants';
import { uncertainInvoiceTypeFixtureParser } from './parse/testing/uncertain-invoice-type';
import { run, type RunOverrides } from './run';

// The e2e-only entry, built into `dist/e2e-main.mjs` only when `BAOX_BUILD_E2E=1` (the root `test:e2e` script sets it).
// It is the same server as `main.ts` plus the scripted ERP doubles and the CDP executor the Playwright `server` project
// needs, which is why it lives apart: `main.ts` must import neither, or they ship to users.
//
// `BAOX_ERP_FAKE` picks which ERP the job meets. Without it the CDP executor is used, which the Playwright server
// project runs with `BAOX_ERP_CHROMIUM=off`: a job finds no browser and stops before any attempt.
//   drafted           the production ending (ADR-0037): the fill 暂存s the bill and finds it again, ERP 草稿已交接
//   uncertain_save    the fill job ends in ERP 写入结果未知 after its save attempt (#192)
//   not_signed_in     ERP sits on its login page and the job has no 凭据: it stops before any attempt
//   catalog_mismatch  报销信息核对 finds the first project renamed and aborts before importing anything
const SCRIPTS: Readonly<Record<string, Script>> = { drafted, uncertain_save: uncertainSave, not_signed_in: notSignedIn, catalog_mismatch: catalogMismatch };

const script = SCRIPTS[process.env['BAOX_ERP_FAKE'] ?? ''];
const PARSERS: Readonly<Record<string, () => ReturnType<typeof invoiceVariantFixtureParser>>> = {
  'invoice-variants': invoiceVariantFixtureParser,
  'uncertain-invoice-type': uncertainInvoiceTypeFixtureParser,
};
const parser = PARSERS[process.env['BAOX_PARSE_FIXTURE'] ?? '']?.();
// A reconcile job only ever reads, so the same stand-in serves every fake: it finds no open form.
const executors: RunOverrides = { ...(script ? { erpExecutor: scripted(script), reconcileExecutor: noFormOpen } : cdpExecutors(resolveDataDir())), ...(parser ? { parser } : {}) };
await run(executors);
