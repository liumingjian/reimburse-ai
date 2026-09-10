import { authorizedPage, verifyProject, isSafeKey } from './erpcatalog.mjs';
import {
  readBook, writeBook, isValidDay, localToday, bookPath, sameIdentity,
} from './projects.mjs';

export const MAX_RETRIES = 3;

function expiryOf(value) {
  if (value === null || value === undefined) return { day: null };
  if (typeof value !== 'string') return { bad: true };
  const day = value.trim();
  if (!day) return { day: null };
  return isValidDay(day) ? { day } : { bad: true };
}

function sessionIdentity(session) {
  return session?.probe?.identity ?? session?.identity ?? null;
}

function resultFor(number, identity, status, fields = {}) {
  return { status, number: number ?? null, ...fields,
    ...(identity ? { book: readBook(identity), bookPath: bookPath(identity) } : { book: { projects: [] } }) };
}

function rejection(number, verdict) {
  const kind = verdict?.verdict;
  if (kind === 'missing') {
    return { verdict: kind, note: `项目号 ${number} 在 ERP 项目目录里查不到，没有加入个人项目簿；请核对后重新录入` };
  }
  if (kind === 'ambiguous') {
    return { verdict: kind, note: `项目号 ${number} 在 ERP 里对上了 ${verdict.count ?? '多'} 条记录，没有加入个人项目簿；请核实唯一项目号` };
  }
  return { verdict: kind ?? 'unusable', name: verdict?.name ?? null,
    note: `项目 ${number}「${verdict?.name ?? '—'}」在 ERP 里不可引用，没有加入个人项目簿` };
}

function admit(identity, number, name, expiresOn, at) {
  const book = readBook(identity);
  const entry = {
    number, name: String(name ?? '').trim() || null,
    confirmedAt: at,
    expiresOn,
    lastCheckedAt: at,
    lastVerdict: 'confirmed',
  };
  const index = book.projects.findIndex((project) => project.number === number);
  if (index >= 0) book.projects[index] = entry;
  else book.projects.push(entry);
  return { entry, book: writeBook(identity, book) };
}

/** 只有 ERP confirmed 的项目才可写入个人项目簿；名称永远取 ERP 回读值。 */
export async function intakeProject(number, expiresOn = null, {
  gate = authorizedPage,
  run,
  now = () => new Date().toISOString(),
  today = localToday(),
  identity = null,
} = {}) {
  if (expiresOn !== null && typeof expiresOn === 'object') {
    throw new TypeError('intakeProject 的第二个参数必须是过期时间字符串或 null');
  }
  const trimmed = typeof number === 'string' ? number.trim() : number;
  const currentBook = identity ? readBook(identity) : { projects: [] };
  const base = (status, fields = {}) => resultFor(trimmed, identity, status,
    { ...fields, book: currentBook });

  if (typeof trimmed !== 'string' || !trimmed || !isSafeKey(trimmed)) {
    return base('rejected', { verdict: 'unsafe',
      note: `项目号 ${JSON.stringify(trimmed)} 含有不能安全查询的字符，没有加入个人项目簿` });
  }
  const expiry = expiryOf(expiresOn);
  if (expiry.bad) {
    return base('rejected', { verdict: 'bad_expires_on',
      note: `过期时间「${String(expiresOn)}」不是有效日期，没有加入个人项目簿；请用 YYYY-MM-DD 或留空` });
  }

  const session = await gate();
  const current = sessionIdentity(session);
  if (!session?.ok || !current?.account || !current?.tenant) {
    return base('not_logged_in', { identity: current,
      note: '没有已核对的 ERP 身份，不能向个人项目簿录入项目' });
  }
  if (identity && !sameIdentity(identity, current)) {
    return base('identity_mismatch', { identity: current,
      note: '当前 ERP 身份已变化，个人项目簿没有改动；请回到原身份后重试' });
  }
  const owner = identity ?? current;
  let verdict;
  let queries = 0;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    verdict = await verifyProject(session.page, trimmed, run ? { run } : undefined);
    queries += 1;
    if (verdict.ok !== false) break;
  }
  if (verdict?.ok === false) {
    return resultFor(trimmed, owner, 'query_failed', { reason: verdict.reason, queries,
      note: `ERP 项目核对没有完成（${verdict.reason}），个人项目簿没有改动；稍后重试` });
  }
  if (verdict.verdict !== 'confirmed') {
    return resultFor(trimmed, owner, 'rejected', rejection(trimmed, verdict));
  }

  // ERP 查询是异步的；落盘前再读一次当前会话，避免用户中途换人后把项目写进旧身份的簿。
  const finalSession = await gate();
  const finalIdentity = sessionIdentity(finalSession);
  if (!finalSession?.ok || !finalIdentity?.account || !finalIdentity?.tenant) {
    return resultFor(trimmed, owner, 'not_logged_in', { identity: finalIdentity,
      queries, note: 'ERP 身份在项目核验期间失效，个人项目簿没有改动；请重新登录后重试' });
  }
  if (!sameIdentity(owner, finalIdentity)) {
    return resultFor(trimmed, owner, 'identity_mismatch', { identity: finalIdentity,
      queries, note: 'ERP 身份在项目核验期间发生变化，个人项目簿没有改动；请回到原身份后重试' });
  }

  const admitted = admit(owner, trimmed, verdict.name, expiry.day, now());
  const expiryNote = expiry.day === null ? '没有设置过期时间' : `过期时间为 ${expiry.day}`;
  return resultFor(trimmed, owner, 'admitted', {
    entry: admitted.entry,
    book: admitted.book,
    bookPath: bookPath(owner),
    queries,
    note: `项目 ${trimmed}「${admitted.entry.name ?? '—'}」已加入个人项目簿，名称取自 ERP 回读值；${expiryNote}`,
    ...(admitted.entry.expiresOn < today ? { selectable: false } : {}),
  });
}
