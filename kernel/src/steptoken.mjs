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
 *
 * `meta` 是**这一步摆出去的那份内容**的指纹（目前只有写入前那张表和一轮分摊的题号）。
 * 它和状态一起构成凭据的身份：状态没变、但摆给用户看的东西变了，凭据照样作废。
 * 少了这一条，用户会为他看过的那一份内容点头，而内核收下的是另一份 ——
 * 这在可撤销的步骤上只是重问一次，在写入前那一格上是不可挽回的。
 */
export function issueStep(sourceKey, state, sourceDir = null, meta = null, argv = null) {
  const store = read();
  const prev = store.steps[sourceKey];
  const same = prev && prev.state === state
    && JSON.stringify(prev.meta ?? null) === JSON.stringify(meta ?? null);
  const record = same
    ? prev
    : { token: newToken(), state, meta, issuedAt: new Date().toISOString() };
  // 目录跟着这一次的问话更新，凭据本身不动 —— 同一个目录换了个写法（软链、末尾斜杠）
  // 不该让当前这一步作废。
  //
  // `argv` 是这一步摆出去的那条命令行，同样跟着每一次问话更新（哪怕凭据因为幂等没换）。
  // 守卫拿它当白名单：模型敲得动的低层命令，只有内核**刚刚**亲手发出的那一条（见 guard.mjs）。
  const stored = { ...record, sourceDir: sourceDir ?? prev?.sourceDir ?? null, argv: argv ?? null };
  store.steps[sourceKey] = stored;
  store.current = sourceKey;
  write(store);
  return stored;
}

/**
 * 当前这一步内核发出去的那条命令行。没有（比如这一步不跑命令）就是 null。
 *
 * 守卫要的白名单就是它：模型手上唯一一条低层命令，是内核刚刚放到 `step.argv` 里的那条。
 */
export function currentIssuedArgv() {
  const store = read();
  return store.steps[store.current]?.argv ?? null;
}
