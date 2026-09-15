// Slice #197 retired the Skill era: kernel/, skills/, packages/image-field-extraction and the Skill-era root
// scripts are gone. No file may point at them as live paths. A historical pointer must name the last commit that
// has them, in git revision:path form (`50931a3:kernel/src/erpform.mjs`), which the patterns below allow.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const self = fileURLToPath(import.meta.url);

const RETIRED_DIRS = ['kernel', 'skills', 'scripts', 'packages'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'dist-mock', 'test-results', 'playwright-report', '.claude', '.agents', 'resources', 'release']);
const TEXT = new Set(['.ts', '.tsx', '.mts', '.mjs', '.js', '.cjs', '.json', '.md', '.yaml', '.yml', '.css', '.html', '.sh', '']);
const SKIP_FILES = new Set(['pnpm-lock.yaml', 'skills-lock.json']);

// `(?<![\w./@:-])` keeps `server/scripts/`, `50931a3:kernel/` and `@scope/pkg` out; `../kernel/` is caught separately.
const LEAD = String.raw`(?<![\w./@:-])`;
const RETIRED_SCRIPTS = ['bundle.sh', 'release.sh', 'qa-dist.sh', 'install-permissions.mjs', 'make-parse-edge-corpus.mjs'];
const PATTERNS = [
  new RegExp(`${LEAD}(kernel|skills)/`),
  new RegExp(`${LEAD}packages/image-field-extraction`),
  new RegExp(`${LEAD}scripts/(${RETIRED_SCRIPTS.map((s) => s.replace('.', '\\.')).join('|')})`),
  /\.\.\/(kernel|skills|packages)\//,
];

function* textFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* textFiles(path);
    } else if (entry.isFile() && TEXT.has(extname(entry.name)) && !SKIP_FILES.has(entry.name) && path !== self) {
      yield path;
    }
  }
}

describe('retired Skill-era paths', () => {
  it('the retired directories are gone', () => {
    expect(RETIRED_DIRS.filter((dir) => existsSync(join(root, dir)))).toEqual([]);
  });

  it('no file references them', () => {
    const hits: string[] = [];
    for (const file of textFiles(root)) {
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (PATTERNS.some((pattern) => pattern.test(line))) hits.push(`${relative(root, file)}:${i + 1}: ${line.trim().slice(0, 160)}`);
      });
    }
    expect(hits).toEqual([]);
  });
});
