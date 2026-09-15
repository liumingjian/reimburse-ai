// @vitest-environment node
// 界面文字不用 em-dash 与 en-dash（范围写作 No.2-4）：源码与样式里一律不出现。只读文件系统，不碰 DOM。
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const srcDir = fileURLToPath(new URL('./', import.meta.url));

describe('界面文案', () => {
  test('源码与样式里不含 em-dash 和 en-dash', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(tsx?|s?css)$/.test(entry.name)) files.push(full);
      }
    };
    walk(srcDir);
    expect(files.length).toBeGreaterThan(0);
    // en-dash U+2013、em-dash U+2014；用码点拼出来，免得这个文件自己撞上检查。
    const dashes = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);
    for (const file of files) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(dashes);
    }
  });
});
