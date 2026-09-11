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

export type MockOptions = {
  seed: TaskStage | null;
  fault: Fault | null;
};

export function readMockOptions(search: string): MockOptions {
  const params = new URLSearchParams(search);
  const seed = params.get('seed');
  const fault = params.get('fault');
  const options: MockOptions = { seed: null, fault: null };
  if (seed !== null) {
    if (isStage(seed)) options.seed = seed;
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
