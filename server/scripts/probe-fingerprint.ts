// `pnpm --filter @baox/server exec tsx scripts/probe-fingerprint.ts`: what the compatibility fingerprint reads on
// whatever the dedicated Chromium is showing right now, next to what `erp/config.ts` expects.
//
// Read-only and free: it evaluates COMPATIBILITY_SNIPPET, clicks nothing and navigates nowhere, so it consumes no
// invoice and creates no 收票占用. Point the browser at an open 费用报销单-新增 and run it; a `compatibility_mismatch`
// abort is either a real ERP upgrade (the fingerprint did its job) or a selector that stopped matching, and this is
// how to tell which. URLs are printed without their query so K3Cloud's `_cnneptstate_` session state is never logged.

import { erpConfigFromEnv } from '../src/erp/config';
import { connect, evalIn, targets } from '@baox/erp-executor/cdp';
import { cdpPortOf, safeUrl } from '@baox/erp-executor/chromium';
import { COMPATIBILITY_SNIPPET } from '@baox/erp-executor/probe';

const config = erpConfigFromEnv();
const expected = config.compatibility;
const pages = (await targets(cdpPortOf())).filter((t) => t.type === 'page' && /^https?:/.test(String(t.url)));
if (pages.length === 0) {
  console.error('no page open in the dedicated Chromium (is it running with CDP on the expected port?)');
  process.exit(1);
}
for (const page of pages) console.log('page:', safeUrl(page.url));

const host = new URL(config.origin).hostname;
const target = pages.find((p) => String(p.url).includes(host)) ?? pages[0]!;
const session = await connect(target.webSocketDebuggerUrl!);
try {
  const probed = await evalIn<{ erpBuild: string | null; formIds: string[] }>(session, COMPATIBILITY_SNIPPET);
  const formId = probed?.formIds?.length === 1 ? probed.formIds[0]! : null;
  console.log('expected:', expected);
  console.log('probed:  ', { erpBuild: probed?.erpBuild ?? null, formIds: probed?.formIds ?? [] });
  const ok = probed?.erpBuild === expected.erpBuild && formId === expected.formId;
  console.log(ok ? 'match' : 'MISMATCH: a fill job would abort here with compatibility_mismatch');
  process.exit(ok ? 0 : 1);
} finally {
  session.close();
}
