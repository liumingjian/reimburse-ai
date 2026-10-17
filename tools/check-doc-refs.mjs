#!/usr/bin/env node
// `node tools/check-doc-refs.mjs`: every repo path a Markdown doc names must exist. Part of `pnpm lint`.
//
// Checked: relative Markdown link targets (`[text](path)`, resolved against the doc's directory) and inline-code paths
// with a source or doc extension (`server/src/a.ts`, `GLOSSARY.md`). An inline-code path counts as found when it exists
// from the repo root or the doc's directory, or when it is the tail of an existing file (`testing/fake-erp.ts`). A bare
// file name is checked only for `.md`, since tables cite code as `steps.ts:700`.
// Not checked: fenced code blocks, URLs, absolute and home paths, placeholders (`<id>`, `*`, `{a,b}`, `$VAR`), paths
// pinned to a commit (`50931a3:kernel/src/state.mjs`), build or runtime outputs (`dist`, `test-results`, …), which exist
// only after a build or on a host, and lines ending in `<!-- check-doc-refs: ignore -->` (a deleted file named on
// purpose, another repository's path). ADRs, research notes and review records are not checked at all: they record
// the tree as it was when they were written.
//
// It walks the file system rather than `git ls-files`, because the merge gate runs it in a rexec workspace on the Mac,
// which has no `.git`.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const SKIP_DIRS = new Set(['node_modules', '.git', '.pnpm-store', 'dist', 'dist-mock', 'test-results', 'playwright-report', 'worktrees', 'coverage']);
// Mirrors .gitignore: only these agent skills belong to the repo; the rest are installed locally.
const REPO_SKILLS = new Set(['deploy-intranet', 'verify']);
const OUTPUT_SEGMENTS = new Set(['dist', 'dist-mock', 'test-results', 'target', 'node_modules', 'logs', 'cache', 'data', 'etc']);
const CODE_EXT = /\.(md|ts|tsx|mts|mjs|cjs|js|json|sh|ya?ml)$/;
// Named on purpose although absent: read "if it exists".
const ABSENT_BY_DESIGN = new Set(['GLOSSARY-MAP.md']);
const HISTORICAL_DOCS = /^docs\/(adr|research|review)\//;
const IGNORE_LINE = /<!-- check-doc-refs: ignore -->\s*$/;

function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const rel = relative(root, path);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      if (/^\.(claude|agents)\/skills\/[^/]+$/.test(rel) && !REPO_SKILLS.has(entry.name)) continue;
      walk(path, out);
    } else if (entry.isFile()) out.push(rel);
  }
  return out;
}

const files = walk(root, []);
const fileSet = new Set(files);
const dirSet = new Set(files.flatMap((f) => f.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/'))));
const exists = (p) => fileSet.has(p) || dirSet.has(p);
const isTail = (p) => files.some((f) => f === p || f.endsWith(`/${p}`));

function candidates(doc) {
  const found = [];
  let fenced = false;
  readFileSync(join(root, doc), 'utf8').split('\n').forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced || IGNORE_LINE.test(line)) return;
    for (const m of line.matchAll(/\]\(([^)\s]+)\)/g)) found.push({ line: i + 1, ref: m[1], link: true });
    for (const m of line.matchAll(/`([^`\s]+)`/g)) found.push({ line: i + 1, ref: m[1], link: false });
  });
  return found;
}

function problem(doc, { ref, link }) {
  let path = ref.split('#')[0].replace(/:\d+(-\d+)?$/, '').replace(/\/$/, '');
  if (!path || /^[0-9a-f]{7,40}:/.test(path) || /^[a-z]+:/i.test(ref) || /^(\/|~|\.\.\.)/.test(path) || /[<>*{}$|()=,'"]/.test(path)) return null;
  if (path.split('/').some((s) => OUTPUT_SEGMENTS.has(s))) return null;
  if (!link && !CODE_EXT.test(path)) return null;
  if (!link && !path.includes('/') && !path.endsWith('.md')) return null;
  if (ABSENT_BY_DESIGN.has(path)) return null;
  const fromDoc = normalize(join(dirname(doc), path));
  if (exists(fromDoc) || (!link && (exists(normalize(path)) || isTail(normalize(path))))) return null;
  return path;
}

const missing = [];
const docs = files.filter((f) => f.endsWith('.md') && !HISTORICAL_DOCS.test(f));
for (const doc of docs) {
  for (const c of candidates(doc)) {
    const path = problem(doc, c);
    if (path) missing.push(`${doc}:${c.line}: ${path}`);
  }
}

if (missing.length) {
  console.error(`check-doc-refs: ${missing.length} doc reference(s) to a path that does not exist:`);
  for (const m of missing) console.error(`  ${m}`);
  console.error('Fix the path, or drop the reference if the file is gone (a renamed file: name the new one).');
  process.exit(1);
}
console.log(`check-doc-refs: ${docs.length} docs, every named path exists`);
