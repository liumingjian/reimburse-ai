// Dumps the per-file recognition verdict for the current QA task, so a parsing
// gap can be read file by file instead of through the truncated page text.
//   pnpm exec node qa/dump.mjs
import { request } from '@playwright/test';

const BASE = process.env['QA_BASE'] ?? 'http://127.0.0.1:4319';
const ACCOUNT = { username: process.env['QA_USER'] ?? 'admin', password: process.env['QA_PASSWORD'] ?? 'admin123' };

const ctx = await request.newContext({ baseURL: BASE });
const login = await ctx.post('/api/auth/login', { data: ACCOUNT });
if (!login.ok()) {
  console.log(`login failed: ${login.status()} ${await login.text()}`);
  process.exit(1);
}

// Shapes are guessed from here, so print the raw payloads and let the reader decide.
const listText = await (await ctx.get('/api/tasks')).text();
console.log('=== GET /api/tasks ===');
console.log(listText.slice(0, 4000));

const id = /"(?:taskId|id)"\s*:\s*"([0-9a-f-]{36})"/.exec(listText)?.[1];
console.log(`\nresolved task id: ${id}`);
if (!id) process.exit(0);

const snapText = await (await ctx.get(`/api/tasks/${id}`)).text();
let snap;
try {
  snap = JSON.parse(snapText);
} catch {
  console.log(snapText.slice(0, 2000));
  process.exit(0);
}
console.log(`\nsnapshot keys: ${Object.keys(snap).join(', ')}`);

// Walk the snapshot for anything that looks like a per-file record, without
// assuming where the parser hangs them.
const seen = [];
(function walk(node, path, depth) {
  if (!node || typeof node !== 'object' || depth > 6) return;
  if (Array.isArray(node)) {
    node.forEach((v, i) => walk(v, `${path}[${i}]`, depth + 1));
    return;
  }
  const keys = Object.keys(node);
  if (keys.some((k) => /fileName|file_name|originalName/.test(k))) seen.push({ path, node });
  for (const k of keys) walk(node[k], `${path}.${k}`, depth + 1);
})(snap, '$', 0);

console.log(`\n=== ${seen.length} file-bearing records ===`);
const printed = new Set();
for (const { path, node } of seen) {
  const name = node.fileName ?? node.file_name ?? node.originalName;
  const key = `${path.replace(/\[\d+\]/g, '[]')}::${name}`;
  if (printed.has(key)) continue;
  printed.add(key);
  const slim = {};
  for (const [k, v] of Object.entries(node)) {
    if (typeof v === 'object' && v !== null) continue;
    slim[k] = v;
  }
  console.log(`${path.replace(/\[\d+\]/g, '[]')}  ${JSON.stringify(slim).slice(0, 500)}`);
}

for (const section of ['inventory', 'pending', 'confirmation', 'erp']) {
  const value = snap[section];
  if (!value) continue;
  console.log(`\n=== ${section} ===`);
  console.log(JSON.stringify(value).slice(0, 6000));
}

await ctx.dispose();
