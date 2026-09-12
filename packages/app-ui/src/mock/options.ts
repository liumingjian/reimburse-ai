import { TASK_STAGES, type TaskStage } from '../contract/stage';

// mock 模式的查询参数：`?seed=<阶段>` 直接打开某阶段的快照，`?fault=<场景>` 注入一种故障。

export const FAULTS = [
  'duplicate-upload',
  'unsupported-material',
  'erp-login-missing',
  'erp-write-aborted',
  'readback-mismatch',
  'service-disconnected',
] as const;
export type Fault = (typeof FAULTS)[number];

// 票面上用过的别名：`?seed=assign` 与 `?seed=project` 相同（阶段枚举里叫 project）。
const SEED_ALIASES: Readonly<Record<string, TaskStage>> = { assign: 'project' };

export type MockOptions = {
  seed: TaskStage | null;
  fault: Fault | null;
  // 盘点每个阶段的推进间隔（毫秒）；测试可以调小。
  inventoryPhaseMs?: number;
  // ERP 填报每一步的推进间隔（毫秒，默认 300）；正常场景下服务端自动探测到登录的延迟（默认 2500）。
  erpStepMs?: number;
  erpLoginAutoMs?: number;
};

export function readMockOptions(search: string): MockOptions {
  const params = new URLSearchParams(search);
  const seed = params.get('seed');
  const fault = params.get('fault');
  const options: MockOptions = { seed: null, fault: null };
  if (seed !== null) {
    const stage = SEED_ALIASES[seed] ?? seed;
    if (isStage(stage)) options.seed = stage;
    else console.warn(`未知的 seed「${seed}」，可用值：${TASK_STAGES.join(', ')}`);
  }
  if (fault !== null) {
    if (isFault(fault)) options.fault = fault;
    else console.warn(`未知的 fault「${fault}」，可用值：${FAULTS.join(', ')}`);
  }
  return options;
}

function isStage(value: string): value is TaskStage {
  return (TASK_STAGES as readonly string[]).includes(value);
}

function isFault(value: string): value is Fault {
  return (FAULTS as readonly string[]).includes(value);
}
