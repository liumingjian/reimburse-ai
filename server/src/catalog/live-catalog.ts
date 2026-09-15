import { PROJECT_FORM, queryRows } from '../erp/executor/catalog';
import { evalIn, type CdpSession } from '../erp/executor/cdp';
import type { ChromiumPage } from '../erp/executor/chromium';
import type { BrowserPort } from '../erp/executor/job';
import { probeIdentity, sameOrigin } from '../erp/executor/probe';
import { isSafeProjectNumber, UNAVAILABLE_MESSAGE, verdictOf, type CatalogLookup, type ProjectCatalog } from './project-catalog';

// The live project catalog (ADR-0008): Kingdee's own read-only query service `ExecuteBillQuery` on `BJYC_ProJect`
// (FNumber, FName, FDocumentStatus = C audited, FForbidStatus = A not forbidden), run inside the logged-in ERP tab of
// the dedicated Chromium. It never opens a browser, never navigates and never writes; with no logged-in ERP tab the
// lookup did not happen (not_logged_in). A read-only query needs no ERP lease: it drives no form.

const FIELDS = 'FNumber,FName,FDocumentStatus,FForbidStatus';

export function liveProjectCatalog({ browser, origin }: { browser: BrowserPort; origin: string }): ProjectCatalog {
  return {
    async lookup(number): Promise<CatalogLookup> {
      if (!isSafeProjectNumber(number)) return { ok: false, reason: 'query_failed', message: '项目号含有不能安全查询的字符' };
      let pages: ChromiumPage[];
      try {
        pages = (await browser.listPages()).filter((page) => sameOrigin(page.url, origin));
      } catch {
        return { ok: false, reason: 'not_logged_in', message: UNAVAILABLE_MESSAGE };
      }
      const sessions = new Map<string, CdpSession>();
      const sessionOf = async (page: ChromiumPage) => {
        const key = String(page.cdpTargetId ?? page.url);
        if (!sessions.has(key)) sessions.set(key, (await browser.attach(page)).session);
        return sessions.get(key)!;
      };
      try {
        const probe = await probeIdentity({
          origin, waitMs: 0, transport: 'chromium-cdp',
          listTabs: async () => pages,
          evaluate: async (page, expression) => evalIn(await sessionOf(page as ChromiumPage), expression, { timeout: 10_000 }),
        });
        if (probe.status !== 'matched' || !probe.page) return { ok: false, reason: 'not_logged_in', message: probe.hint ?? UNAVAILABLE_MESSAGE };
        const answer = await queryRows(await sessionOf(probe.page as ChromiumPage), { formId: PROJECT_FORM, fieldKeys: FIELDS, filter: `FNumber = '${number}'`, limit: 5 });
        if (!answer.ok) return { ok: false, reason: 'query_failed', message: answer.reason };
        return verdictOf(answer.rows.map((row) => ({ number: String(row[0]), name: String(row[1]), audited: row[2] === 'C', forbidden: row[3] !== 'A' })));
      } catch (error) {
        return { ok: false, reason: 'query_failed', message: error instanceof Error ? error.message : String(error) };
      } finally {
        for (const session of sessions.values()) {
          try {
            session.close();
          } catch {
            // already closed
          }
        }
      }
    },
  };
}
