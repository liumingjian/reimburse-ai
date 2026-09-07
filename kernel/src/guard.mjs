import fs from 'node:fs';
import path from 'node:path';

/**
 * 「模型不拼命令」从劝告变成机制的那一层。
 *
 * 除 `next` 以外的子命令，在内核检测到自己是被 Agent 调起的时候一律拒绝执行。
 * 低层那二十来条命令仍然留着 —— 它们是给人手敲排障用的，只是模型碰不到。
 *
 * ## 为什么守卫在内核里，不在 Skill 声明的 hook 里
 *
 * 施工单原定的做法是在 `skills/baox/SKILL.md` 的 frontmatter 里声明 `hooks.PreToolUse`。
 * 真机实测（Claude Code 2.1.263，项目域 `.claude/skills/`）的结论是**它根本不触发**：
 * 钩子脚本一次都没被调起，被拦的命令照跑不误。同一个脚本挂到 `.claude/settings.json`
 * 的 `hooks.PreToolUse` 上则确实拦得住，连 `bypassPermissions` 都压不过它。
 * 详见 `docs/research/skill-declared-hooks.md`。
 *
 * 于是走施工单写好的退路：守卫做进内核自身。这一层不依赖任何安装步骤 ——
 * 内核就地运行，跑的是哪一份内核和跑的是哪一份 SKILL.md 是同一个问题，
 * 所以守卫和被守的东西不可能对不上。
 *
 * ## 凭什么判定「是模型在敲」
 *
 * 退路原定的判据是 `CLAUDE_SKILL_DIR`。同一轮实测里这个变量**并不存在于 Bash 工具的
 * 环境**（`SKILL_DIR_RAW=[<UNSET>]`），拿它当判据等于守卫永远不生效。
 * 实际稳定出现的是下面这几个，取并集 —— 少认一个就是漏一条路，多认一个只是让某个
 * 人在 Claude Code 里手敲时需要多写一个显式标记。
 */
export const AGENT_MARKERS = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_SKILL_DIR', 'AI_AGENT'];

/**
 * 模型自己敲得动的子命令。只有这一条 —— 「问下一步」和「交结果」都是它。
 *
 * 低层命令并非模型全都碰不到：`step.kind: "run"` 那一步，内核会亲手把一条完整命令行
 * 放进 `step.argv` 让模型原样执行。那条命令走的是下面的 `issuedArgv` 白名单，
 * 不走这个集合 —— 契约里的说法是「拦下**不在 argv 里**的越权命令」，
 * 而不是「拦下所有低层命令」。两者的差别就是这套设计能不能跑起来。
 */
export const MODEL_ALLOWED = new Set(['next']);

/**
 * 人手敲的显式标记。它不是密码，也不打算是 —— 模型当然"能"加上它。
 * 挡的是模型顺着 SKILL.md 或自己的判断去拼一条低层命令，不是一个立意越狱的模型；
 * 后者在一台能任意执行 shell 的机器上本来就挡不住。真正的意义是：
 * 加上它就是一次留痕的、明知故犯的动作，而不是一次悄悄发生的自作主张。
 */
export const HUMAN_FLAG = '--i-am-a-human';

/** 拒绝日志的文件名。它在 `<数据目录>/logs/` 下。 */
export const REFUSAL_LOG = 'refused.jsonl';

/** 环境里出现了哪些「Agent 在驱动」的痕迹。空数组 = 看起来是个真终端。 */
export function agentMarkers(env = process.env) {
  return AGENT_MARKERS.filter((k) => typeof env[k] === 'string' && env[k] !== '');
}

/**
 * 一条低层命令是不是内核**刚刚**亲手发出的那一条。
 *
 * 只比 `node` 和脚本路径之后的那一段：argv[0]/argv[1] 是内核自己填的绝对路径，
 * 模型那边换个写法（`node` 而不是全路径、软链）不该算越权，而真正要认的
 * 「跑的是哪条子命令、带哪些参数」全在后面那一段里。
 *
 * 逐项全等，不做前缀匹配：多一个参数少一个参数都是另一条命令，
 * 而「多一个参数」正是模型最容易自作主张的地方。
 */
function matchesIssued(argv, issuedArgv) {
  if (!Array.isArray(issuedArgv) || issuedArgv.length < 3) return false;
  const want = issuedArgv.slice(2);
  return want.length === argv.length && want.every((a, i) => a === argv[i]);
}

/**
 * 判一条调用放不放行。纯函数：不读文件、不写日志、不碰 process。
 *
 * @param {{cmd: string|null|undefined, argv?: string[], env?: object,
 *          issuedArgv?: string[]|null}} input
 *        `argv` 是 `process.argv.slice(2)`（子命令及其参数）；
 *        `issuedArgv` 是登记簿里当前那一步的完整命令行，没有就是 null。
 * @returns {{allowed: boolean, reason: string, markers: string[]}}
 */
export function guardVerdict({ cmd, argv = [], env = process.env, issuedArgv = null } = {}) {
  const markers = agentMarkers(env);

  if (MODEL_ALLOWED.has(cmd)) {
    return { allowed: true, reason: 'model_allowed', markers };
  }
  // 内核自己刚发出去的那一条。放行它不是开了个口子 —— 它就是这一步的全部内容，
  // 而且随下一次 `next` 当场作废：白名单只有一条，且永远是最新的那一条。
  if (matchesIssued(argv, issuedArgv)) {
    return { allowed: true, reason: 'issued_by_kernel', markers };
  }
  // 顺序要紧：显式标记先于环境判定。人在 Claude Code 的终端里手敲排障时，
  // 环境痕迹和模型敲的一模一样，标记是他唯一能表明身份的方式。
  if (argv.includes(HUMAN_FLAG)) {
    return { allowed: true, reason: 'human_flag', markers };
  }
  if (markers.length === 0) {
    return { allowed: true, reason: 'no_agent_markers', markers };
  }
  return { allowed: false, reason: 'model_may_only_run_next', markers };
}

/** 拒绝时给出去的那份 JSON。措辞写死在这里，不留给模型组织。 */
export function refusalPayload({ cmd, markers }) {
  return {
    command: cmd ?? null,
    status: 'refused',
    refused: {
      command: cmd ?? null,
      reason: 'model_may_only_run_next',
      markers,
      allowed: [...MODEL_ALLOWED],
    },
    // 念给用户听的那一句：拒绝本身不是故障，说成故障会让人去"修"它。
    speak: '我只能通过 baox 的一条入口往下走，刚才那条命令不在我的权限里，我不会绕过去。',
    error: `模型只能敲 baox next，外加内核放进 step.argv 的那一条；`
      + `${cmd ?? '(空)'} 两样都不是，它是给人手敲排障用的。`,
    hint: `人要手敲这条命令，在末尾加 ${HUMAN_FLAG}。`,
  };
}

/**
 * 把一次拒绝记进 `<数据目录>/logs/refused.jsonl`。
 *
 * 这份日志是验收判据本身：「全程模型只出现过 `baox next`」不是靠回看对话确认的，
 * 是靠这个文件为空确认的。所以它只在**拒绝**的时候写 —— 放行不记，
 * 否则日志里全是噪音，"为空"就不再是一个能一眼看出来的信号。
 *
 * 写日志失败不能连累主流程：拒绝这件事已经发生了，记不下来是次要损失。
 */
export function recordRefusal({ cmd, markers, logsDir, now = new Date() }) {
  try {
    fs.mkdirSync(logsDir, { recursive: true, mode: 0o700 });
    const line = JSON.stringify({
      at: now.toISOString(),
      command: cmd ?? null,
      markers,
      cwd: process.cwd(),
    });
    fs.appendFileSync(path.join(logsDir, REFUSAL_LOG), line + '\n');
    return true;
  } catch {
    return false;
  }
}
