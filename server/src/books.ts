import { randomUUID } from 'node:crypto';
import { PROJECT_BOOK_NOTES, PUBLIC_PROJECT_BOOK_NOTES, type ProjectBook, type ProjectBookEntry, type ProjectBookResult } from '@baox/contract';
import { isSafeProjectNumber, type CatalogLookup, type ProjectCatalog } from './catalog/project-catalog';
import type { Db } from './db/database';

// 项目簿 (project books): the 个人项目簿 (personal book, one per account) and, with #194, the 公共项目簿 (public book).
// Both are the same append-only event stream `project_book_event` (admitted / checked / removed), told apart by
// `scope` and `owner_account_id` (null for public); the current book is a fold of that stream.
// Ported from 50931a3:kernel/src/projects.mjs (selectable rules, labels), projectintake.mjs (intake) and projectmaintain.mjs
// (remove, purge, recheck). Names come only from the catalog; there is no edit, re-intake replaces.
// In the public book a removal deactivates: the entry stays listed as 已停用 and cannot be chosen; re-intake revives it.

export type BookRef = { scope: 'personal'; ownerAccountId: string } | { scope: 'public' };
export type ProjectSource = BookRef['scope'];

type Verdict = 'confirmed' | 'missing' | 'ambiguous' | 'unusable' | 'unsafe';

export type BookEntry = { number: string; name: string | null; expiresOn: string | null; lastCheckedAt: string | null; verdict: Verdict; deactivated: boolean };

// A selectable project with where it came from; a task selection pins exactly this (code + name + source).
export type BookOption = { number: string; name: string; source: ProjectSource };

// Kernel projectintake.mjs MAX_RETRIES: a failed query is retried this many times before giving up.
const MAX_RETRIES = 3;

const VERDICT_NOTE: Readonly<Record<Exclude<Verdict, 'confirmed'>, string>> = {
  missing: '最近一次核对时报销系统里查不到这个项目号',
  ambiguous: '最近一次核对时这个项目号在报销系统里对上了多条记录',
  unusable: '最近一次核对时这个项目已被报销系统禁用或尚未审核',
  unsafe: '这个项目号含有不能安全查询的字符，请删除后从报销系统重新录入',
};

// Local calendar day, YYYY-MM-DD (kernel localToday).
const localDay = (now: Date) => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

type Reason = 'deactivated' | 'unsafe' | 'expired' | 'unconfirmed';

function invalidReasons(entry: BookEntry, today: string): Reason[] {
  if (entry.deactivated) return ['deactivated'];
  const reasons: Reason[] = [];
  if (!isSafeProjectNumber(entry.number)) reasons.push('unsafe');
  if (entry.expiresOn !== null && entry.expiresOn < today) reasons.push('expired');
  if (entry.verdict !== 'confirmed') reasons.push('unconfirmed');
  return reasons;
}

const REASON_LABEL = { deactivated: '已停用', unsafe: '项目号不安全', expired: '已过期', unconfirmed: '复检未通过' } as const;
const DEACTIVATED_NOTE = '管理员已在公共项目簿停用这个项目，不能再选';

export function annotate(entry: BookEntry, today: string): ProjectBookEntry {
  const reasons = invalidReasons(entry, today);
  const notes = reasons.map((reason) =>
    reason === 'deactivated' ? DEACTIVATED_NOTE : reason === 'expired' ? `已过期（过期时间 ${entry.expiresOn}）` : reason === 'unsafe' ? VERDICT_NOTE.unsafe : entry.verdict === 'confirmed' ? VERDICT_NOTE.unusable : VERDICT_NOTE[entry.verdict],
  );
  return {
    number: entry.number,
    name: entry.name,
    expiresOn: entry.expiresOn,
    lastCheckedAt: entry.lastCheckedAt,
    selectable: reasons.length === 0,
    statusLabel: reasons.length > 0 ? reasons.map((reason) => REASON_LABEL[reason]).join('・') : '可选',
    statusNote: notes.length > 0 ? [...new Set(notes)].join('；') : null,
  };
}

const scoped = (db: Db, ref: BookRef) => {
  const query = db.selectFrom('project_book_event').selectAll().where('scope', '=', ref.scope);
  return ref.scope === 'personal' ? query.where('owner_account_id', '=', ref.ownerAccountId) : query.where('owner_account_id', 'is', null);
};

// The current book: events folded in insertion order. Re-intake of a present number replaces it in place.
export async function readBook(db: Db, ref: BookRef): Promise<BookEntry[]> {
  const events = await scoped(db, ref).orderBy('seq').execute();
  const book = new Map<string, BookEntry>();
  for (const event of events) {
    if (event.action === 'removed') {
      const entry = book.get(event.number);
      if (ref.scope === 'personal') book.delete(event.number);
      else if (entry) book.set(event.number, { ...entry, deactivated: true });
    } else if (event.action === 'admitted') book.set(event.number, { number: event.number, name: event.name, expiresOn: event.expires_on, lastCheckedAt: event.created_at, verdict: 'confirmed', deactivated: false });
    else {
      const entry = book.get(event.number);
      if (entry) book.set(event.number, { ...entry, name: event.verdict === 'confirmed' && event.name ? event.name : entry.name, verdict: (event.verdict ?? 'unusable') as Verdict, lastCheckedAt: event.created_at });
    }
  }
  return [...book.values()];
}

// Selectable projects a task may take new lines into: personal first, then public ones whose number the personal book
// does not already offer (a number is one choice; the account's own entry wins).
export async function bookOptions(db: Db, accountId: string, now: Date): Promise<BookOption[]> {
  const today = localDay(now);
  const selectable = async (ref: BookRef) =>
    (await readBook(db, ref)).filter((entry) => annotate(entry, today).selectable).map((entry): BookOption => ({ number: entry.number, name: entry.name ?? entry.number, source: ref.scope }));
  const personal = await selectable({ scope: 'personal', ownerAccountId: accountId });
  const taken = new Set(personal.map((option) => option.number));
  return [...personal, ...(await selectable({ scope: 'public' })).filter((option) => !taken.has(option.number))];
}

type Append = { number: string; action: 'admitted' | 'checked' | 'removed'; name?: string | null; verdict?: Verdict | null };

export function createBookService(db: Db, ref: BookRef, actorAccountId: string, catalog: ProjectCatalog, now: () => Date = () => new Date()) {
  const at = () => `${now().toISOString().slice(0, 19)}Z`;

  async function view(): Promise<ProjectBook> {
    const today = localDay(now());
    return { projects: (await readBook(db, ref)).map((entry) => annotate(entry, today)) };
  }

  async function append(events: readonly Append[]): Promise<void> {
    if (events.length === 0) return;
    const created = at();
    await db.transaction().execute(async (tx) => {
      const last = await tx.selectFrom('project_book_event').select((eb) => eb.fn.max('seq').as('seq')).executeTakeFirst();
      let seq = Number(last?.seq ?? 0);
      for (const event of events) {
        seq += 1;
        await tx
          .insertInto('project_book_event')
          .values({
            event_id: randomUUID(),
            seq,
            scope: ref.scope,
            owner_account_id: ref.scope === 'personal' ? ref.ownerAccountId : null,
            number: event.number,
            action: event.action,
            name: event.name ?? null,
            verdict: event.verdict ?? null,
            expires_on: null,
            actor_account_id: actorAccountId,
            created_at: created,
          })
          .execute();
      }
    });
  }

  // The shared notes name the personal book; the public book says its own name.
  const say = (note: string) => (ref.scope === 'public' ? note.replaceAll('个人项目簿', '公共项目簿') : note);
  const result = async (status: ProjectBookResult['status'], note: string, verdict: ProjectBookResult['verdict'] = null): Promise<ProjectBookResult> => ({ status, verdict, note: say(note), book: await view() });

  async function lookup(number: string): Promise<CatalogLookup> {
    let answer = await catalog.lookup(number);
    for (let retry = 0; retry < MAX_RETRIES && !answer.ok && answer.reason === 'query_failed'; retry += 1) answer = await catalog.lookup(number);
    return answer;
  }

  return {
    view,

    // 录入: only a catalog-confirmed number enters the book, named by the catalog.
    async intake(raw: string): Promise<ProjectBookResult> {
      const number = raw.trim();
      if (!isSafeProjectNumber(number)) return result('rejected', PROJECT_BOOK_NOTES.unsafe(number), 'unsafe');
      const answer = await lookup(number);
      if (!answer.ok) return answer.reason === 'not_logged_in' ? result('not_logged_in', PROJECT_BOOK_NOTES.intakeNotLoggedIn) : result('query_failed', PROJECT_BOOK_NOTES.intakeQueryFailed(answer.message));
      if (answer.verdict === 'missing') return result('rejected', PROJECT_BOOK_NOTES.missing(number), 'missing');
      if (answer.verdict === 'ambiguous') return result('rejected', PROJECT_BOOK_NOTES.ambiguous(number, answer.count), 'ambiguous');
      if (answer.verdict === 'unusable') return result('rejected', PROJECT_BOOK_NOTES.unusable(number, answer.name || null), 'unusable');
      await append([{ number, action: 'admitted', name: answer.name || null }]);
      return result('admitted', PROJECT_BOOK_NOTES.admitted(number, answer.name || null));
    },

    async remove(raw: string): Promise<ProjectBookResult> {
      const number = raw.trim();
      const entry = (await readBook(db, ref)).find((candidate) => candidate.number === number && !candidate.deactivated);
      if (!entry) return result('not_found', PROJECT_BOOK_NOTES.notFound(number));
      await append([{ number, action: 'removed' }]);
      return result('removed', ref.scope === 'public' ? PUBLIC_PROJECT_BOOK_NOTES.deactivated(number, entry.name) : PROJECT_BOOK_NOTES.removed(number, entry.name));
    },

    // 清理全部失效: removes every entry that is not selectable today.
    async purge(): Promise<ProjectBookResult> {
      const today = localDay(now());
      const dead = (await readBook(db, ref)).filter((entry) => !annotate(entry, today).selectable);
      if (dead.length === 0) return result('none', PROJECT_BOOK_NOTES.purgeNone);
      await append(dead.map((entry) => ({ number: entry.number, action: 'removed' as const })));
      return result('purged', PROJECT_BOOK_NOTES.purged(dead.length));
    },

    // 复检全部: asks the catalog about every entry; any failed lookup changes nothing. Recheck never removes.
    async recheck(): Promise<ProjectBookResult> {
      // Deactivated public entries are history, not asked about.
      const entries = (await readBook(db, ref)).filter((entry) => !entry.deactivated);
      if (entries.length === 0) return result('empty', PROJECT_BOOK_NOTES.recheckEmpty);
      const checked: Append[] = [];
      for (const entry of entries) {
        if (!isSafeProjectNumber(entry.number)) {
          checked.push({ number: entry.number, action: 'checked', verdict: 'unsafe' });
          continue;
        }
        const answer = await lookup(entry.number);
        if (!answer.ok) return answer.reason === 'not_logged_in' ? result('not_logged_in', PROJECT_BOOK_NOTES.recheckNotLoggedIn) : result('query_failed', PROJECT_BOOK_NOTES.recheckQueryFailed(answer.message));
        checked.push({ number: entry.number, action: 'checked', verdict: answer.verdict, name: answer.verdict === 'confirmed' ? answer.name : null });
      }
      await append(checked);
      const book = await view();
      return { status: 'done', verdict: null, note: say(PROJECT_BOOK_NOTES.recheckDone(checked.length, book.projects.filter((p) => !p.selectable).length)), book };
    },

    // 完全重置 (reset) of a personal book: every current entry is removed (append-only, so as removal events).
    async clear(): Promise<void> {
      await append((await readBook(db, ref)).map((entry) => ({ number: entry.number, action: 'removed' as const })));
    },
  };
}

export type BookService = ReturnType<typeof createBookService>;
