// 开发与 mock 模式下，每份快照与任务列表都过 zod 校验（失败即抛出）；正式构建为 false，避免重复解析。
export const VALIDATE_SNAPSHOTS: boolean = import.meta.env.DEV || import.meta.env.MODE === 'mock';

export const IS_MOCK: boolean = import.meta.env.MODE === 'mock';
