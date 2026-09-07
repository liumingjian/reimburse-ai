#!/usr/bin/env node
/**
 * Skill 侧的入口。三个 Skill 的每一条命令都从这里进，然后由它转交给已安装的内核。
 *
 * 它存在只为一件事：保证**跑起来的内核**和**说明书**是同一个版本。
 *
 * install-runtime 把 Skill 自带的内核整份拷进数据目录，之后每条命令跑的都是拷过去的那一份。
 * 于是发新版时有一个安静的坑：用户把新的 Skill 目录拷进 ~/.claude/skills/，却没有重跑
 * install-runtime —— 新的 SKILL.md 在驱动旧的内核。它不会报错，它会照着新说明书的说法去调
 * 旧内核里语义已经变了的命令，而这套东西最怕的就是「看起来在跑、语义已经错位」。
 *
 * 闸必须挂在这一侧。已安装的那份内核正是过时的那一个 —— 指望它检查自己，等于指望
 * 上一版的代码知道下一版的事。这个启动器跟着 Skill 目录一起更新，所以它总是新的。
 *
 * 三个 Skill 共用数据目录里的同一份内核，不是各自夹带一份：那一份是三者的会合点，
 * 版本一旦对不上就必然在这里露出来。只拷了三个目录里的一个，也在这里露出来。
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { spawnSync } from 'node:child_process';
import { paths } from '../src/paths.mjs';

const BLOCKED = 2;

const here = path.dirname(url.fileURLToPath(import.meta.url));
const skillKernel = path.dirname(here);              // <skill>/kernel
const runtime = path.join(paths.root, 'runtime');

const versionAt = (root) => {
  try { return fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim() || null; } catch { return null; }
};

const out = (obj, code) => {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
  process.exit(code);
};

// 转交。stdio 直通，因为 select 这类命令要在前台等用户提交；退出码原样带回，
// Skill 的判断全靠它。
function handOff(entry) {
  const r = spawnSync(process.execPath, [entry, ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

const cmd = process.argv[2] ?? null;
const skillVersion = versionAt(skillKernel);
const installedVersion = versionAt(runtime);

// 还没装过：doctor 和 install-runtime 得能在没有 runtime 的情况下跑起来，
// 否则第一次安装无从开始。其余命令一律拦下 —— 它们都要动数据目录。
if (installedVersion === null) {
  if (cmd === 'doctor' || cmd === 'install-runtime') handOff(path.join(skillKernel, 'bin', 'baox.mjs'));
  out({ command: cmd, status: 'runtime_not_installed', skillVersion,
    hint: '内核还没安装到数据目录。交给 baox-setup 跑一次环境准备（doctor -> install-runtime）' }, BLOCKED);
}

// 版本漂移。install-runtime 是这个状态唯一的出路，所以它要放行 ——
// 拦住修复手段本身，用户就只剩手工删目录一条路了。
if (installedVersion !== skillVersion) {
  if (cmd === 'install-runtime') handOff(path.join(skillKernel, 'bin', 'baox.mjs'));
  out({ command: cmd, status: 'version_drift', skillVersion, installedVersion, runtime,
    hint: `Skill 自带的内核是 ${skillVersion ?? '(读不到 VERSION)'}，数据目录里装着的是 ${installedVersion}。`
      + '先确认 baox / baox-recover / baox-setup 三个目录是同一次打包出来的（它们必须一起更新），'
      + '再跑一次 install-runtime，然后重试这条命令' }, BLOCKED);
}

handOff(path.join(runtime, 'bin', 'baox.mjs'));
