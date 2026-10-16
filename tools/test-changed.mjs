#!/usr/bin/env node
// `pnpm test:changed <file>...`: the inner-loop test command. Runs only the tests related to the changed files:
// - vitest `related` in every workspace package that owns a changed file or depends on one (workspace:* deps,
//   transitively). vitest follows each package's module graph, so a change in contract/src reaches web and server.
//   A change to a package's own config (package.json, tsconfig, vite/vitest config) runs that package's whole suite.
// - A change to a repository-root file (lockfile, pnpm-workspace.yaml, root package.json/tsconfig, .oxlintrc.json,
//   .npmrc, .nvmrc, …) can affect every package, so it runs every package's whole suite and every e2e spec. Root docs
//   (*.md, LICENSE) and files outside every package and the root (docs/, qa/, tools/, …) select nothing; they are
//   listed as not covered, and a run that selects nothing says so instead of reporting PASS.
// - Playwright only when a changed file is under web/e2e (a spec or the harness): the specs whose import graph reaches
//   a changed file (the `--only-changed` rule), after building only what those specs need (dist-mock for the mock
//   project, server + web dist for the server project). For any other change the specs it reaches are listed, not
//   run: they belong to the full gate. `--e2e` runs them anyway, `--no-e2e` never runs any.
//
// The file list is an argument, not `git diff`, because rexec's Mac workspace usually has no usable git history
// (it is not synced by default, and a worktree's `.git` file points at a path that exists only on the agent server).
// Compute the list where git works and pass it in; see docs/agents/testing.md. `--base <ref>` computes it here
// instead, for a checkout that has real history.
//
// `--gate` prints which merge gate the change needs (docs/agents/merge-conditions.md) and runs nothing:
// - docs: every file is documentation or agent configuration (*.md, docs/, .claude/, .agents/); no test can see it.
// - standard: everything else. A file the whole app rests on (FULL_GATE) is named as a journey foundation: it does not
//   raise the PR's gate, but it is why the next full gate (integration landing, deploy) matters.
//
// Flags: --base <ref>  --gate  --e2e (run the reached specs)  --no-e2e (run none)  --no-build (reuse the existing e2e
// builds)  --dry-run (print the plan)
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(ROOT, 'web');
const E2E = join(WEB, 'e2e');
const E2E_SERVER = join(E2E, 'server');
const CONFIG_FILE = /^(package\.json|tsconfig(\..+)?\.json|vite(st)?\.config\.[cm]?[jt]s)$/;
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.mjs', '.js'];
const ROOT_DOCS = /^(.*\.md|LICEN[CS]E(\..*)?|\.gitignore)$/i;
// Paths are relative to the root, '/'-separated.
const DOCS_GATE = /(^|\/)[^/]*\.md$|^(docs|\.claude|\.agents)\/|^LICEN[CS]E(\..*)?$|^\.gitignore$/i;
// The HTTP contract both sides speak, the database schema, and the e2e harness itself.
const FULL_GATE = /^(contract\/src|server\/src\/db)\/|^server\/src\/e2e-main\.ts$|^web\/playwright\.config\.ts$|^web\/e2e\/server\/fixture\.ts$/;

// A file directly in the repository root that is not documentation: it may configure every package.
const isRootConfig = (file) => dirname(file) === ROOT && !ROOT_DOCS.test(relative(ROOT, file));

function parseArgs(argv) {
  const options = { base: null, gate: false, e2e: 'auto', build: true, dryRun: false, files: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') continue;
    else if (arg === '--base') options.base = argv[++i];
    else if (arg === '--gate') options.gate = true;
    else if (arg === '--e2e') options.e2e = true;
    else if (arg === '--no-e2e') options.e2e = false;
    else if (arg === '--no-build') options.build = false;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg.startsWith('--')) throw new Error(`unknown flag ${arg}`);
    else options.files.push(arg);
  }
  return options;
}

let dryRun = false;

function run(command, args, cwd = ROOT, env = process.env) {
  console.log(`\n$ ${relative(ROOT, cwd) || '.'}: ${command} ${args.map((a) => (a.startsWith(ROOT) ? relative(ROOT, a) : a)).join(' ')}`);
  if (dryRun) return 0;
  return spawnSync(command, args, { cwd, env, stdio: 'inherit' }).status ?? 1;
}

// Committed changes since the merge base with <base>, plus uncommitted and untracked files.
function changedSince(base) {
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed (no usable history here? pass the files instead):\n${result.stderr}`);
    return result.stdout.split('\n').filter(Boolean);
  };
  const [mergeBase] = git('merge-base', 'HEAD', base);
  return [...git('diff', '--name-only', mergeBase), ...git('ls-files', '--others', '--exclude-standard')];
}

function workspacePackages() {
  // The `packages:` list only; the file's other lists (onlyBuiltDependencies, …) name npm packages, not directories.
  const lines = readFileSync(join(ROOT, 'pnpm-workspace.yaml'), 'utf8').split('\n');
  const start = lines.findIndex((line) => /^packages:\s*$/.test(line));
  const dirs = [];
  for (const line of lines.slice(start + 1)) {
    const entry = /^\s+-\s+['"]?([^'"\s]+)['"]?\s*$/.exec(line);
    if (entry) dirs.push(entry[1]);
    else if (/^\S/.test(line)) break;
  }
  return dirs.map((dir) => {
    const manifest = JSON.parse(readFileSync(join(ROOT, dir, 'package.json'), 'utf8'));
    const deps = { ...manifest.dependencies, ...manifest.devDependencies };
    return {
      name: manifest.name,
      dir: join(ROOT, dir),
      workspaceDeps: Object.keys(deps).filter((dep) => String(deps[dep]).startsWith('workspace:')),
      vitest: /\bvitest\b/.test(manifest.scripts?.test ?? ''),
    };
  });
}

const inside = (file, dir) => file === dir || file.startsWith(dir + sep);

function ownerOf(file, packages) {
  return packages.filter((pkg) => inside(file, pkg.dir)).sort((a, b) => b.dir.length - a.dir.length)[0] ?? null;
}

// Packages to run vitest in: owners of changed files and everything depending on them. `full` marks a package whose
// own config changed, where `related` would find nothing because no test imports a config file.
function vitestPlan(files, packages) {
  const selected = new Map();
  const select = (pkg, full) => selected.set(pkg.name, { pkg, full: full || (selected.get(pkg.name)?.full ?? false) });
  const addWithDependents = (owner, full) => {
    const queue = [owner];
    const seen = new Set();
    while (queue.length > 0) {
      const pkg = queue.shift();
      if (seen.has(pkg.name)) continue;
      seen.add(pkg.name);
      if (pkg.vitest) select(pkg, pkg === owner && full);
      queue.push(...packages.filter((other) => other.workspaceDeps.includes(pkg.name)));
    }
  };
  if (files.some(isRootConfig)) {
    for (const pkg of packages) if (pkg.vitest) select(pkg, true);
    return [...selected.values()];
  }
  for (const file of files) {
    const owner = ownerOf(file, packages);
    if (owner) addWithDependents(owner, relative(owner.dir, file).split(sep).length === 1 && CONFIG_FILE.test(relative(owner.dir, file)));
  }
  return [...selected.values()];
}

// A small import graph over web/e2e: relative imports are followed file by file (into web/src too); a bare
// `@baox/<pkg>` import makes the spec depend on every file of that workspace package.
function importsOf(file, packages) {
  const text = readFileSync(file, 'utf8');
  const specifiers = [...text.matchAll(/(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1] ?? m[2]);
  const files = [];
  const packageDirs = [];
  for (const specifier of specifiers) {
    if (specifier.startsWith('.')) {
      const base = resolve(dirname(file), specifier);
      const candidates = [base, ...SOURCE_EXTENSIONS.map((ext) => base + ext), ...SOURCE_EXTENSIONS.map((ext) => join(base, `index${ext}`))];
      const found = candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
      if (found) files.push(found);
    } else {
      const pkg = packages.find((candidate) => specifier === candidate.name || specifier.startsWith(`${candidate.name}/`));
      if (pkg) packageDirs.push(pkg.dir);
    }
  }
  return { files, packageDirs };
}

function specFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return specFiles(path);
    return entry.name.endsWith('.spec.ts') ? [path] : [];
  });
}

function affectedSpecs(files, packages) {
  const all = specFiles(E2E);
  if (files.some((file) => file === join(WEB, 'playwright.config.ts') || isRootConfig(file))) return all;
  const changed = new Set(files);
  return all.filter((spec) => {
    const seen = new Set();
    const queue = [spec];
    while (queue.length > 0) {
      const file = queue.shift();
      if (seen.has(file)) continue;
      seen.add(file);
      if (changed.has(file)) return true;
      const { files: imported, packageDirs } = importsOf(file, packages);
      if (packageDirs.some((dir) => files.some((changedFile) => inside(changedFile, dir)))) return true;
      queue.push(...imported.filter((next) => SOURCE_EXTENSIONS.some((ext) => next.endsWith(ext))));
    }
    return false;
  });
}

function gateOf(files) {
  const paths = files.map((file) => relative(ROOT, file).split(sep).join('/'));
  const foundation = paths.filter((path) => FULL_GATE.test(path) || isRootConfig(join(ROOT, path)));
  const code = paths.filter((path) => !DOCS_GATE.test(path));
  return { gate: code.length > 0 ? 'standard' : 'docs', because: code, foundation };
}

const list = (paths) => `${paths.slice(0, 5).join(', ')}${paths.length > 5 ? ', …' : ''}`;

function main() {
  const options = parseArgs(process.argv.slice(2));
  dryRun = options.dryRun;
  const listed = options.base ? [...options.files, ...changedSince(options.base)] : options.files;
  if (listed.length === 0) {
    console.error('usage: pnpm test:changed <changed file>... | --base <ref>   (see docs/agents/testing.md)');
    return 2;
  }
  // Deleted files drop out: whatever imported them changed too, and that is what vitest and the spec graph follow.
  const files = [...new Set(listed.map((file) => resolve(ROOT, file)))].filter((file) => existsSync(file) && statSync(file).isFile());
  if (options.gate) {
    // Deleted files count here: removing a migration is a schema change.
    const { gate, because, foundation } = gateOf([...new Set(listed.map((file) => resolve(ROOT, file)))]);
    console.log(`test:changed: gate ${gate}${because.length > 0 ? ` (${list(because)})` : ''}`);
    if (foundation.length > 0) console.log(`test:changed: journey foundation changed (${list(foundation)}); the next full gate covers it`);
    return 0;
  }
  const packages = workspacePackages();
  const failures = [];

  const plan = vitestPlan(files, packages);
  for (const { pkg, full } of plan) {
    const args = full ? ['exec', 'vitest', 'run'] : ['exec', 'vitest', 'related', '--run', '--passWithNoTests', ...files];
    if (run('pnpm', args, pkg.dir) !== 0) failures.push(`vitest ${pkg.name}`);
  }

  const reached = options.e2e === false ? [] : affectedSpecs(files, packages);
  const runE2e = options.e2e === true || (options.e2e === 'auto' && files.some((file) => inside(file, E2E)));
  const specs = runE2e ? reached : [];
  if (specs.length > 0) {
    const needsServer = specs.some((spec) => inside(spec, E2E_SERVER));
    const needsMock = specs.some((spec) => !inside(spec, E2E_SERVER));
    let built = true;
    if (options.build && needsServer) {
      built = run('pnpm', ['--filter', '@baox/server', '--filter', '@baox/web', 'build'], ROOT, { ...process.env, BAOX_BUILD_E2E: '1' }) === 0;
    }
    if (built && options.build && needsMock) built = run('pnpm', ['--filter', '@baox/web', 'build:mock']) === 0;
    if (!built) failures.push('e2e build');
    else if (run('pnpm', ['exec', 'playwright', 'test', ...specs], WEB) !== 0) failures.push('playwright');
  }

  if (reached.length > 0 && !runE2e) {
    console.log(`\ntest:changed: ${reached.length} e2e spec(s) reach these files, left to the full gate (--e2e runs them): ${list(reached.map((spec) => relative(WEB, spec)))}`);
  }
  const uncovered = files.filter((file) => !ownerOf(file, packages) && !isRootConfig(file)).map((file) => relative(ROOT, file));
  if (uncovered.length > 0) console.log(`\ntest:changed: not covered by any package suite: ${uncovered.join(', ')}`);
  const verdict = failures.length > 0 ? `FAIL: ${failures.join(', ')}` : plan.length === 0 && specs.length === 0 ? 'NOTHING RUN' : 'PASS';
  console.log(
    `\ntest:changed: ${files.length} file(s); vitest in ${plan.map(({ pkg, full }) => (full ? `${pkg.name} (full)` : pkg.name)).join(', ') || 'none'}; ` +
      `${specs.length} e2e spec(s) run. ${verdict}`,
  );
  return failures.length === 0 ? 0 : 1;
}

process.exitCode = main();
