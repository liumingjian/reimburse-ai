import type { Catalog, CatalogProblem, Preparation, ProjectAssignment } from '@baox/contract';

// The catalog check (报销信息核对) and the material preparation (报销材料准备), as the server projects them
// (server/src/task-snapshot.ts). The server checks the catalog inside the ERP job, so a task never stops in the
// catalog / preparation stages: the catalog stays `pending` until an ERP job reports a mismatch, and preparation turns
// `ready` (no problems, no package files) once a confirmable digest exists.

export const catalogPending = (): Catalog => ({ status: 'pending', problems: [] });
export const preparationPending = (): Preparation => ({ status: 'pending', problems: [], packageFiles: [] });
export const preparationReady = (): Preparation => ({ status: 'ready', problems: [], packageFiles: [] });

// `?fault=catalog-mismatch`: the project number is missing in ERP, so the job stops before import.
export const CATALOG_MISMATCH_PROJECT = 'P-2307';

// Keep the missing-project reason aligned with the server's catalog view.
export function catalogMismatch(assignment: ProjectAssignment): Catalog | null {
  const used = assignment.assignments.find((item) => item.projectNumber === CATALOG_MISMATCH_PROJECT);
  if (!used) return null;
  const problems: CatalogProblem[] = [
    {
      subject: `项目号 ${used.projectNumber}`,
      reference: null,
      reason: `项目 ${used.projectNumber}「${used.projectName}」在报销系统里查不到`,
      resolver: '要你处理',
    },
  ];
  return { status: 'mismatch', problems };
}
