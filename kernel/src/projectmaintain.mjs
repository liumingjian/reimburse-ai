import { authorizedPage, verifyProject, isSafeKey } from './erpcatalog.mjs';
import {
  readBook, writeBook, isSelectable, localToday, annotateProjects, sameIdentity,
} from './projects.mjs';

function sessionIdentity(session) {
  return session?.probe?.identity ?? session?.identity ?? null;
}

export function removeProject(number, identity) {
  if (!identity?.account || !identity?.tenant) {
    return { status: 'identity_required', number: number ?? null, book: { projects: [] },
      note: '删除项目需要已确认的 tenant/account 身份' };
  }
  const trimmed = typeof number === 'string' ? number.trim() : number;
  const book = readBook(identity);
  const index = book.projects.findIndex((project) => project.number === trimmed);
  if (index < 0) return { status: 'not_found', number: trimmed ?? null, book,
    note: `个人项目簿里没有项目号 ${String(trimmed)}` };
  const [removed] = book.projects.splice(index, 1);
  return { status: 'removed', number: removed.number, removed,
    book: writeBook(identity, book),
    note: `项目 ${removed.number}「${removed.name ?? '—'}」已从个人项目簿删除；已选任务中的历史归属不受影响` };
}

export function purgeInvalidProjects(identity, today = localToday()) {
  if (!identity?.account || !identity?.tenant) {
    return { status: 'identity_required', removedCount: 0, removed: [], book: { projects: [] },
      note: '清理项目需要已确认的 tenant/account 身份' };
  }
  const book = readBook(identity);
  const dead = book.projects.filter((project) => !isSelectable(project, today));
  if (!dead.length) return { status: 'none', removedCount: 0, removed: [], book,
    note: '当前没有失效项目，一条都没删' };
  const removed = annotateProjects(dead, today);
  const kept = book.projects.filter((project) => isSelectable(project, today));
  return { status: 'purged', removedCount: removed.length, removed,
    book: writeBook(identity, { projects: kept }),
    note: `已清理 ${removed.length} 条失效项目；合法历史任务中的项目归属不受影响` };
}

export async function recheckAll({
  identity,
  gate = authorizedPage,
  run,
  now = () => new Date().toISOString(),
  today = localToday(),
} = {}) {
  if (!identity?.account || !identity?.tenant) {
    return { status: 'identity_required', queries: 0, book: { projects: [] },
      note: '复检项目需要已确认的 tenant/account 身份' };
  }
  const book = readBook(identity);
  if (!book.projects.length) return { status: 'empty', queries: 0, checkedCount: 0,
    confirmedCount: 0, invalidCount: 0, book, note: '个人项目簿是空的，没有什么可复检的' };

  const askable = book.projects.filter((project) => isSafeKey(project.number));
  const unsafe = new Set(book.projects.filter((project) => !isSafeKey(project.number))
    .map((project) => project.number));
  let session = null;
  if (askable.length) {
    session = await gate();
    const current = sessionIdentity(session);
    if (!session?.ok || !current?.account || !current?.tenant) {
      return { status: 'not_logged_in', queries: 0, identity: current, book,
        note: '没有已核对的 ERP 身份，不能复检个人项目簿' };
    }
    if (!sameIdentity(identity, current)) {
      return { status: 'identity_mismatch', queries: 0, identity: current, book,
        note: '当前 ERP 身份已变化，个人项目簿没有改动；请回到原身份后重试' };
    }
  }

  const checked = [];
  for (const project of askable) {
    const verdict = await verifyProject(session.page, project.number, run ? { run } : undefined);
    if (verdict.ok === false) return { status: 'query_failed', queries: checked.length + 1,
      reason: verdict.reason, book,
      note: `复检没有完成（${verdict.reason}），个人项目簿没有改动` };
    checked.push(verdict);
  }
  // ERP 查询是异步的；落盘前再读一次当前会话，避免用户中途换人后把结果写进旧身份的簿。
  if (askable.length) {
    const finalSession = await gate();
    const finalIdentity = sessionIdentity(finalSession);
    if (!finalSession?.ok || !finalIdentity?.account || !finalIdentity?.tenant) {
      return { status: 'not_logged_in', queries: checked.length, identity: finalIdentity, book,
        note: 'ERP 身份在项目复检期间失效，个人项目簿没有改动；请重新登录后重试' };
    }
    if (!sameIdentity(identity, finalIdentity)) {
      return { status: 'identity_mismatch', queries: checked.length, identity: finalIdentity, book,
        note: 'ERP 身份在项目复检期间发生变化，个人项目簿没有改动；请回到原身份后重试' };
    }
  }
  const verdicts = new Map(checked.map((entry) => [entry.number, entry]));
  // Use the current book after network calls so a concurrent user deletion is never resurrected.
  const currentBook = readBook(identity);
  const projects = currentBook.projects.map((project) => {
    if (unsafe.has(project.number)) return { ...project, lastVerdict: 'unsafe' };
    const verdict = verdicts.get(project.number);
    return verdict ? { ...project, ...(verdict.verdict === 'confirmed' && verdict.name
      ? { name: String(verdict.name).trim() || project.name } : {}),
      lastVerdict: verdict.verdict, lastCheckedAt: now() } : project;
  });
  const written = writeBook(identity, { projects });
  const annotated = annotateProjects(written.projects, today);
  const invalid = annotated.filter((project) => !project.selectable);
  return { status: 'done', queries: checked.length, checkedCount: checked.length,
    confirmedCount: projects.filter((project) => project.lastVerdict === 'confirmed').length,
    invalidCount: invalid.length, book: written,
    note: `复检了 ${checked.length} 条项目，其中 ${invalid.length} 条当前不可选；复检不会自动删除项目` };
}
