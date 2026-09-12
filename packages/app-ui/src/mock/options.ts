import { TASK_STAGES, type TaskStage } from '../contract/stage';

// mock 模式的查询参数：`?seed=<阶段>` 直接打开某阶段的快照，`?fault=<场景>` 注入一种故障，
// `?location=unavailable` 让位置 Adapter 取不到网络位置。

export const FAULTS = [
  'duplicate-upload',
  'unsupported-material',
  'erp-login-missing',
  'erp-write-aborted',
  'readback-mismatch',
  'service-disconnected',
] as const;
export type Fault = (typeof FAULTS)[number];

// 票面上用过的别名：`?seed=assign` 与 `?seed=project` 相同（阶段枚举里叫 project）；
// `?seed=print` 是 actions 阶段（打印稿预览不是阶段），且打印稿已经生成。
const SEED_ALIASES: Readonly<Record<string, TaskStage>> = { assign: 'project', print: 'actions' };

// `?identity=`：启动时报销人身份的状态（不给则已登记）。unbound 还没登记，显示身份确认表；mismatched 当前登录与已登记的人不一致，整页阻塞。
export const IDENTITY_OPTIONS = ['unbound', 'mismatched'] as const;
export type IdentityOption = (typeof IDENTITY_OPTIONS)[number];

// mock 的「持久存储」：浏览器里是 localStorage（刷新后仍在），按 tenant + account 分键；测试可以注入替身。
export type MockStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

export type MockOptions = {
  seed: TaskStage | null;
  fault: Fault | null;
  // `?erp=logged-out`：启动时报销系统还没登录，先显示登录提示；「我已登录」第一次再探测即通过，之后进入身份确认（除非此前已登记）。
  erpLoggedOut?: boolean;
  identity?: IdentityOption;
  // `?book=empty`：个人项目簿初始为空；走到项目归属时先进入维护入口，第一次录入成功后回到项目归属。
  bookEmpty?: boolean;
  // `?catalog=mismatch`：报销信息核对把项目 P-2307 判为不匹配（报销系统里已被禁用）；把用到它的明细改派到别的项目后重新提交即通过。
  catalogMismatch?: boolean;
  // `?preparation=blocked`：材料包缺项（曹操出行行程单与明细对不上）；排除这份行程单后重新准备即通过。
  preparationBlocked?: boolean;
  // `?allocation=1`：盘点时高德合并发票的行程单三段合计 69.10 和票面价税合计 69.19 对不上，多出一个逐段分摊待确认项（mock 服务端按分判定守恒）。
  allocationRequired?: boolean;
  // `?duplicate=1`：盘点时跨任务查重命中（铁路电子客票_0809.pdf 已在已完成的任务 T3 里），整批停。
  duplicateHit?: boolean;
  storage?: MockStorage;
  // `?location=unavailable`：mock 位置 Adapter 取不到网络位置，第一次新建任务时常驻城市没有默认值。不是故障场景。
  locationUnavailable?: boolean;
  // `?seed=print`：T1 的打印稿在打开时已经生成。
  printSheet?: boolean;
  // 盘点每个阶段的推进间隔（毫秒）；测试可以调小。
  inventoryPhaseMs?: number;
  // 提交项目归属后，报销信息核对 → 材料准备 → 整单确认每步的推进间隔（毫秒，默认 600）；测试可以调小。
  autoStepMs?: number;
  // ERP 填报每一步的推进间隔（毫秒，默认 300）；正常场景下服务端自动探测到登录的延迟（默认 2500）。
  erpStepMs?: number;
  erpLoginAutoMs?: number;
  // `?fault=service-disconnected`：第一次订阅后多久断开（默认 300），断开后多久恢复（默认 3000）。
  disconnectAfterMs?: number;
  reconnectAfterMs?: number;
};

export function readMockOptions(search: string): MockOptions {
  const params = new URLSearchParams(search);
  const seed = params.get('seed');
  const fault = params.get('fault');
  const options: MockOptions = { seed: null, fault: null };
  if (seed !== null) {
    const stage = SEED_ALIASES[seed] ?? seed;
    if (isStage(stage)) options.seed = stage;
    else console.warn(`未知的 seed「${seed}」，可用值：${[...TASK_STAGES, ...Object.keys(SEED_ALIASES)].join(', ')}`);
    if (seed === 'print') options.printSheet = true;
  }
  if (fault !== null) {
    if (isFault(fault)) options.fault = fault;
    else console.warn(`未知的 fault「${fault}」，可用值：${FAULTS.join(', ')}`);
  }
  const location = params.get('location');
  if (location !== null) {
    if (location === 'unavailable') options.locationUnavailable = true;
    else console.warn(`未知的 location「${location}」，可用值：unavailable`);
  }
  const erp = params.get('erp');
  if (erp !== null) {
    if (erp === 'logged-out') options.erpLoggedOut = true;
    else console.warn(`未知的 erp「${erp}」，可用值：logged-out`);
  }
  const book = params.get('book');
  if (book !== null) {
    if (book === 'empty') options.bookEmpty = true;
    else console.warn(`未知的 book「${book}」，可用值：empty`);
  }
  const catalog = params.get('catalog');
  if (catalog !== null) {
    if (catalog === 'mismatch') options.catalogMismatch = true;
    else console.warn(`未知的 catalog「${catalog}」，可用值：mismatch`);
  }
  const preparation = params.get('preparation');
  if (preparation !== null) {
    if (preparation === 'blocked') options.preparationBlocked = true;
    else console.warn(`未知的 preparation「${preparation}」，可用值：blocked`);
  }
  const allocation = params.get('allocation');
  if (allocation !== null) {
    if (allocation === '1') options.allocationRequired = true;
    else console.warn(`未知的 allocation「${allocation}」，可用值：1`);
  }
  const duplicate = params.get('duplicate');
  if (duplicate !== null) {
    if (duplicate === '1') options.duplicateHit = true;
    else console.warn(`未知的 duplicate「${duplicate}」，可用值：1`);
  }
  const identity = params.get('identity');
  if (identity !== null) {
    if ((IDENTITY_OPTIONS as readonly string[]).includes(identity)) options.identity = identity as IdentityOption;
    else console.warn(`未知的 identity「${identity}」，可用值：${IDENTITY_OPTIONS.join(', ')}`);
  }
  return options;
}

function isStage(value: string): value is TaskStage {
  return (TASK_STAGES as readonly string[]).includes(value);
}

function isFault(value: string): value is Fault {
  return (FAULTS as readonly string[]).includes(value);
}
