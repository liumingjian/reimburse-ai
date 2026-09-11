// 把 DESIGN.md front matter 变成 tokens.css 的纯函数；build-tokens.mjs 负责读写文件，测试直接调用这里。
import { extractFrontMatter, parseYamlSubset } from './front-matter.mjs';

const GROUP_PREFIX = {
  colors: 'color',
  fonts: 'font',
  typography: 'text',
  rounded: 'radius',
  spacing: 'space',
  layout: 'layout',
};

export const TOKENS_HEADER = '/* 由 scripts/build-tokens.mjs 从 DESIGN.md front matter 生成，不要手改；改 DESIGN.md 后运行 pnpm tokens。 */';

export function generateTokensCss(markdown) {
  const fm = parseYamlSubset(extractFrontMatter(markdown));
  const declarations = [];

  const resolveRefs = (value) =>
    String(value).replace(/\{([a-z]+)\.([\w-]+)\}/g, (_, group, key) => {
      const prefix = GROUP_PREFIX[group];
      if (!prefix) throw new Error(`未知的 token 组：${group}`);
      if (!fm[group] || !(key in fm[group])) throw new Error(`引用了不存在的 token：${group}.${key}`);
      return `var(--${prefix}-${key})`;
    });

  for (const [group, prefix] of Object.entries(GROUP_PREFIX)) {
    if (group === 'typography') continue;
    for (const [key, value] of Object.entries(fm[group] ?? {})) {
      declarations.push([`--${prefix}-${key}`, resolveRefs(value)]);
    }
  }

  for (const [name, style] of Object.entries(fm.typography ?? {})) {
    if (!fm.fonts || !(style.fontFamily in fm.fonts)) throw new Error(`typography.${name} 引用了不存在的字体 ${style.fontFamily}`);
    const family = `var(--font-${style.fontFamily})`;
    declarations.push([`--text-${name}-family`, family]);
    declarations.push([`--text-${name}-size`, style.fontSize]);
    declarations.push([`--text-${name}-weight`, style.fontWeight]);
    declarations.push([`--text-${name}-line`, style.lineHeight]);
    declarations.push([`--text-${name}-tracking`, style.letterSpacing]);
    declarations.push([`--text-${name}`, `${style.fontWeight} ${style.fontSize}/${style.lineHeight} ${family}`]);
  }

  for (const [component, props] of Object.entries(fm.components ?? {})) {
    for (const [prop, value] of Object.entries(props)) {
      declarations.push([`--${component}-${kebab(prop)}`, resolveRefs(value)]);
    }
  }

  const body = declarations.map(([name, value]) => `  ${name}: ${value};`).join('\n');
  return `${TOKENS_HEADER}\n:root {\n  color-scheme: light;\n${body}\n}\n`;
}

function kebab(name) {
  return name.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`);
}
