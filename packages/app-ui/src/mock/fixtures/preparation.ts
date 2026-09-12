import type { Catalog, CatalogProblem, Line, Material, PackageFile, Preparation, PreparationProblem, ProjectAssignment } from '../../contract/snapshot';
import { fixtureIdOfFile } from './inventory';

// 报销信息核对（catalog）与报销材料准备（preparation）的 mock 服务端判定。
// 行文字照内核话术成句（next.mjs itemTable / preparationProblemTable；「ERP」写作「报销系统」）。

export const catalogPending = (): Catalog => ({ status: 'pending', problems: [] });
export const catalogRunning = (): Catalog => ({ status: 'running', problems: [] });
export const catalogMatched = (): Catalog => ({ status: 'matched', problems: [] });
export const preparationPending = (): Preparation => ({ status: 'pending', problems: [], packageFiles: [] });

// `?catalog=mismatch`：mock 报销系统目录里 P-2307 已被禁用（项目簿里仍是上次核对通过的样子）。
export const CATALOG_MISMATCH_PROJECT = 'P-2307';

// 核对提交的项目归属：用到被禁用项目的，每个项目号一行（内核 verifyProject 的 unusable 结论）。
export function catalogProblems(assignment: ProjectAssignment, mismatch: boolean): CatalogProblem[] {
  if (!mismatch) return [];
  const used = assignment.assignments.find((item) => item.projectNumber === CATALOG_MISMATCH_PROJECT);
  if (!used) return [];
  return [
    {
      subject: `项目号 ${used.projectNumber}`,
      reference: null,
      reason: `项目 ${used.projectNumber}「${used.projectName}」在报销系统里已被禁用，不能引用`,
      resolver: '要你处理',
    },
  ];
}

// 材料包文件清单（mock 的构成，照内核 manifest.files：发票副本、参考材料、detail.json、detail.md、manifest.json）。
// 发票与参考材料按 materialId 排序。T1 得到 7 + 3 + 3 = 13 份。
export function packageFilesOf(lines: readonly Line[], materials: readonly Material[]): PackageFile[] {
  const nameOf = new Map(materials.map((material) => [material.materialId, material.fileName]));
  const sorted = (ids: Iterable<string>) => [...new Set(ids)].sort((a, b) => a.localeCompare(b));
  const invoices = sorted(lines.map((line) => line.voucherMaterialId));
  const references = sorted(lines.flatMap((line) => line.referenceMaterialIds));
  return [
    ...invoices.map((id) => ({ path: `invoices/${nameOf.get(id) ?? id}`, kindLabel: '发票' })),
    // 类别名不写「参考材料」（确认页不出现这四个字）；行程单、结账单在材料包里是证明材料。
    ...references.map((id) => ({ path: `evidence/${nameOf.get(id) ?? id}`, kindLabel: '证明材料' })),
    { path: 'detail.json', kindLabel: '明细数据' },
    { path: 'detail.md', kindLabel: '明细文档' },
    { path: 'manifest.json', kindLabel: '材料清单' },
  ];
}

// `?preparation=blocked`：曹操出行行程单（示例材料 m06）仍作为参考材料时，它记的上车点与明细对不上，材料包判为缺项。
// 处置是排除这份行程单（服务端据此给出 excludableMaterialId）；排除后重新准备即通过。
export function preparationProblems(lines: readonly Line[], materials: readonly Material[], blocked: boolean): PreparationProblem[] {
  if (!blocked) return [];
  const itinerary = materials.find((material) => material.role === 'reference' && fixtureIdOfFile(material.fileName) === 'm06');
  if (!itinerary) return [];
  const line = lines.find((candidate) => candidate.referenceMaterialIds.includes(itinerary.materialId));
  if (!line) return [];
  return [
    {
      problemId: `prep-${itinerary.materialId}`,
      missing: `明细 No.${line.no} 的出发点与行程单不一致：行程单记的是「浦东国际机场 T2」，明细是「${line.origin ?? '未填写'}」`,
      subject: itinerary.fileName,
      resolver: '要你处理',
      excludableMaterialId: itinerary.materialId,
    },
  ];
}
