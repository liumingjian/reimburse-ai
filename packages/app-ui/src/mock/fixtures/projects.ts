import type { ProjectAssignment, ProjectOption } from '../../contract/snapshot';

// 个人项目簿夹具：虚构的项目号与名称（沿用 prototypes/project-assignment-patterns 的写法）。
// selectable 与 statusLabel 是 mock 服务端的判定结果，照内核 annotateProjects 的文案：可选 / 已过期 / 复检未通过。

export const HOME_CITY = '杭州';

export const PROJECT_BOOK: readonly ProjectOption[] = [
  { number: 'P-2307', name: '华东客户交付', selectable: true, statusLabel: '可选' },
  { number: 'P-2311', name: '华东客户交付二期', selectable: true, statusLabel: '可选' },
  { number: 'P-3312', name: '产品调研', selectable: true, statusLabel: '可选' },
  { number: 'P-1180', name: '内部培训', selectable: true, statusLabel: '可选' },
  { number: 'P-4420', name: '南京客户培训', selectable: false, statusLabel: '已过期' },
  { number: 'P-0917', name: '旧版对账工具', selectable: false, statusLabel: '复检未通过' },
];

// `?seed=project` 预置的归属：No.1 与 No.2 已归入 P-2307，用来演示批量归入时的冲突处理。
export const SEED_ASSIGNMENTS: Readonly<Record<string, string>> = { l1: 'P-2307', l2: 'P-2307' };

export const T1_PURPOSE = '上海产品评审出差';

export function projectName(number: string): string {
  return PROJECT_BOOK.find((project) => project.number === number)?.name ?? number;
}

function toAssignments(projects: Readonly<Record<string, string>>): ProjectAssignment['assignments'] {
  return Object.entries(projects).map(([lineId, projectNumber]) => ({ lineId, projectNumber, projectName: projectName(projectNumber) }));
}

// 整单明细确认之后，服务端随快照给出整份允许列表；还没进入项目归属时没有归属。
export function projectAssignmentOpen(assignments: Readonly<Record<string, string>> = {}): ProjectAssignment {
  return {
    status: Object.keys(assignments).length > 0 ? 'pending' : 'not_started',
    purpose: null,
    homeCity: HOME_CITY,
    assignments: toAssignments(assignments),
    projects: PROJECT_BOOK.map((project) => ({ ...project })),
    submittedAt: null,
  };
}

export function projectAssignmentSubmitted(input: { purpose: string; projects: Readonly<Record<string, string>>; submittedAt: string }): ProjectAssignment {
  return {
    status: 'submitted',
    purpose: input.purpose,
    homeCity: HOME_CITY,
    assignments: toAssignments(input.projects),
    projects: PROJECT_BOOK.map((project) => ({ ...project })),
    submittedAt: input.submittedAt,
  };
}

// 已完成的 T1：9 条明细全部归属（住宿与长途归入 P-2307，市内交通归入 P-3312）。
export const T1_DONE_ASSIGNMENTS: Readonly<Record<string, string>> = {
  l1: 'P-2307',
  l2: 'P-2307',
  l3: 'P-3312',
  l4: 'P-3312',
  l5: 'P-3312',
  l6: 'P-3312',
  l7: 'P-3312',
  l8: 'P-3312',
  l9: 'P-2307',
};
