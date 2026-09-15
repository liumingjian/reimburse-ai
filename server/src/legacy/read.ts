import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { RECONCILE_BUCKETS, type LegacyImportProblemSchema, type ReconcileBucket } from '@baox/contract';
import type { z } from 'zod';
import { validHomeCity } from '../rules/company-rules';
import { bookFileKey, homeCityKey, LEGACY_INVOICE_KEY, type LegacyIdentity } from './keys';

// Reads a legacy `~/.baox` (schemaVersion 1) without ever writing to it: only readFileSync/readdirSync/statSync.
// Layout: kernel/src/paths.mjs, workspace.mjs, home-city.mjs, projects.mjs. Any corrupt file that the import needs
// makes the whole read `corrupt`, so the import writes nothing (ADR-0015). Stray `*.tmp` files from the kernel's
// temp+rename writes are ignored. `identity.json` is read only to pick the bound identity's home city and book; it is
// never imported (ADR-0018).

export type LegacyProblem = z.infer<typeof LegacyImportProblemSchema>;

export type LegacyTask = {
  legacyTaskId: string;
  label: string;
  createdAt: string;
  homeCity: string | null;
  erpWriteState: string;
  erpWriteAt: string | null;
  invoices: { key: string; fileName: string }[];
  // The last `erp-reconcile` attempt in `erp-attempts.json`, if any.
  reconcileBucket: ReconcileBucket | null;
  billNo: string | null;
};

export type LegacyProject = { number: string; name: string | null; confirmedAt: string | null; expiresOn: string | null };

export type LegacyData = {
  homeCity: { value: string; confirmedAt: string | null } | null;
  projects: LegacyProject[];
  // Tasks with a non-blank `erpWriteState`, whatever their status.
  touched: LegacyTask[];
  // Labels of tasks that never touched ERP: reported as not migrated.
  untouched: string[];
};

export type LegacyRead = { kind: 'absent' } | { kind: 'corrupt'; problems: LegacyProblem[] } | { kind: 'ok'; data: LegacyData };

// `$BAOX_HOME` or `~/.baox` (kernel/src/paths.mjs).
export function resolveLegacyHome(env: NodeJS.ProcessEnv = process.env): string {
  return env['BAOX_HOME'] || join(homedir(), '.baox');
}

const REASON = {
  unreadable: '文件无法读取',
  notJson: '不是合法的 JSON',
  shape: '内容格式不对',
  schema: (version: unknown) => `旧数据版本 ${String(version)} 不是这个应用能导入的版本 1`,
  owner: '个人项目簿的归属与绑定身份不一致',
  project: '个人项目簿里有无法识别的项目记录',
  meta: '任务记录缺少任务号或创建时间',
  invoice: '发票记录缺少合法的发票身份',
} as const;

type Json = { kind: 'missing' } | { kind: 'bad'; reason: string } | { kind: 'ok'; value: unknown };

function readJson(root: string, rel: string): Json {
  let text: string;
  try {
    text = readFileSync(join(root, ...rel.split('/')), 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'missing' } : { kind: 'bad', reason: REASON.unreadable };
  }
  try {
    return { kind: 'ok', value: JSON.parse(text) as unknown };
  } catch {
    return { kind: 'bad', reason: REASON.notJson };
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);
// Contract times are ISO 8601 to the second.
const isoSecond = (value: unknown): string | null => {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null;
  return `${new Date(value).toISOString().slice(0, 19)}Z`;
};

function entries(root: string, rel: string): { name: string; dir: boolean }[] {
  try {
    return readdirSync(join(root, rel), { withFileTypes: true })
      .map((entry) => ({ name: entry.name, dir: entry.isDirectory() }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

export function readLegacyTree(root: string): LegacyRead {
  try {
    if (!statSync(root).isDirectory()) return { kind: 'absent' };
  } catch {
    return { kind: 'absent' };
  }
  const schema = readJson(root, 'schema.json');
  if (schema.kind === 'missing') return { kind: 'absent' };
  const problems: LegacyProblem[] = [];
  const problem = (file: string, reason: string) => void problems.push({ file, reason });
  const load = (rel: string): unknown => {
    const read = readJson(root, rel);
    if (read.kind === 'bad') problem(rel, read.reason);
    return read.kind === 'ok' ? read.value : undefined;
  };

  if (schema.kind === 'bad') problem('schema.json', schema.reason);
  else if (!isRecord(schema.value) || schema.value['schemaVersion'] !== 1) problem('schema.json', REASON.schema(isRecord(schema.value) ? schema.value['schemaVersion'] : undefined));

  const identityValue = load('identity.json');
  const identity: LegacyIdentity = isRecord(identityValue) ? identityValue : null;

  const homeCity = readHomeCity(load('home-cities.json'), identity, (reason) => problem('home-cities.json', reason));
  const projects = readProjects(root, identity, load, problem);

  const touched: LegacyTask[] = [];
  const untouched: string[] = [];
  for (const dir of entries(root, 'tasks').filter((entry) => entry.dir)) {
    const base = `tasks/${dir.name}`;
    const meta = load(`${base}/meta.json`);
    if (meta === undefined) continue;
    const legacyTaskId = isRecord(meta) ? text(meta['taskId']) : null;
    const createdAt = isRecord(meta) ? isoSecond(meta['createdAt']) : null;
    if (!isRecord(meta) || !legacyTaskId || !createdAt) {
      problem(`${base}/meta.json`, REASON.meta);
      continue;
    }
    const label = text(meta['sourceLabel']) ?? legacyTaskId;
    const erpWriteState = text(meta['erpWriteState']);
    if (!erpWriteState) {
      untouched.push(label);
      continue;
    }
    touched.push({
      legacyTaskId,
      label,
      createdAt,
      homeCity: typeof meta['homeCity'] === 'string' ? validHomeCity(meta['homeCity']) : null,
      erpWriteState,
      erpWriteAt: isoSecond(meta['erpWriteAt']),
      invoices: readInvoices(load(`${base}/invoices.json`), (reason) => problem(`${base}/invoices.json`, reason)),
      ...readReconcile(load(`${base}/erp-attempts.json`), (reason) => problem(`${base}/erp-attempts.json`, reason)),
    });
  }

  if (problems.length > 0) return { kind: 'corrupt', problems };
  return { kind: 'ok', data: { homeCity, projects, touched, untouched } };
}

// home-cities.json: `{ [JSON [tenant, account]]: {homeCity, confirmedAt} }`; missing = empty. The bound identity's
// record; without a binding, the only record if there is exactly one. An invalid city reads as none (kernel).
function readHomeCity(value: unknown, identity: LegacyIdentity, bad: (reason: string) => void): LegacyData['homeCity'] {
  if (value === undefined) return null;
  if (!isRecord(value)) {
    bad(REASON.shape);
    return null;
  }
  const key = homeCityKey(identity);
  const records = Object.values(value);
  const record = key ? value[key] : records.length === 1 ? records[0] : undefined;
  if (!isRecord(record) || typeof record['homeCity'] !== 'string') return null;
  const city = validHomeCity(record['homeCity']);
  return city ? { value: city, confirmedAt: isoSecond(record['confirmedAt']) } : null;
}

// projects/<bookFileKey>.json of the bound identity; without a binding, the only book file if there is exactly one.
// `lastCheckedAt`/`lastVerdict` are dropped: the ERP job re-checks the catalog first (ADR-0014).
function readProjects(root: string, identity: LegacyIdentity, load: (rel: string) => unknown, problem: (file: string, reason: string) => void): LegacyProject[] {
  const files = entries(root, 'projects').filter((entry) => !entry.dir && entry.name.endsWith('.json'));
  const key = bookFileKey(identity);
  const file = key ? `${key}.json` : files.length === 1 ? files[0]?.name : undefined;
  if (!file || !files.some((entry) => entry.name === file)) return [];
  const rel = `projects/${file}`;
  const book = load(rel);
  if (book === undefined) return [];
  const owner = isRecord(book) && isRecord(book['owner']) ? book['owner'] : null;
  if (!isRecord(book) || !owner || !Array.isArray(book['projects'])) {
    problem(rel, REASON.shape);
    return [];
  }
  if (bookFileKey(owner) !== (key ?? bookFileKey(owner)) || bookFileKey(owner) === null) {
    problem(rel, REASON.owner);
    return [];
  }
  const projects: LegacyProject[] = [];
  for (const entry of book['projects'] as unknown[]) {
    const number = isRecord(entry) ? text(entry['number']) : null;
    const expires = isRecord(entry) ? entry['expiresOn'] : undefined;
    const expiresOn = typeof expires === 'string' ? text(expires) : null;
    if (!isRecord(entry) || !number || (expires !== null && expires !== undefined && typeof expires !== 'string') || (expiresOn !== null && !/^\d{4}-\d{2}-\d{2}$/.test(expiresOn))) {
      problem(rel, REASON.project);
      return [];
    }
    projects.push({ number, name: text(entry['name']), confirmedAt: isoSecond(entry['confirmedAt']), expiresOn });
  }
  return projects;
}

// invoices.json: `{invoices: [{identityKey, fileName, ...}]}`; missing = no invoices.
function readInvoices(value: unknown, bad: (reason: string) => void): LegacyTask['invoices'] {
  if (value === undefined) return [];
  if (!isRecord(value) || !Array.isArray(value['invoices'])) {
    bad(REASON.shape);
    return [];
  }
  const invoices: LegacyTask['invoices'] = [];
  for (const invoice of value['invoices'] as unknown[]) {
    const key = isRecord(invoice) && typeof invoice['identityKey'] === 'string' ? invoice['identityKey'] : '';
    if (!isRecord(invoice) || !LEGACY_INVOICE_KEY.test(key)) {
      bad(REASON.invoice);
      return [];
    }
    invoices.push({ key, fileName: text(invoice['fileName']) ?? key });
  }
  return invoices;
}

// erp-attempts.json: `{attempts: [...]}`; the last `erp-reconcile` attempt's bucket and bill number.
function readReconcile(value: unknown, bad: (reason: string) => void): Pick<LegacyTask, 'reconcileBucket' | 'billNo'> {
  const none = { reconcileBucket: null, billNo: null };
  if (value === undefined) return none;
  if (!isRecord(value) || !Array.isArray(value['attempts'])) {
    bad(REASON.shape);
    return none;
  }
  const last = (value['attempts'] as unknown[]).filter((attempt): attempt is Record<string, unknown> => isRecord(attempt) && attempt['kind'] === 'erp-reconcile').at(-1);
  if (!last) return none;
  const bucket = RECONCILE_BUCKETS.find((known) => known === last['bucket']) ?? null;
  const readings = isRecord(last['readings']) ? last['readings'] : {};
  return { reconcileBucket: bucket, billNo: text(readings['billNo']) };
}
