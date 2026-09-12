// 正式构建产物检查：dist/ 里不许出现 mock 代码、测试钩子与夹具（先运行 vite build）。
// 用法：node scripts/check-dist.mjs [目录]（默认 dist）。有命中时列出文件与模式并以 1 退出。
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const dist = resolve(packageRoot, process.argv[2] ?? 'dist');

// 夹具里的虚构人物、任务、草稿号与文件名；mock 模块与钩子的名字；mock 专用文案。
const FORBIDDEN = [
  /林颂宜/,
  /上海出差/,
  /华东客户交付/,
  /BX20260911/,
  /BX20260718/,
  /BX20260702/,
  /digest-t1/,
  /print-sheet\.pdf/,
  /fixtures\//,
  /sample-materials/,
  /mock-adapter/,
  /readMockOptions/,
  /createMockAdapter/,
  /__baoxMock/,
  /advanceElsewhere/,
  /service-disconnected/,
  /与已接收的/,
  /还没有检测到登录/,
];

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

if (!existsSync(join(dist, 'index.html'))) {
  console.error(`没有找到 ${relative(packageRoot, dist)}/index.html，请先运行 vite build`);
  process.exit(1);
}

const problems = [];
for (const dir of ['fixtures', 'sample-materials']) {
  if (existsSync(join(dist, dir))) problems.push(`${relative(packageRoot, dist)}/${dir}/ 不应存在`);
}
const all = files(dist);
for (const file of all) {
  const text = readFileSync(file, 'utf8');
  for (const pattern of FORBIDDEN) if (pattern.test(text)) problems.push(`${relative(packageRoot, file)} 含 ${pattern}`);
}

if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`${relative(packageRoot, dist)}/ 通过检查：${all.length} 个文件，${FORBIDDEN.length} 个模式均无命中，没有夹具与示例材料目录。`);
