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

const ALL = ['baox', 'baox-setup', 'baox-recover'];

// 用户入口只有一个。另外两份是模型调用的执行壳 —— 用户不必知道它们存在，
// 更不必自己去挑该用哪一个。这一条是这一批改动的全部目的。
test('用户能唤起的 Skill 只有 baox 一个', () => {
  assert.doesNotMatch(frontmatter(read('baox', 'SKILL.md')), /user-invocable:\s*false/);
  for (const s of ['baox-setup', 'baox-recover']) {
    const fm = frontmatter(read(s, 'SKILL.md'));
    assert.match(fm, /user-invocable:\s*false/, `${s} 还能被用户直接唤起`);
    assert.match(fm, /disable-model-invocation:\s*false/, `${s} 模型也调不动，那它就没人调得动了`);
  }
});

// 判断散文一旦长回来，模型就又开始自己选下一步做什么 —— 而那是 1.0.0 要关掉的那个入口。
// 行数不是审美偏好，是那类散文放不进 120 行这件事本身。
test('三份说明书都不超过 120 行', () => {
  for (const s of ALL) {
    const n = read(s, 'SKILL.md').split('\n').length;
    assert.ok(n <= 120, `${s}/SKILL.md 有 ${n} 行，超过 120`);
  }
});

// 模型只会 `baox next`。说明书里出现第二条命令，等于告诉它还有第二条路。
// 只看代码块和行内代码 —— 散文里的 "the only baox entry point" 不是命令示例。
test('baox 与 baox-setup 的说明书里只出现 next 一条命令', () => {
  for (const s of ['baox', 'baox-setup']) {
    for (const f of walk(path.join(SKILLS, s))) {
      const found = commandsIn(fs.readFileSync(f, 'utf8')).filter((c) => c !== 'next');
      assert.deepEqual(found, [], `${path.relative(SKILLS, f)} 里出现了 next 以外的命令：${found}`);
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
