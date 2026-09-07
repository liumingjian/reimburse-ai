import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

/**
 * Skill 侧对个人项目簿的话术，钉在内核这一边。
 *
 * 这几条测的都不是散文写得好不好，而是**散文和内核会不会各说各的**：
 * Skill 教用户跑一条内核没有的命令、Skill 说「我不能替你录入」而内核其实开了一条
 * 对话就能改簿子的口子、Skill 把状态名写成一个内核不认的词——三种都不会在运行时报错，
 * 它们只会让模型带着一份过时的说法一路走下去。
 */

const here = path.dirname(url.fileURLToPath(import.meta.url));
const repo = path.dirname(path.dirname(here));
const cli = fs.readFileSync(path.join(repo, 'kernel', 'bin', 'baox.mjs'), 'utf8');
const skill = fs.readFileSync(path.join(repo, 'skills', 'baox', 'SKILL.md'), 'utf8');

/** 内核认得的命令，从 dispatch 的 case 标签上直接取——usage 那一串是抄的，会抄漏。 */
const kernelCommands = new Set(
  [...cli.matchAll(/^ {4}case '([a-z-]+)':/gm)].map((m) => m[1]));

/** 从 `case 'x': {` 起按花括号配对切出那一段源码。 */
function commandBody(name) {
  const start = cli.indexOf(`case '${name}': {`);
  assert.notEqual(start, -1, `内核里没有 ${name} 这条命令`);
  let depth = 0;
  for (let i = cli.indexOf('{', start); i < cli.length; i++) {
    if (cli[i] === '{') depth++;
    else if (cli[i] === '}' && --depth === 0) return cli.slice(start, i + 1);
  }
  throw new Error(`${name} 的花括号没配上`);
}

test('Skill 里教的每一条 baox 命令，内核都认', () => {
  // ```bash 代码块里的 `baox <cmd>`，注释和散文里的不算。
  const taught = new Set();
  for (const block of skill.matchAll(/```bash\n([\s\S]*?)```/g)) {
    for (const line of block[1].split('\n')) {
      const m = line.match(/^baox ([a-z-]+)/);
      if (m) taught.add(m[1]);
    }
  }
  assert.ok(taught.has('projects'), 'Skill 没有教只读查询命令 baox projects');
  assert.ok(taught.has('projects-page'), 'Skill 没有教维护页命令 baox projects-page');
  for (const cmd of taught) {
    assert.ok(kernelCommands.has(cmd), `Skill 教了 baox ${cmd}，内核没有这条命令`);
  }
});

test('baox projects 是纯读本机簿子：不开浏览器、不碰 ERP', () => {
  const body = commandBody('projects');
  // 一旦有人往这条命令里加了联网核对，Skill 里「问一句不会联网」那句话就成了假话。
  for (const forbidden of ['authorizedPage', 'verifyProject', 'verifyExpenseItems',
    'openSession', 'intakeProject', 'writeBook', 'serve']) {
    assert.ok(!body.includes(forbidden),
      `projects 命令里出现了 ${forbidden}，它就不再是只读的本机查询了`);
  }
});

test('改簿子只有维护页一个入口：没有别的命令写得动它', () => {
  // Skill 明说 Agent 不得代替用户录入、修改、删除——那必须是内核根本没开这个口子，
  // 而不是只靠 Skill 里的一句「不要这样做」。
  for (const cmd of kernelCommands) {
    if (cmd === 'projects-page') continue;
    assert.ok(!/^(add|remove|delete|edit|import)-.*project/.test(cmd),
      `内核多了一条对话就能改簿子的命令：${cmd}`);
    assert.ok(!commandBody(cmd).includes('writeBook'),
      `${cmd} 会写项目簿，但增删只该发生在维护页的提交上`);
  }
});

test('Skill 把 project_book_empty 和 project_unassigned 分开讲，且不发明状态名', () => {
  const named = new Set([...skill.matchAll(/`(project_[a-z_]+)`/g)].map((m) => m[1]));
  assert.ok(named.has('project_book_empty'), 'Skill 没讲空簿这个状态');
  assert.ok(named.has('project_unassigned'), 'Skill 没讲「有得选但还没选」这个状态');

  // 状态名的出处是状态机清单，Skill 只能引用它认的词。
  const machine = fs.readFileSync(
    path.join(repo, 'docs', 'design', 'state-machine.md'), 'utf8');
  const known = new Set([...machine.matchAll(/`(project_[a-z_]+)`/g)].map((m) => m[1]));
  for (const s of named) {
    assert.ok(known.has(s), `Skill 里的 ${s} 不是状态机清单上的状态`);
  }
});
