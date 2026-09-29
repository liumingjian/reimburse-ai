// Copies a source tree into the dev-mode QA instance's own tree (qa/dev.sh), writing only files whose bytes differ and
// deleting files the source no longer has. Prints one line per path it wrote or deleted.
//
// Why not run the instance from the rexec workspace directly: the Mac's rsync (openrsync) re-stamps the times of every
// file on every sync, even an unchanged one, and the watchers (chokidar under Vite and tsx) report that as a change. A
// sync of a one-line web fix would then restart the server and reload the page from scratch. Comparing bytes here means
// the watchers see exactly the files the fix touched.
//
// Usage: node qa/mirror.mjs <from> <to>
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Per-directory installs and build output belong to each tree; the source's copies are never carried over, and the
// target's are never deleted.
const SKIPPED = new Set(['node_modules', '.git', 'dist', 'dist-mock', 'test-results', 'playwright-report']);

const [from, to] = process.argv.slice(2);
if (!from || !to) {
  console.error('usage: node qa/mirror.mjs <from> <to>');
  process.exit(64);
}

function mirror(rel) {
  const source = join(from, rel);
  const target = join(to, rel);
  mkdirSync(target, { recursive: true });
  const names = new Set();
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (SKIPPED.has(entry.name)) continue;
    names.add(entry.name);
    const path = join(rel, entry.name);
    if (entry.isDirectory()) {
      if (existsSync(join(to, path)) && !statSync(join(to, path)).isDirectory()) rmSync(join(to, path));
      mirror(path);
    } else if (entry.isFile()) {
      copyIfChanged(path);
    }
  }
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    if (SKIPPED.has(entry.name) || names.has(entry.name)) continue;
    rmSync(join(target, entry.name), { recursive: true, force: true });
    console.log(`deleted ${join(rel, entry.name)}`);
  }
}

function copyIfChanged(path) {
  const source = join(from, path);
  const target = join(to, path);
  const bytes = readFileSync(source);
  const mode = statSync(source).mode & 0o777;
  const current = existsSync(target) && statSync(target).isFile() ? readFileSync(target) : null;
  if (current === null || !current.equals(bytes)) {
    if (current === null && existsSync(target)) rmSync(target, { recursive: true, force: true });
    writeFileSync(target, bytes);
    console.log(`wrote ${path}`);
  }
  if ((statSync(target).mode & 0o777) !== mode) chmodSync(target, mode);
}

mirror('');
