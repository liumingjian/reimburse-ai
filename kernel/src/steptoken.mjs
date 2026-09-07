/**
 * `stepToken` 的登记簿。
 *
 * 它是「不可跳步」的物理实现，不是给模型的告诫：内核只认它**刚发出的那一个**
 * 凭据，回传的凭据对不上就忽略回传、重发当前步骤 —— 不报错、不惩罚。
 * 模型少走一步、多走一步、拿着上一轮的凭据回来，结果都一样：还是当前该做的那件事。
 *
 * 凭据跟着**状态**走，不跟着调用走：状态没变就是同一个凭据（幂等，连问三次
 * 拿到同一个 state 和同一个 token），状态一变旧凭据当场作废，永远不会再被认出来。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { paths, ensureDir } from './paths.mjs';

const storePath = () => path.join(paths.root, 'steps.json');

const read = () => {
  try { return JSON.parse(fs.readFileSync(storePath(), 'utf8')); } catch { return { current: null, steps: {} }; }
};

const write = (v) => {
  ensureDir(paths.root);
  const tmp = `${storePath()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, storePath());
};

export const newToken = () => crypto.randomBytes(16).toString('hex');

/** 这个来源目录当前挂着的那一步。没有就是 null。 */
export function currentStep(sourceKey) {
  return read().steps[sourceKey] ?? null;
}

/**
 * 模型不带 `--dir` 只带 `--after` 回来时，靠它找回上一次问的是哪个目录。
 * 凭据本身认不出目录 —— 认得出的话它就不只是个一次性凭据了。
 */
export function currentSourceKey() {
  return read().current;
}

/**
 * 上次问的那个材料目录的绝对路径。
 *
 * 材料这一段的每一步都要重新盘那个目录，而 sourceKey 是单向哈希，还原不回路径，
 * 所以这里必须记着它本身。它记在**当前步骤**的登记簿里，不是任务档案里：
 * 任务档案是长期事实，那里至今不落原目录绝对路径，这一条没有变。
 */
export function currentSourceDir() {
  const store = read();
  return store.steps[store.current]?.sourceDir ?? null;
}

/**
 * 发一个凭据。状态和上次一样就把上次那个原样发回去（幂等）；
 * 状态变了就换一个新的，旧的当场作废。
 */
export function issueStep(sourceKey, state, sourceDir = null) {
  const store = read();
  const prev = store.steps[sourceKey];
  const record = prev && prev.state === state
    ? prev
    : { token: newToken(), state, issuedAt: new Date().toISOString() };
  // 目录跟着这一次的问话更新，凭据本身不动 —— 同一个目录换了个写法（软链、末尾斜杠）
  // 不该让当前这一步作废。
  const stored = { ...record, sourceDir: sourceDir ?? prev?.sourceDir ?? null };
  store.steps[sourceKey] = stored;
  store.current = sourceKey;
  write(store);
  return stored;
}
