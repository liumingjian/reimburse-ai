#!/usr/bin/env node
/**
 * PreToolUse 钩子：在 Bash 工具真的跑起来之前，拦下模型自己拼的 baox 命令。
 *
 * ## 这是第二层，不是第一层
 *
 * 真正兜底的守卫在内核自己身上（`kernel/src/guard.mjs`），它不需要安装任何东西。
 * 这个钩子是可选的外层：它的好处是命令**连进程都没起**就被挡住，
 * 而且拒绝会以工具错误的形式回到模型眼前。
 *
 * ## 挂在哪里
 *
 * **必须挂在 `.claude/settings.json` 里，不能写进 SKILL.md 的 frontmatter。**
 * 真机实测（Claude Code 2.1.263）：SKILL.md 里声明的 `hooks.PreToolUse` 一次都不触发；
 * 同一个脚本挂到 settings.json 上则拦得住，连 `bypassPermissions` 都压不过它。
 * 怎么挂见 INSTALL.md。
 *
 * ## 判据来自内核，不在这里重写一遍
 *
 * 放行的规矩只有一份，就是 `kernel/src/guard.mjs`。这里只做三件事：
 * 读 stdin、把命令行拆成 argv、把内核的裁决翻译成钩子的退出码。
 * 在这里抄一份判据，等于给「模型敲得动什么」留了第二个说法。
 */
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));

// 装好之后内核就在 Skill 目录里（bundle.sh 拷进去的）；在仓库里开发时它在仓库根下。
// 两种布局都要能跑 —— 只认一种，另一种就会在最需要它的时候悄悄失效。
const CANDIDATES = [
  path.join(HERE, '..', 'kernel', 'src', 'guard.mjs'),
  path.join(HERE, '..', '..', '..', 'kernel', 'src', 'guard.mjs'),
];

async function loadGuard() {
  for (const p of CANDIDATES) {
    try { return await import(url.pathToFileURL(p).href); } catch { /* 换下一个 */ }
  }
  return null;
}

/**
 * 从一条 shell 命令行里挑出「敲给 baox 的那一段」。
 *
 * 只认 `baox.mjs` 这个入口文件名，因为模型手上唯一的入口就是它的绝对路径。
 * 认不出来就返回 null —— 这条命令与 baox 无关，钩子不该管它。
 *
 * 这里不做完整的 shell 解析：办不到，也不需要。拆不开的命令一律当作「不是 baox」，
 * 因为兜底的那一层在内核里，漏到那里照样拦得住。
 */
export function baoxArgvIn(command) {
  if (typeof command !== 'string' || !command.includes('baox.mjs')) return null;
  const tokens = command.split(/\s+/).filter(Boolean).map((t) => t.replace(/^["']|["']$/g, ''));
  const i = tokens.findIndex((t) => t.endsWith('baox.mjs'));
  if (i < 0) return null;
  // 后面跟着 `&&`、`|`、`;` 的话，只取属于这条 baox 命令的那一段。
  const rest = tokens.slice(i + 1);
  const stop = rest.findIndex((t) => ['&&', '||', '|', ';'].includes(t));
  return stop < 0 ? rest : rest.slice(0, stop);
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;

  let command = '';
  try { command = JSON.parse(raw)?.tool_input?.command ?? ''; } catch { /* 不是 JSON 就当没有命令 */ }

  const argv = baoxArgvIn(command);
  if (!argv) process.exit(0);

  const guard = await loadGuard();
  // 找不到内核就放行：这一层本来就是可选的外层，让它在装歪了的时候变成硬阻塞，
  // 只会把一个安装问题伪装成一次拒绝。内核那一层照样拦得住。
  if (!guard) process.exit(0);

  let issuedArgv = null;
  for (const p of CANDIDATES.map((c) => c.replace('guard.mjs', 'steptoken.mjs'))) {
    try { issuedArgv = (await import(url.pathToFileURL(p).href)).currentIssuedArgv(); break; } catch { /* 换下一个 */ }
  }

  const verdict = guard.guardVerdict({ cmd: argv[0], argv, env: process.env, issuedArgv });
  if (verdict.allowed) process.exit(0);

  // 退出码 2 = 拦下这次调用，stderr 回到模型眼前。
  process.stderr.write(
    `baox 守卫拒绝了这条命令：${argv[0] ?? '(空)'}。\n`
    + '模型只能敲 baox next，外加内核放进 step.argv 的那一条。\n');
  process.exit(2);
}

main();
