/**
 * 采集观测。这里是**唯一**碰文件系统、CDP 和时钟的地方，判定在 state.mjs 里。
 *
 * 这样分开，是为了让状态判定的测试能在一台没有 Chrome 的机器上跑完 ——
 * 采集这一侧本来就只能在真机上验，把判断混进来就等于把判断也搬上真机。
 */
import fs from 'node:fs';
import path from 'node:path';
import { paths } from './paths.mjs';
import { SCHEMA_VERSION } from './state.mjs';
import * as chrome from './chrome.mjs';
import { probeIdentity } from './probe.mjs';
import { readBinding } from './binding.mjs';

/**
 * 数据目录的格式版本。没有这个文件就是这个内核自己写的那一版。
 * 现在还没有谁写它 —— 把 `schemaVersion` 正式定为 1 并落盘是批次 6 的事，
 * 在那之前 `schema_too_new` 只会在未来某一版写了这个文件之后才可能出现。
 */
export function readSchemaVersion() {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(paths.root, 'schema.json'), 'utf8'));
    return Number(v.schemaVersion) || SCHEMA_VERSION;
  } catch {
    return SCHEMA_VERSION;
  }
}

/**
 * 采一次环境观测（state-machine.md A 表要的全部事实）。
 *
 * Chrome 没起来就不探针：探针要等页面加载，最长 30 秒，而这时候答案已经定了
 * —— 先把 Chrome 起来。这不是优化，是不让用户为一个已知的结论等半分钟。
 */
export async function observeEnvironment() {
  const [nodeMajor] = process.versions.node.split('.').map(Number);
  const cdpUp = !!(await chrome.version());
  return {
    schemaVersion: readSchemaVersion(),
    nodeVersion: process.versions.node,
    nodeMajor,
    cdpUp,
    probe: cdpUp ? await probeIdentity() : null,
    binding: readBinding(),
  };
}
