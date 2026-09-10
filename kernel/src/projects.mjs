import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { paths, writeJsonAtomic } from './paths.mjs';

const EMPTY = () => ({ projects: [] });
const text = (value) => typeof value === 'string' && value.trim() ? value.trim() : null;
const SAFE_PROJECT_NUMBER = /^[A-Za-z0-9_-]{1,64}$/;
const UNSAFE = 'unsafe';

export const isSafeProjectNumber = (value) =>
  typeof value === 'string' && SAFE_PROJECT_NUMBER.test(value);

function ownerOf(identity) {
  const account = text(identity?.account);
  const tenant = text(identity?.tenant);
  return account && tenant ? { account, tenant } : null;
}

export function sameIdentity(left, right) {
  const l = ownerOf(left);
  const r = ownerOf(right);
  return !!l && !!r && l.account === r.account && l.tenant === r.tenant;
}

export function identityKey(identity) {
  const owner = ownerOf(identity);
  return owner
    ? crypto.createHash('sha256').update(`${owner.tenant}\0${owner.account}`).digest('hex')
    : null;
}

export function bookPath(identity) {
  const key = identityKey(identity);
  return key ? path.join(paths.root, 'projects', `${key}.json`) : null;
}

const expiryValue = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed || null;
};

function normalize(project) {
  if (!project || typeof project !== 'object') return null;
  const number = text(project.number);
  if (!number) return null;
  return {
    number,
    name: text(project.name),
    confirmedAt: text(project.confirmedAt),
    expiresOn: expiryValue(project.expiresOn),
    lastCheckedAt: text(project.lastCheckedAt),
    lastVerdict: text(project.lastVerdict) ?? UNCONFIRMED,
  };
}

function parseStoredBook(file, identity) {
  let record;
  try {
    record = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false };
    return { exists: true, error: new Error('个人项目簿文件无法读取', { cause: error }) };
  }
  if (!owns(record, identity) || !Array.isArray(record.projects)) {
    return { exists: true, error: new Error('个人项目簿文件格式或身份不匹配') };
  }
  const projects = record.projects.map(normalize);
  if (projects.some((project) => !project)) {
    return { exists: true, error: new Error('个人项目簿包含无法识别的项目记录') };
  }
  return { exists: true, book: { projects } };
}

function owns(record, identity) {
  const owner = ownerOf(identity);
  const stored = ownerOf(record?.owner);
  return !!owner && !!stored && stored.account === owner.account && stored.tenant === owner.tenant;
}

export function readBook(identity) {
  const file = bookPath(identity);
  if (!file) return EMPTY();
  const parsed = parseStoredBook(file, identity);
  return parsed.book ?? EMPTY();
}

export function writeBook(identity, book) {
  const owner = ownerOf(identity);
  const file = bookPath(identity);
  if (!owner || !file) throw new Error('项目簿写入需要已确认的 tenant/account 身份');
  const existing = parseStoredBook(file, identity);
  if (existing.error) throw existing.error;
  if (!Array.isArray(book?.projects) || book.projects.some((project) => !normalize(project))) {
    throw new Error('项目簿写入内容格式不合法');
  }
  return writeJsonAtomic(file, {
    owner,
    projects: book.projects.map(normalize),
  });
}

export const EXPIRED = 'expired';
export const UNCONFIRMED = 'unconfirmed';

export function localToday(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function isValidDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

const usableToday = (today) => isValidDay(today) ? today : localToday();

export function invalidReasons(project, today = localToday()) {
  const day = usableToday(today);
  const reasons = [];
  if (!isSafeProjectNumber(project?.number)) reasons.push(UNSAFE);
  if (project?.expiresOn !== null
    && (!isValidDay(project?.expiresOn) || project.expiresOn < day)) reasons.push(EXPIRED);
  if (project?.lastVerdict !== 'confirmed') reasons.push(UNCONFIRMED);
  return reasons;
}

export const isSelectable = (project, today = localToday()) =>
  invalidReasons(project, today).length === 0;

export function selectableProjects(identity, today = localToday()) {
  return readBook(identity).projects.filter((project) =>
    isSafeProjectNumber(project.number) && isSelectable(project, today));
}

const REASON_LABEL = {
  [EXPIRED]: '已过期', [UNCONFIRMED]: '复检未通过', [UNSAFE]: '项目号不安全',
};
const VERDICT_NOTE = {
  missing: '最近一次核对时 ERP 里查不到这个项目号',
  ambiguous: '最近一次核对时这个项目号在 ERP 里对上了多条记录',
  unusable: '最近一次核对时这个项目已被 ERP 禁用或尚未审核',
  unsafe: '这个项目号含有不能安全查询的字符，请删除后从 ERP 重新录入',
};

export function annotateProjects(projects, today = localToday()) {
  const day = usableToday(today);
  return (projects ?? []).map((project) => {
    const reasons = invalidReasons(project, day);
    const notes = reasons.map((reason) => reason === EXPIRED
      ? (isValidDay(project.expiresOn)
        ? `已过期（过期时间 ${project.expiresOn}）`
        : `过期时间读不出来（${String(project.expiresOn)}），当作已过期`)
      : reason === UNSAFE
        ? '项目号含有不能安全查询的字符，请删除后从 ERP 重新录入'
      : (VERDICT_NOTE[project.lastVerdict]
        ?? `最近一次核对结果不是 confirmed（${String(project.lastVerdict)}）`));
    return {
      ...project,
      selectable: reasons.length === 0,
      invalidReasons: reasons,
      statusLabel: reasons.length ? reasons.map((reason) => REASON_LABEL[reason]).join('・') : '可选',
      statusNote: notes.length ? notes.join('；') : null,
    };
  });
}

export const PROJECT_BOOK_EMPTY = 'project_book_empty';

export function noCandidatesNote(projects = null) {
  if (projects === null) {
    return '打开个人项目簿维护页：没有项目就逐条录入；有项目但已过期或复检未通过，就修正后再回来做任务选择';
  }
  if (!projects.length) return '打开个人项目簿维护页逐条录入项目，再回来做任务选择';
  const labels = [...new Set(annotateProjects(projects)
    .filter((project) => !project.selectable).map((project) => project.statusLabel))].join('、');
  return `项目簿里有 ${projects.length} 条，但当前都不可选（${labels}）；请在维护页处理后再回来做任务选择`;
}
