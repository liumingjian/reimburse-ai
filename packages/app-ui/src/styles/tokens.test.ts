// @vitest-environment node
// 只读文件系统，不碰 DOM；jsdom 环境下 import.meta.url 不是 file: URL。
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { generateTokensCss } from '../../scripts/tokens.mjs';

const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
const stylesDir = join(packageRoot, 'src', 'styles');
const design = readFileSync(join(packageRoot, 'DESIGN.md'), 'utf8');
const tokensCss = readFileSync(join(stylesDir, 'tokens.css'), 'utf8');
const pageCss = readdirSync(stylesDir)
  .filter((name) => name.endsWith('.css') && name !== 'tokens.css')
  .map((name) => ({ name, css: readFileSync(join(stylesDir, name), 'utf8') }));

const definedTokens = new Set([...tokensCss.matchAll(/^\s*(--[\w-]+):/gm)].map((match) => match[1]));

describe('tokens.css 由 DESIGN.md 生成', () => {
  test('tokens.css 与 DESIGN.md front matter 一致（改了 DESIGN.md 要重新运行 pnpm tokens）', () => {
    expect(tokensCss).toBe(generateTokensCss(design));
  });

  test('颜色、字体、字号、圆角、间距、组件尺寸都有对应的自定义属性', () => {
    for (const name of [
      '--color-primary',
      '--color-hairline-strong',
      '--font-mono',
      '--text-title',
      '--text-caption-size',
      '--radius-pill',
      '--space-xxs',
      '--layout-content-max-width',
      '--button-primary-min-height',
      '--panel-padding',
      '--sidebar-width',
      '--top-bar-height',
    ]) {
      expect(definedTokens.has(name), name).toBe(true);
    }
  });

  test('组件里的 {group.key} 引用解析成 var(--…)', () => {
    expect(tokensCss).toContain('--button-primary-background-color: var(--color-primary);');
    expect(tokensCss).toContain('--panel-border: 1px var(--color-hairline);');
    expect(tokensCss).toContain('--button-primary-typography: var(--text-button);');
  });
});

describe('页面 CSS 只引用 token', () => {
  test('页面 CSS 引用的每个自定义属性都在 tokens.css 里定义', () => {
    for (const { name, css } of pageCss) {
      const used = new Set([...css.matchAll(/var\((--[\w-]+)/g)].map((match) => match[1]));
      for (const token of used) {
        expect(definedTokens.has(token), `${name} 引用了未定义的 ${token}`).toBe(true);
      }
    }
  });

  test('页面 CSS 不写字面颜色与像素值（媒体查询除外）', () => {
    for (const { name, css } of pageCss) {
      const lines = css.split('\n').filter((line) => !line.trim().startsWith('@media'));
      const body = lines.join('\n');
      expect(body, `${name} 含字面颜色`).not.toMatch(/#[0-9a-f]{3,8}\b|\brgba?\(/i);
      expect(body, `${name} 含像素值`).not.toMatch(/\b\d+(?:\.\d+)?px\b/);
    }
  });
});

describe('界面文案', () => {
  test('源码里的中文文案不含 em-dash 和 en-dash', () => {
    const srcDir = join(packageRoot, 'src');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(tsx?|css)$/.test(entry.name)) files.push(full);
      }
    };
    walk(srcDir);
    // en-dash U+2013、em-dash U+2014；用码点拼出来，免得这个文件自己撞上检查。
    const dashes = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);
    for (const file of files) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(dashes);
    }
  });
});
