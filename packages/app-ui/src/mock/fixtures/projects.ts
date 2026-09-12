import { isRealDate } from '../../contract/actions';
import type { ProjectBookEntry } from '../../contract/project-book';
import type { ProjectAssignment, ProjectOption, Step, TaskSnapshot } from '../../contract/snapshot';

// 个人项目簿夹具：虚构的项目号与名称（沿用 prototypes/project-assignment-patterns 的写法），以及 mock「报销系统项目目录」。
// 可选判定、状态标签与说明照内核 projects.mjs annotateProjects 移植（「ERP」写作「报销系统」），由 mock 服务端给出。

// 夹具员工的常驻城市，也是 mock 位置 Adapter 第一次给出的城市级网络位置候选（见 mock-adapter 的 homeCityDefault）。
// 夹具任务 T1/T2/T3 都以它为城市快照；T1 的上海市内交通因此是外地市内交通。
export const HOME_CITY = '杭州';

// mock 服务端判定过期用的「今天」（与 mock 时钟同一天）。
export const MOCK_TODAY = '2026-09-11';

// 项目簿里存的一条（内核 projects.mjs normalize）：名称只取报销系统回读值；lastVerdict 是最近一次核验结论。
export type StoredProject = {
  number: string;
  name: string | null;
  expiresOn: string | null;
  lastCheckedAt: string | null;
  lastVerdict: string;
};

// 默认项目簿：4 条可选，P-4420 已过期，P-0917 复检未通过（最近一次核验：不可引用）。`?book=empty` 时为空。
export const INITIAL_BOOK: readonly StoredProject[] = [
  { number: 'P-2307', name: '华东客户交付', expiresOn: null, lastCheckedAt: '2026-09-01T09:30:00', lastVerdict: 'confirmed' },
  { number: 'P-2311', name: '华东客户交付二期', expiresOn: '2026-12-31', lastCheckedAt: '2026-09-01T09:30:00', lastVerdict: 'confirmed' },
  { number: 'P-3312', name: '产品调研', expiresOn: null, lastCheckedAt: '2026-09-01T09:30:00', lastVerdict: 'confirmed' },
  { number: 'P-1180', name: '内部培训', expiresOn: null, lastCheckedAt: '2026-09-01T09:30:00', lastVerdict: 'confirmed' },
  { number: 'P-4420', name: '南京客户培训', expiresOn: '2026-08-31', lastCheckedAt: '2026-09-01T09:30:00', lastVerdict: 'confirmed' },
  { number: 'P-0917', name: '旧版对账工具', expiresOn: null, lastCheckedAt: '2026-09-01T09:30:00', lastVerdict: 'unusable' },
];

// mock 报销系统项目目录：录入与复检按这张表给出核验结论；表里没有的安全项目号一律「查不到」（missing）。
export type DirectoryVerdict =
  | { verdict: 'confirmed'; name: string }
  | { verdict: 'unusable'; name: string }
  | { verdict: 'ambiguous'; count: number }
  // 查询没有完成（内核 verifyProject ok:false，重试后仍失败）。
  | { verdict: 'failed'; reason: string };

export const ERP_PROJECT_DIRECTORY: Readonly<Record<string, DirectoryVerdict>> = {
  'P-2307': { verdict: 'confirmed', name: '华东客户交付' },
  'P-2311': { verdict: 'confirmed', name: '华东客户交付二期' },
  'P-3312': { verdict: 'confirmed', name: '产品调研' },
  'P-1180': { verdict: 'confirmed', name: '内部培训' },
  'P-4420': { verdict: 'confirmed', name: '南京客户培训' },
  'P-5108': { verdict: 'confirmed', name: '苏州门店巡检' },
  'P-6021': { verdict: 'confirmed', name: '年度预算评审' },
  'P-0917': { verdict: 'unusable', name: '旧版对账工具' },
  'P-7700': { verdict: 'ambiguous', count: 2 },
  'P-9000': { verdict: 'failed', reason: '项目目录查询超时' },
};

export function verifyProjectNumber(number: string): DirectoryVerdict | { verdict: 'missing' } {
  return ERP_PROJECT_DIRECTORY[number] ?? { verdict: 'missing' };
}

// 内核 projects.mjs：安全项目号是 1-64 个字母、数字、下划线或连字符。
const SAFE_PROJECT_NUMBER = /^[A-Za-z0-9_-]{1,64}$/;
export const isSafeProjectNumber = (value: string): boolean => SAFE_PROJECT_NUMBER.test(value);

type InvalidReason = 'unsafe' | 'expired' | 'unconfirmed';
const REASON_LABEL: Readonly<Record<InvalidReason, string>> = { expired: '已过期', unconfirmed: '复检未通过', unsafe: '项目号不安全' };
const VERDICT_NOTE: Readonly<Record<string, string>> = {
  missing: '最近一次核对时报销系统里查不到这个项目号',
  ambiguous: '最近一次核对时这个项目号在报销系统里对上了多条记录',
  unusable: '最近一次核对时这个项目已被报销系统禁用或尚未审核',
  unsafe: '这个项目号含有不能安全查询的字符，请删除后从报销系统重新录入',
};

function invalidReasons(project: StoredProject, today: string): InvalidReason[] {
  const reasons: InvalidReason[] = [];
  if (!isSafeProjectNumber(project.number)) reasons.push('unsafe');
  if (project.expiresOn !== null && (!isRealDate(project.expiresOn) || project.expiresOn < today)) reasons.push('expired');
  if (project.lastVerdict !== 'confirmed') reasons.push('unconfirmed');
  return reasons;
}

// 内核 annotateProjects：可选 = 安全项目号 + 未过期 + 最近一次核验 confirmed；标签按原因用「・」连接，说明用「；」连接。
export function annotateProject(project: StoredProject, today: string): ProjectBookEntry {
  const reasons = invalidReasons(project, today);
  const notes = reasons.map((reason) => {
    if (reason === 'expired') {
      return project.expiresOn !== null && isRealDate(project.expiresOn) ? `已过期（过期时间 ${project.expiresOn}）` : `过期时间读不出来（${String(project.expiresOn)}），当作已过期`;
    }
    if (reason === 'unsafe') return '项目号含有不能安全查询的字符，请删除后从报销系统重新录入';
    return VERDICT_NOTE[project.lastVerdict] ?? `最近一次核对结果不是 confirmed（${project.lastVerdict}）`;
  });
  return {
    number: project.number,
    name: project.name,
    expiresOn: project.expiresOn,
    lastCheckedAt: project.lastCheckedAt,
    selectable: reasons.length === 0,
    statusLabel: reasons.length > 0 ? reasons.map((reason) => REASON_LABEL[reason]).join('・') : '可选',
    statusNote: notes.length > 0 ? notes.join('；') : null,
  };
}

// 项目归属页的允许列表（随任务快照给出）：整份项目簿，selectable 与 statusLabel 照搬项目簿的判定。
export function allowListOf(entries: readonly ProjectBookEntry[]): ProjectOption[] {
  return entries.map((entry) => ({ number: entry.number, name: entry.name ?? entry.number, selectable: entry.selectable, statusLabel: entry.statusLabel }));
}

// 默认项目簿对应的允许列表（夹具快照构建时用；mock 服务端运行时按当前项目簿重新给出）。
export const PROJECT_BOOK: readonly ProjectOption[] = allowListOf(INITIAL_BOOK.map((project) => annotateProject(project, MOCK_TODAY)));

// `?seed=project` 预置的归属：No.1 与 No.2（高德前两段）已归入 P-2307，用来演示批量归入时的冲突处理。
export const SEED_ASSIGNMENTS: Readonly<Record<string, string>> = { l1: 'P-2307', l2: 'P-2307' };

export const T1_PURPOSE = '上海产品评审出差';

export function projectName(number: string, projects: readonly ProjectOption[] = PROJECT_BOOK): string {
  return projects.find((project) => project.number === number)?.name ?? number;
}

function toAssignments(projects: Readonly<Record<string, string>>, allowList: readonly ProjectOption[]): ProjectAssignment['assignments'] {
  return Object.entries(projects).map(([lineId, projectNumber]) => ({ lineId, projectNumber, projectName: projectName(projectNumber, allowList) }));
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
export function projectAssignmentOpen(homeCity: string, assignments: Readonly<Record<string, string>> = {}, allowList: readonly ProjectOption[] = PROJECT_BOOK): ProjectAssignment {
  return {
    status: Object.keys(assignments).length > 0 ? 'pending' : 'not_started',
    purpose: null,
    homeCity,
    assignments: toAssignments(assignments, allowList),
    projects: allowList.map((project) => ({ ...project })),
    submittedAt: null,
  };
}

export function projectAssignmentSubmitted(input: {
  purpose: string;
  homeCity: string;
  projects: Readonly<Record<string, string>>;
  submittedAt: string;
  allowList?: readonly ProjectOption[];
}): ProjectAssignment {
  const allowList = input.allowList ?? PROJECT_BOOK;
  return {
    status: 'submitted',
    purpose: input.purpose,
    homeCity: input.homeCity,
    assignments: toAssignments(input.projects, allowList),
    projects: allowList.map((project) => ({ ...project })),
    submittedAt: input.submittedAt,
  };
}

// 进入项目归属时的 step（内核 project_book_empty 在 select-task 之前）：项目簿没有可选项目、也还没有任何归属时先维护项目簿；
// 否则就是项目归属。第一次录入成功后服务端据此回到 assign_projects。
export function projectEntryStep(snapshot: TaskSnapshot): Step {
  const taskId = snapshot.task.taskId;
  const version = snapshot.inventory.versionId ?? 'v0';
  const assignment = snapshot.projectAssignment;
  const bookEmpty = !assignment.projects.some((project) => project.selectable) && assignment.assignments.length === 0;
  return bookEmpty ? { kind: 'maintain_project_book', stepToken: `tok-${taskId}-book-${version}` } : { kind: 'assign_projects', stepToken: `tok-${taskId}-project-${version}` };
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
