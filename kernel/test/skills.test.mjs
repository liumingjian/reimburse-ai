import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

// Skill 壳这一层没有函数可以调，但它有几条硬性质，而这些性质靠人读是守不住的 ——
// 说明书会慢慢长回去，命令示例会一条一条被加回来。所以在这里钉住。
// test/ -> kernel/ -> 仓库根 -> skills/
const KERNEL = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));
const SKILLS = path.join(path.dirname(KERNEL), 'skills');
const read = (...p) => fs.readFileSync(path.join(SKILLS, ...p), 'utf8');
const frontmatter = (src) => src.split('---')[1] ?? '';

const ALL = ['baox', 'baox-setup', 'baox-recover', 'extract-reimbursement-images'];

// 用户入口只有一个。另外两份是模型调用的执行壳 —— 用户不必知道它们存在，
// 更不必自己去挑该用哪一个。这一条是这一批改动的全部目的。
test('用户能唤起的 Skill 只有 baox 一个', () => {
  assert.doesNotMatch(frontmatter(read('baox', 'SKILL.md')), /user-invocable:\s*false/);
  for (const s of ['baox-setup', 'baox-recover', 'extract-reimbursement-images']) {
    const fm = frontmatter(read(s, 'SKILL.md'));
    assert.match(fm, /user-invocable:\s*false/, `${s} 还能被用户直接唤起`);
    assert.match(fm, /disable-model-invocation:\s*false/, `${s} 模型也调不动，那它就没人调得动了`);
  }
});

// 判断散文一旦长回来，模型就又开始自己选下一步做什么 —— 而那是 1.0.0 要关掉的那个入口。
// 行数不是审美偏好，是那类散文放不进 120 行这件事本身。
test('四份说明书都不超过 120 行', () => {
  for (const s of ALL) {
    const n = read(s, 'SKILL.md').split('\n').length;
    assert.ok(n <= 120, `${s}/SKILL.md 有 ${n} 行，超过 120`);
  }
});

// 报销只走 next；用户明确要求的 reset 是独立运维入口。
// 只看代码块和行内代码 —— 散文里的 "the only baox entry point" 不是命令示例。
test('baox 只允许 next 和 reset，baox-setup 只允许 next', () => {
  for (const s of ['baox', 'baox-setup']) {
    for (const f of walk(path.join(SKILLS, s))) {
      const allowed = s === 'baox' ? ['next', 'reset'] : ['next'];
      const found = commandsIn(fs.readFileSync(f, 'utf8')).filter((c) => !allowed.includes(c));
      assert.deepEqual(found, [], `${path.relative(SKILLS, f)} 里出现了额外命令：${found}`);
    }
  }
});

// baox-recover 是唯一的例外，而且只有这一条：`next` 对一个动过 ERP 的任务
// 永远只返回同一个 handoff，状态机在那里就断了，往下走的是只读对账。
test('baox-recover 只多出 erp-reconcile 这一条，别的没有', () => {
  const found = new Set(commandsIn(read('baox-recover', 'SKILL.md')));
  assert.deepEqual([...found].sort(), ['erp-reconcile', 'next']);
});

/** 命令示例只可能出现在代码块或行内代码里。散文里提到 baox 这个名字不算。 */
function commandsIn(src) {
  const code = [...src.matchAll(/```[\s\S]*?```|`[^`\n]+`/g)].map((m) => m[0]).join('\n');
  return [...code.matchAll(/baox(?:\.mjs"?)?[ \t]+([a-z][a-z-]+)/g)].map((m) => m[1]);
}

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    // bundle.sh 扫的是 .md/.json/.sh/.txt 四种，这里跟着它 ——
    // 一条命令示例藏在随包发出去的 .sh 模板里，一样是给模型的第二条路。
    else if (/\.(md|json|sh|txt)$/.test(e.name)) yield p;
  }
}

// 真机实测：SKILL.md frontmatter 里的 hooks 一次都不触发（见 docs/research/skill-declared-hooks.md）。
// 它被静默忽略——没有警告、没有报错，所以写在那里的守卫看起来配好了，实际一次都没跑。
// 把这条钉住：谁再把它加回 frontmatter，这里当场红。
test('四份说明书的 frontmatter 里都没有 hooks —— 那个键是不生效的', () => {
  for (const s of ALL) {
    assert.doesNotMatch(frontmatter(read(s, 'SKILL.md')), /^\s*hooks:/m,
      `${s}/SKILL.md 的 frontmatter 里又出现了 hooks，而它不触发`);
  }
});

// 可选的那道外层守卫要跟着包一起发出去，否则 INSTALL.md 让用户配的那条路径是空的。
test('baox 带着钩子脚本，它是挂到 settings.json 上的那一份', () => {
  const p = path.join(SKILLS, 'baox', 'hooks', 'guard.mjs');
  assert.ok(fs.existsSync(p), 'skills/baox/hooks/guard.mjs 不在');
  assert.match(fs.readFileSync(p, 'utf8'), /settings\.json/,
    '钩子脚本得说清自己该挂在哪里——挂错地方它不生效且不报错');
});

// 钩子从一条 shell 命令行里挑出「敲给 baox 的那一段」的那点解析。
// 它宁可认不出来也不能认错：认不出就放行，而兜底的守卫在内核里，照样拦得住。
test('钩子认得出命令行里的 baox 那一段', async () => {
  const { baoxArgvIn } = await import(
    url.pathToFileURL(path.join(SKILLS, 'baox', 'hooks', 'guard.mjs')).href);

  assert.deepEqual(baoxArgvIn('node /a/b/kernel/bin/baox.mjs doctor'), ['doctor']);
  assert.deepEqual(baoxArgvIn('node "/a b/baox.mjs" next --dir "/m"'), ['next', '--dir', '/m']);
  // 后面还串着别的命令时，只取属于 baox 的那一段
  assert.deepEqual(baoxArgvIn('node /a/baox.mjs intake --dir /m && rm -rf /tmp/x'),
    ['intake', '--dir', '/m']);
  assert.deepEqual(baoxArgvIn('node /a/baox.mjs classify | tee /tmp/o'), ['classify']);
  // 与 baox 无关的命令一律不管
  assert.equal(baoxArgvIn('ls -la'), null);
  assert.equal(baoxArgvIn(''), null);
  assert.equal(baoxArgvIn(undefined), null);
});
