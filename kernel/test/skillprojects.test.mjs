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

/**
 * 从源码里正则扒命令表，扒法本身会烂：谁把 dispatch 重新缩进一下，上面那个 set 就悄悄变空，
 * 而下面每一条断言都会因为"没什么可查的"而变绿。所以先拿 `default` 分支里给用户看的那一串
 * 对一遍——两处出处对不上，就是扒法失效了，得当场红，而不是安静地不查。
 */
test('命令表扒得出来，并且和 usage 那一串对得上', () => {
  const usage = cli.match(/commands: \[([^\]]+)\]/);
  assert.ok(usage, '内核的 default 分支里找不到 commands 那一串');
  const listed = new Set([...usage[1].matchAll(/'([a-z-]+)'/g)].map((m) => m[1]));
  assert.ok(kernelCommands.size > 20, `只扒到 ${kernelCommands.size} 条命令，扒法失效了`);
  assert.deepEqual([...kernelCommands].sort(), [...listed].sort(),
    'dispatch 的 case 和 usage 里列的命令对不上');
});

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
  // 代码块里的整行，**和散文里 `baox chrome-up` 这样的行内码一起收**：
  // 指错路最容易发生在散文里顺手提的那一条上，只扫代码块等于把最脆的地方漏掉。
  const taught = new Set();
  for (const block of skill.matchAll(/```bash\n([\s\S]*?)```/g)) {
    for (const line of block[1].split('\n')) {
      const m = line.match(/^baox ([a-z-]+)/);
      if (m) taught.add(m[1]);
    }
  }
  for (const m of skill.matchAll(/`baox ([a-z-]+)[^`]*`/g)) taught.add(m[1]);
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
  //
  // 写簿子有两条路：直接 writeBook，或者经 intakeProject（它自己会 writeBook）。
  // 只查前者会漏掉后者——而后者恰恰是维护页用的那条，也是最可能被顺手复用到
  // 别的命令上的那条。
  const writers = ['writeBook', 'intakeProject'];
  for (const cmd of kernelCommands) {
    if (cmd === 'projects-page') continue;
    assert.ok(!/^(add|remove|delete|edit|import)-.*project/.test(cmd),
      `内核多了一条对话就能改簿子的命令：${cmd}`);
    for (const w of writers) {
      assert.ok(!commandBody(cmd).includes(w),
        `${cmd} 经 ${w} 写得动项目簿，但增删只该发生在维护页的提交上`);
    }
  }
  // 反过来钉住这条测试确实认得出"写簿子"：维护页那条命令必须命中其中之一。
  assert.ok(writers.some((w) => commandBody('projects-page').includes(w)),
    'projects-page 都不写簿子，说明这条测试认的写入方式已经过时了');
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
