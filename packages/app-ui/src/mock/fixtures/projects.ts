import type { ProjectAssignment, ProjectOption } from '../../contract/snapshot';

// 个人项目簿夹具：虚构的项目号与名称（沿用 prototypes/project-assignment-patterns 的写法）。
// selectable 与 statusLabel 是 mock 服务端的判定结果，照内核 annotateProjects 的文案：可选 / 已过期 / 复检未通过。

// 夹具员工的常驻城市，也是 mock 位置 Adapter 第一次给出的城市级网络位置候选（见 mock-adapter 的 homeCityDefault）。
// 夹具任务 T1/T2/T3 都以它为城市快照；T1 的上海市内交通因此是外地市内交通。
export const HOME_CITY = '杭州';

export const PROJECT_BOOK: readonly ProjectOption[] = [
  { number: 'P-2307', name: '华东客户交付', selectable: true, statusLabel: '可选' },
  { number: 'P-2311', name: '华东客户交付二期', selectable: true, statusLabel: '可选' },
  { number: 'P-3312', name: '产品调研', selectable: true, statusLabel: '可选' },
  { number: 'P-1180', name: '内部培训', selectable: true, statusLabel: '可选' },
  { number: 'P-4420', name: '南京客户培训', selectable: false, statusLabel: '已过期' },
  { number: 'P-0917', name: '旧版对账工具', selectable: false, statusLabel: '复检未通过' },
];

// `?seed=project` 预置的归属：No.1 与 No.2（高德前两段）已归入 P-2307，用来演示批量归入时的冲突处理。
export const SEED_ASSIGNMENTS: Readonly<Record<string, string>> = { l1: 'P-2307', l2: 'P-2307' };

export const T1_PURPOSE = '上海产品评审出差';

export function projectName(number: string): string {
  return PROJECT_BOOK.find((project) => project.number === number)?.name ?? number;
}

function toAssignments(projects: Readonly<Record<string, string>>): ProjectAssignment['assignments'] {
  return Object.entries(projects).map(([lineId, projectNumber]) => ({ lineId, projectNumber, projectName: projectName(projectNumber) }));
}

// mock 的整单确认摘要：绑定盘点版本、报销事由与逐条项目归属（内核 preparationDigest 含 selection；材料包部分待服务端 spec 确认）。
// 归属或事由一变，摘要就变，旧确认随之失效。
export function confirmationDigest(taskId: string, versionId: string | null, assignment: ProjectAssignment): string {
  const pairs = [...assignment.assignments].sort((a, b) => (a.lineId < b.lineId ? -1 : 1)).map((item) => `${item.lineId}=${item.projectNumber}`);
  let hash = 0x811c9dc5;
  for (const ch of [assignment.purpose ?? '', ...pairs].join('|')) {
    hash ^= ch.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `digest-${taskId.toLowerCase()}-${versionId ?? 'v0'}-${hash.toString(16).padStart(8, '0')}`;
}

// 待确认项处理完、进入项目归属时，服务端随快照给出整份允许列表；还没提交时可能有预置归属。
// homeCity 是任务自己的常驻城市快照（task.homeCity）。
export function projectAssignmentOpen(homeCity: string, assignments: Readonly<Record<string, string>> = {}): ProjectAssignment {
  return {
    status: Object.keys(assignments).length > 0 ? 'pending' : 'not_started',
    purpose: null,
    homeCity,
    assignments: toAssignments(assignments),
    projects: PROJECT_BOOK.map((project) => ({ ...project })),
    submittedAt: null,
  };
}

export function projectAssignmentSubmitted(input: { purpose: string; homeCity: string; projects: Readonly<Record<string, string>>; submittedAt: string }): ProjectAssignment {
  return {
    status: 'submitted',
    purpose: input.purpose,
    homeCity: input.homeCity,
    assignments: toAssignments(input.projects),
    projects: PROJECT_BOOK.map((project) => ({ ...project })),
    submittedAt: input.submittedAt,
  };
}

// 已提交归属的 T1：9 条明细全部归属（No.1-6 外地市内交通归入 P-3312，No.7-9 长途交通与住宿归入 P-2307）。
export const T1_DONE_ASSIGNMENTS: Readonly<Record<string, string>> = {
  l1: 'P-3312',
  l2: 'P-3312',
  l3: 'P-3312',
  l4: 'P-3312',
  l5: 'P-3312',
  l6: 'P-3312',
  l7: 'P-2307',
  l8: 'P-2307',
  l9: 'P-2307',
};
