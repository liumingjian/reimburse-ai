/**
 * auto mode 下要用的权限规则，怎么算出来。
 *
 * 这里只有纯函数：给定内核路径和子命令表，算出规则文本。写文件那一半在
 * `scripts/install-permissions.mjs` 里 —— 拆开是为了这一半能被测试盯住，
 * 因为它错了不会报错，只会在真机跑到一半的时候被拦，而那时候 auto mode 连提示都不弹。
 *
 * 两道闸读的不是同一个文件，这是整件事的要害：
 *   - `permissions.allow`：项目里的 .claude/settings.json，**在分类器之前**解析。
 *     但只有窄规则算数 —— 官方文档说 `Bash(*)` 和「wildcarded interpreters」这类宽规则
 *     在 auto mode 下会被挂起。`Bash(node *)` 就是被挂起的那一种。
 *   - `autoMode`：只读**用户级** ~/.claude/settings.json（项目里的不算，怕仓库自己给自己发通行证）。
 */

/** 内核认得的子命令。从内核源码里读，避免这里和内核各说各的。 */
export function parseSubcommands(kernelSource) {
  return [...kernelSource.matchAll(/^\s*case '([a-z-]+)':/gm)].map((m) => m[1]);
}

/**
 * 规则窄到「哪个解释器 + 哪个脚本 + 哪个子命令」。
 *
 * 解释器和引号各给两种写法：模型有时敲 `node`，有时敲 node 的绝对路径（真机上出现过
 * `/opt/homebrew/Cellar/node/26.4.0/bin/node`）；路径带不带引号也各出现过。
 * 前缀匹配是**逐字**的，少给一种，那一次就会被拦。
 *
 * 每个子命令给两条：带参数的和不带参数的（`chrome-up`、`doctor` 这些本来就没有参数，
 * 而 `… chrome-up *` 匹配不上一条没有参数的命令）。
 */
export function bashRulesFor({ kernelPath, interpreters, subcommands }) {
  const kernelForms = [`"${kernelPath}"`, kernelPath];
  const rules = [];
  for (const i of [...new Set(interpreters)]) {
    for (const k of kernelForms) {
      for (const s of subcommands) {
        rules.push(`Bash(${i} ${k} ${s})`);
        rules.push(`Bash(${i} ${k} ${s} *)`);
      }
    }
  }
  return rules;
}

/** 一条规则是不是宽到会被 auto mode 挂起（通配解释器 / 通配一切）。 */
export function isBroadRule(rule) {
  return rule === 'Bash(*)'
    || /^Bash\((\S*\/)?(node|python3?|bash|sh|zsh|deno|bun|npx|ruby|perl)\s*[* ]*\)$/.test(rule)
    || /^Bash\((\S*\/)?(node|python3?|bash|sh|zsh|deno|bun|npx|ruby|perl) \*\)$/.test(rule);
}

/**
 * 给分类器的交底。是散文，不是规则表达式 —— 文档原话
 * 「Entries are prose, not regex or tool patterns」。
 * 所以这里写的是「这台机器上的报销是怎么回事」，写给一个不认识 baox 的人看。
 */
export function autoModeEntriesFor({ kernelPath, erpOrigin }) {
  const host = new URL(erpOrigin).host;
  return {
    environment: [
      'Primary use of Claude Code: 个人报销自动化（baox）。会话读取本机的发票与行程单，把读数写进本机的 ~/.baox，再由本机的专用 Chrome 填进公司 ERP 的费用报销单。',
      `Key internal services: 公司 ERP（金蝶 K3Cloud）在 ${erpOrigin}，这是报销单唯一的写入目标，也是整个流程里唯一的网络目的地。`,
      `Trusted internal domains: ${host}`,
      'Sensitive data locations & audiences: 发票、行程单、酒店结账单在用户指定的材料目录和 ~/.baox/tasks/ 下。受众只有报销人本人和公司 ERP；这些材料不发往任何第三方。',
      `Additional context: baox 的内核命令一律是 \`node ${kernelPath} <子命令>\`，全部在本机进程内读写材料目录和 ~/.baox，网络只连 ${erpOrigin} 和本机的 Chrome 调试端口（127.0.0.1）。像 ocr-submit、intake、classify 这类子命令名字里有「submit」「上传」的意味，但它们只是把读数写进本机的任务工作区，不是把材料发出去。`,
    ],
    allow: [
      `baox 内核命令（\`node ${kernelPath} <子命令>\`，含 intake / classify / ocr-request / ocr-submit / reread-submit / confirm-readings / erp-read / erp-fill / erp-reconcile / next 等）允许：它们只在本机读写材料目录与 ~/.baox，唯一的网络目的地是公司 ERP ${erpOrigin}，不构成数据外发。`,
    ],
  };
}

/**
 * 合并进数组：已经有的不重复加，`$defaults` 永远排头。
 *
 * 只加不删 —— 用户原来写了什么规则，跟我们没关系，动了就是替他做决定。
 * `$defaults` 那一条是文档明写的：`autoMode` 的列表里不含它，就等于把内置规则整段丢掉。
 */
export function mergeList(existing, additions, { withDefaults = false } = {}) {
  const out = Array.isArray(existing) ? [...existing] : [];
  if (withDefaults && !out.includes('$defaults')) out.unshift('$defaults');
  for (const a of additions) if (!out.includes(a)) out.push(a);
  return out;
}
