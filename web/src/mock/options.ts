import { TASK_STAGES, type TaskStage } from '@baox/contract';

// mock 模式的查询参数：`?seed=<阶段>` 直接打开某阶段的快照，`?fault=<场景>` 注入一种故障，
// `?location=unavailable` 让位置 Adapter 取不到网络位置。

export const FAULTS = [
  'duplicate-upload',
  'unsupported-material',
  'erp-login-missing',
  'erp-write-aborted',
  'erp-stopped-before-write',
  'readback-mismatch',
  'service-disconnected',
] as const;
export type Fault = (typeof FAULTS)[number];

// 票面上用过的别名：`?seed=assign` 与 `?seed=project` 相同（阶段枚举里叫 project）；
// `?seed=print` 是 actions 阶段（打印稿预览不是阶段），且打印稿已经生成。
const SEED_ALIASES: Readonly<Record<string, TaskStage>> = { assign: 'project', print: 'actions' };

// `?auth=`：打开时的登录状态（不给则夹具账号已登录）。setup 还没有任何账号，只能创建管理员；signed-out 有夹具账号但没登录。
export const AUTH_OPTIONS = ['setup', 'signed-out'] as const;
export type AuthOption = (typeof AUTH_OPTIONS)[number];

// `?legacy=`：旧数据导入那一次的结果。failed 才有重试与跳过。
export const LEGACY_OPTIONS = ['failed', 'imported', 'absent'] as const;
export type LegacyOption = (typeof LEGACY_OPTIONS)[number];

export const EXTENSION_OPTIONS = ['paired', 'disconnected'] as const;

// mock 的「持久存储」：浏览器里是 localStorage（刷新后仍在），按账号分键；测试可以注入替身。
export type MockStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
};

export type MockOptions = {
  seed: TaskStage | null;
  fault: Fault | null;
  auth?: AuthOption;
  // `?book=empty`：个人项目簿初始为空；走到项目归属时先进入维护入口，第一次录入成功后回到项目归属。
  bookEmpty?: boolean;
  // `?deadline=warning` gives P-2307 a deadline for the isolated browser acceptance scenario.
  deadlineWarning?: boolean;
  // `?catalog=mismatch`：报销信息核对把项目 P-2307 判为不匹配（报销系统里已被禁用）；把用到它的明细改派到别的项目后重新提交即通过。
  catalogMismatch?: boolean;
  // `?preparation=blocked`：材料包缺项（曹操出行行程单与明细对不上）；排除这份行程单后重新准备即通过。
  preparationBlocked?: boolean;
  // `?allocation=1`：盘点时高德合并发票的行程单三段合计 69.10 和票面价税合计 69.19 对不上，多出一个逐段分摊待确认项（mock 服务端按分判定守恒）。
  allocationRequired?: boolean;
  // `?duplicate=1`：盘点时跨任务查重命中（铁路电子客票_0809.pdf 已在已完成的任务 T3 里），整批停。
  duplicateHit?: boolean;
  // `?legacy=failed|imported|absent`：设置页的旧数据导入面板摆出那一次导入的结果（不给则「没有运行过」）。
  legacy?: LegacyOption;
  // `?extension=paired|disconnected` sets the browser extension panel to its paired or disconnected state.
  extensionPaired?: boolean;
  extensionConnected?: boolean;
  // `?extensionOrigin=<origin>` sets the active application address for extension download and pairing.
  extensionOrigin?: string;
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
  const book = params.get('book');
  if (book !== null) {
    if (book === 'empty') options.bookEmpty = true;
    else console.warn(`未知的 book「${book}」，可用值：empty`);
  }
  const deadline = params.get('deadline');
  if (deadline !== null) {
    if (deadline === 'warning') options.deadlineWarning = true;
    else console.warn(`未知的 deadline「${deadline}」，可用值：warning`);
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
  const legacy = params.get('legacy');
  if (legacy !== null) {
    if ((LEGACY_OPTIONS as readonly string[]).includes(legacy)) options.legacy = legacy as LegacyOption;
    else console.warn(`未知的 legacy「${legacy}」，可用值：${LEGACY_OPTIONS.join(', ')}`);
  }
  const extension = params.get('extension');
  if (extension !== null) {
    if (extension === 'paired') options.extensionPaired = true;
    else if (extension === 'disconnected') {
      options.extensionPaired = true;
      options.extensionConnected = false;
    } else console.warn(`未知的 extension「${extension}」，可用值：${EXTENSION_OPTIONS.join(', ')}`);
  }
  const extensionOrigin = params.get('extensionOrigin');
  if (extensionOrigin !== null) {
    try {
      const origin = new URL(extensionOrigin).origin;
      if (origin === extensionOrigin && (origin.startsWith('http://') || origin.startsWith('https://'))) options.extensionOrigin = origin;
      else console.warn(`未知的 extensionOrigin「${extensionOrigin}」，请写成 http://host[:port] 或 https://host[:port]`);
    } catch {
      console.warn(`未知的 extensionOrigin「${extensionOrigin}」，请写成 http://host[:port] 或 https://host[:port]`);
    }
  }
  const auth = params.get('auth');
  if (auth !== null) {
    if ((AUTH_OPTIONS as readonly string[]).includes(auth)) options.auth = auth as AuthOption;
    else console.warn(`未知的 auth「${auth}」，可用值：${AUTH_OPTIONS.join(', ')}`);
  }
  return options;
}

function isStage(value: string): value is TaskStage {
  return (TASK_STAGES as readonly string[]).includes(value);
}

function isFault(value: string): value is Fault {
  return (FAULTS as readonly string[]).includes(value);
}
