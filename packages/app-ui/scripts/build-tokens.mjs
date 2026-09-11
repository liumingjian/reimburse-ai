#!/usr/bin/env node
// 用法：node scripts/build-tokens.mjs        生成 src/styles/tokens.css
//       node scripts/build-tokens.mjs --check 只比对，不一致时退出码 1
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generateTokensCss } from './tokens.mjs';

const designPath = fileURLToPath(new URL('../DESIGN.md', import.meta.url));
const outputPath = fileURLToPath(new URL('../src/styles/tokens.css', import.meta.url));

const css = generateTokensCss(readFileSync(designPath, 'utf8'));
const count = (css.match(/^ {2}--/gm) ?? []).length;

if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(outputPath, 'utf8');
  } catch {
    current = '';
  }
  if (current !== css) {
    console.error('tokens.css 与 DESIGN.md 不一致，请运行 pnpm tokens');
    process.exit(1);
  }
  console.log(`tokens.css 已是最新（${count} 个自定义属性）`);
} else {
  writeFileSync(outputPath, css);
  console.log(`已生成 ${outputPath}（${count} 个自定义属性）`);
}
