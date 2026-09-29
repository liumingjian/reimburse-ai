import type { Catalog, CatalogProblem, Preparation, ProjectAssignment } from '@baox/contract';

// The catalog check (报销信息核对) and the material preparation (报销材料准备), as the server projects them
// (server/src/task-snapshot.ts). The server checks the catalog inside the ERP job, so a task never stops in the
// catalog / preparation stages: the catalog stays `pending` until an ERP job reports a mismatch, and preparation turns
// `ready` (no problems, no package files) once a confirmable digest exists.

export const catalogPending = (): Catalog => ({ status: 'pending', problems: [] });
export const preparationPending = (): Preparation => ({ status: 'pending', problems: [], packageFiles: [] });
export const preparationReady = (): Preparation => ({ status: 'ready', problems: [], packageFiles: [] });

// `?fault=catalog-mismatch`: the mock ERP catalog knows project P-2307 under another name, so the ERP job stops at its
// catalog step. The name is the one the server's scripted job reports (server/src/erp/testing/fake-executor.ts).
export const CATALOG_MISMATCH_PROJECT = 'P-2307';
export const CATALOG_MISMATCH_RENAMED_AS = '改过名的项目';

// The catalog verdict the ERP job reports for the submitted assignment: one row per renamed project, worded like the
// server's catalogView (server/src/task-snapshot/erp.ts, verdict name_mismatch).
export function catalogMismatch(assignment: ProjectAssignment): Catalog | null {
  const used = assignment.assignments.find((item) => item.projectNumber === CATALOG_MISMATCH_PROJECT);
  if (!used) return null;
  const problems: CatalogProblem[] = [
    {
      subject: `项目号 ${used.projectNumber}`,
      reference: null,
      reason: `项目 ${used.projectNumber} 在报销系统里的名称是「${CATALOG_MISMATCH_RENAMED_AS}」，与本地的「${used.projectName}」不一致`,
      resolver: '要你处理',
    },
  ];
  return { status: 'mismatch', problems };
}
