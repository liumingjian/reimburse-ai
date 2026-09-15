import { readFileSync } from 'node:fs';

// The project catalog port (ADR-0008): a read-only "does this project number exist and may it be referenced" check
// against ERP's own query service (`ExecuteBillQuery` on the `BJYC_ProJect` form, fields FNumber, FName,
// FDocumentStatus, FForbidStatus), run in the user's logged-in ERP session. It checks, it never syncs: only the
// numbers asked about are looked up, and the book stores only those.
// Ported from kernel/src/erpcatalog.mjs `verifyProject` (verdicts) and projectintake.mjs (retries).
//
// The live adapter needs the ERP browser session, which the ERP job slice (#191) owns; until it is wired the server
// runs with `unavailableCatalog()` (every lookup answers not_logged_in). Tests and the e2e server use `fixtureCatalog`.

// Project numbers go into an ERP filter string, so only characters that cannot change its meaning pass.
const SAFE = /^[A-Za-z0-9_-]{1,64}$/;
export const isSafeProjectNumber = (value: string): boolean => SAFE.test(value);

export type CatalogLookup =
  | { ok: true; verdict: 'confirmed'; name: string }
  | { ok: true; verdict: 'missing' }
  | { ok: true; verdict: 'ambiguous'; count: number }
  | { ok: true; verdict: 'unusable'; name: string }
  // The lookup did not happen: no logged-in ERP session, or the query itself failed. Never "passed".
  | { ok: false; reason: 'not_logged_in' | 'query_failed'; message: string };

export interface ProjectCatalog {
  lookup(number: string): Promise<CatalogLookup>;
}

// One row of the ERP query answer, already decoded: FDocumentStatus 'C' = audited, FForbidStatus 'A' = not forbidden.
export type CatalogRow = { number: string; name: string; audited: boolean; forbidden: boolean };

// The kernel verdict rules over the rows a `FNumber = '<number>'` query returned.
export function verdictOf(rows: readonly CatalogRow[]): CatalogLookup {
  if (rows.length === 0) return { ok: true, verdict: 'missing' };
  if (rows.length > 1) return { ok: true, verdict: 'ambiguous', count: rows.length };
  const [row] = rows as [CatalogRow];
  if (!row.audited || row.forbidden) return { ok: true, verdict: 'unusable', name: row.name };
  return { ok: true, verdict: 'confirmed', name: row.name.trim() };
}

export const UNAVAILABLE_MESSAGE = '没有已登录的报销系统会话';

export function unavailableCatalog(): ProjectCatalog {
  return { lookup: async () => ({ ok: false, reason: 'not_logged_in', message: UNAVAILABLE_MESSAGE }) };
}

export type FixtureCatalog = ProjectCatalog & { replace: (rows: readonly CatalogRow[]) => void };

// A fixture-backed fake with the live adapter's verdicts. `replace` swaps the rows (a later ERP change);
// `unavailable` answers every lookup like a missing ERP session.
export function fixtureCatalog(rows: readonly CatalogRow[], { unavailable = false } = {}): FixtureCatalog {
  let current = [...rows];
  return {
    async lookup(number) {
      if (unavailable) return { ok: false, reason: 'not_logged_in', message: UNAVAILABLE_MESSAGE };
      return verdictOf(current.filter((row) => row.number === number));
    },
    replace(next) {
      current = [...next];
    },
  };
}

// `BAOX_PROJECT_CATALOG_FIXTURE=<json file of CatalogRow[]>` makes the server use the fake (e2e only). Without it the
// catalog is unavailable until #191 passes the live adapter.
export function catalogFromEnv(env: NodeJS.ProcessEnv = process.env): ProjectCatalog {
  const file = env['BAOX_PROJECT_CATALOG_FIXTURE'];
  if (!file) return unavailableCatalog();
  return fixtureCatalog(JSON.parse(readFileSync(file, 'utf8')) as CatalogRow[]);
}
