#!/usr/bin/env node
/**
 * 一次性把 baox 需要的权限配好，之后 auto mode 不会再拦在半路。
 *
 * 为什么需要这一步：auto mode 下有两道闸，它们读的不是同一个文件，也不是同一种东西。
 * 规则怎么算在 `kernel/src/permissions.mjs`（那里有测试盯着），这里只负责读写文件。
 *
 * 用法（在你报销用的那个项目目录里）：
 *   node install-permissions.mjs              # 写项目规则 + 合并用户级 autoMode
 *   node install-permissions.mjs --dry-run    # 只打印，什么都不写
 *   node install-permissions.mjs --project <目录>
 *
 * 改动前都会先备份。合并是「加」不是「盖」：你原有的规则一条都不会被删。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const optOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const project = path.resolve(optOf('--project', process.cwd()));
const skillDir = path.join(project, '.claude', 'skills', 'baox');
const kernelPath = path.join(skillDir, 'kernel', 'bin', 'baox.mjs');

if (!fs.existsSync(kernelPath)) {
  console.error(`没找到内核：${kernelPath}
这个脚本要在**装好 baox 的项目目录**里跑（那个目录下应当有 .claude/skills/baox/），
或者用 --project 指到那个目录。`);
  process.exit(2);
}

const {
  parseSubcommands, bashRulesFor, isBroadRule, autoModeEntriesFor, mergeList,
} = await import(path.join(skillDir, 'kernel', 'src', 'permissions.mjs'));

const subcommands = parseSubcommands(fs.readFileSync(kernelPath, 'utf8'));
if (!subcommands.length) {
  console.error(`从 ${kernelPath} 里没解析出任何子命令，这不正常，先别写规则。`);
  process.exit(2);
}

const interpreters = ['node', process.execPath];
const bashRules = bashRulesFor({ kernelPath, interpreters, subcommands });
const autoMode = autoModeEntriesFor({
  kernelPath,
  erpOrigin: process.env.BAOX_ERP_ORIGIN || 'http://erp.antute.com.cn',
});

const readJson = (p) => {
  if (!fs.existsSync(p)) return {};
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { console.error(`${p} 不是合法 JSON（${e.message}），先修好再跑。`); process.exit(2); }
};

const writeJson = (p, obj) => {
  const text = `${JSON.stringify(obj, null, 2)}\n`;
  if (DRY) { console.log(`\n—— ${p}（--dry-run，没写）——\n${text}`); return; }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  if (fs.existsSync(p)) {
    const bak = `${p}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(p, bak);
    console.log(`  已备份 -> ${bak}`);
  }
  fs.writeFileSync(p, text);
  console.log(`  已写入 ${p}`);
};

// —— 1. 项目规则：窄到「解释器 + 脚本 + 子命令」，在分类器之前就解析掉 ——
const projectSettingsPath = path.join(project, '.claude', 'settings.json');
const projectSettings = readJson(projectSettingsPath);
projectSettings.permissions ??= {};
projectSettings.permissions.allow = mergeList(projectSettings.permissions.allow, bashRules);
console.log(`\n[1/2] 项目权限规则：${subcommands.length} 个子命令 × ${interpreters.length} 种解释器写法 × 2 种引号写法 = ${bashRules.length} 条`);
writeJson(projectSettingsPath, projectSettings);

// —— 2. 用户级 autoMode：分类器只从这里读，项目里的它不看 ——
const userSettingsPath = path.join(os.homedir(), '.claude', 'settings.json');
const userSettings = readJson(userSettingsPath);
userSettings.autoMode ??= {};
userSettings.autoMode.environment = mergeList(userSettings.autoMode.environment, autoMode.environment, { withDefaults: true });
userSettings.autoMode.allow = mergeList(userSettings.autoMode.allow, autoMode.allow, { withDefaults: true });
console.log('\n[2/2] 用户级 autoMode（分类器只从这里读）');
writeJson(userSettingsPath, userSettings);

console.log(`
接下来还有两件事要你自己做：

  一、**信任这个工作区**，否则项目里的规则会被整段忽略，Claude Code 只会安静打印一行
     「Ignoring N permissions.allow entry … this workspace has not been trusted」。
     办法：在 ${project} 里交互式开一次 claude，接受信任对话框。

  二、**验一眼生效没有**：
     claude auto-mode config        # 看 environment / allow 里有没有那几条
     /permissions 的 Auto mode 页   # 同样能看，还能改
`);

const localPath = path.join(project, '.claude', 'settings.local.json');
const broad = (readJson(localPath)?.permissions?.allow ?? []).filter(isBroadRule);
if (broad.length) {
  console.log(`另外：${localPath} 里这些是**宽规则**，auto mode 下会被挂起，留着也不起作用，建议删掉：
${broad.map((r) => `  - ${r}`).join('\n')}`);
}
