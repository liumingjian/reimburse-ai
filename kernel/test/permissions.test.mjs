import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseSubcommands, bashRulesFor, isBroadRule, autoModeEntriesFor, mergeList,
} from '../src/permissions.mjs';

// 这一层测的是「装完不会在半路被 auto mode 拦住」。
// 它错了不会报错 —— 只会在真机跑到一半时被拒，而那时 auto mode 连提示都不弹（台账 V-48）。

const here = path.dirname(fileURLToPath(import.meta.url));
const KERNEL_SRC = fs.readFileSync(path.join(here, '..', 'bin', 'baox.mjs'), 'utf8');
const K = '/Users/x/proj/.claude/skills/baox/kernel/bin/baox.mjs';
const rules = (subcommands = ['next', 'ocr-submit']) =>
  bashRulesFor({ kernelPath: K, interpreters: ['node', '/opt/homebrew/bin/node'], subcommands });

test('子命令表从内核源码里读出来，且把真实的那些都读到了', () => {
  const subs = parseSubcommands(KERNEL_SRC);
  for (const must of ['next', 'ocr-submit', 'intake', 'classify', 'erp-fill', 'erp-reconcile']) {
    assert.ok(subs.includes(must), `${must} 应当被解析出来`);
  }
  assert.ok(subs.length >= 15, `解析出的子命令太少（${subs.length}），十有八九是正则没跟上内核`);
});

test('内核里每一个子命令都有规则 —— 漏一个，那一步就会被拦', () => {
  const subs = parseSubcommands(KERNEL_SRC);
  const out = rules(subs);
  for (const s of subs) {
    assert.ok(out.includes(`Bash(node "${K}" ${s} *)`), `${s} 缺带参数的规则`);
    assert.ok(out.includes(`Bash(node "${K}" ${s})`), `${s} 缺不带参数的规则`);
  }
});

test('没有一条是宽规则 —— 宽规则在 auto mode 下会被挂起，写了等于没写', () => {
  for (const r of rules(parseSubcommands(KERNEL_SRC))) {
    assert.ok(!isBroadRule(r), `${r} 是宽规则`);
    assert.ok(r.includes(K), `${r} 没钉死脚本路径`);
  }
});

test('认得出宽规则，才提醒得了用户把它删掉', () => {
  assert.ok(isBroadRule('Bash(node *)'));
  assert.ok(isBroadRule('Bash(/opt/homebrew/Cellar/node/26.4.0/bin/node *)'));
  assert.ok(isBroadRule('Bash(python3 *)'));
  assert.ok(isBroadRule('Bash(*)'));
  assert.ok(!isBroadRule(`Bash(node "${K}" next *)`));
});

test('引号写法和 node 的绝对路径都覆盖到 —— 前缀匹配是逐字的', () => {
  const out = rules(['next']);
  assert.ok(out.includes(`Bash(node "${K}" next *)`), '带引号');
  assert.ok(out.includes(`Bash(node ${K} next *)`), '不带引号');
  assert.ok(out.includes(`Bash(/opt/homebrew/bin/node "${K}" next *)`), 'node 绝对路径');
});

test('同一个解释器写两遍不会翻倍', () => {
  const once = bashRulesFor({ kernelPath: K, interpreters: ['node'], subcommands: ['next'] });
  const twice = bashRulesFor({ kernelPath: K, interpreters: ['node', 'node'], subcommands: ['next'] });
  assert.deepEqual(once, twice);
});

test('给分类器的交底里要有目的地和数据落点，否则它还是判不出外泄', () => {
  const { environment, allow } = autoModeEntriesFor({ kernelPath: K, erpOrigin: 'http://erp.antute.com.cn' });
  const all = [...environment, ...allow].join('\n');
  assert.ok(all.includes('erp.antute.com.cn'), '要说清唯一的网络目的地');
  assert.ok(all.includes('~/.baox'), '要说清材料落在本机哪里');
  assert.ok(all.includes('ocr-submit'), '要专门解释这个名字带 submit 的子命令不是外发');
  assert.ok(environment.some((e) => e.startsWith('Trusted internal domains:')), '要有 Trusted internal domains 这一栏');
});

test('合并只加不删，$defaults 排头，跑两遍结果一样', () => {
  const mine = ['我原来就有的一条'];
  const once = mergeList(mine, ['新的一条'], { withDefaults: true });
  assert.deepEqual(once, ['$defaults', '我原来就有的一条', '新的一条']);
  assert.deepEqual(mergeList(once, ['新的一条'], { withDefaults: true }), once, '重复跑不该再加');
  assert.deepEqual(mergeList(undefined, ['a'], {}), ['a'], '原来没有这个键也要能合');
  assert.ok(!mergeList(['x'], ['y'], {}).includes('$defaults'), 'permissions.allow 不需要 $defaults');
});
