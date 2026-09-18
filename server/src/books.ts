import { randomUUID } from 'node:crypto';
import type { Transaction } from 'kysely';
import { PROJECT_BOOK_NOTES, type ProjectBook, type ProjectBookEditInput, type ProjectBookEntry, type ProjectBookIntakeInput, type ProjectBookLifecycleInput, type ProjectBookResult } from '@baox/contract';
import { isSafeProjectNumber } from './catalog/project-catalog';
import type { Db } from './db/database';
import type { ProjectBookEventTable, Schema } from './db/schema';

// 项目簿 (project books) fold append-only facts. A manual `admitted` fact carries `admission_source = manual`; it is
// usable locally without pretending that an ERP catalog check happened. Older facts retain their original fold rules.

export type BookRef = { scope: 'personal'; ownerAccountId: string } | { scope: 'public' };
export type ProjectSource = BookRef['scope'];

type LegacyVerdict = 'confirmed' | 'missing' | 'ambiguous' | 'unusable' | 'unsafe';
type MaintenanceAction = NonNullable<ProjectBookEventTable['maintenance_action']>;

export type BookEntry = {
  number: string;
  name: string | null;
  expiresOn: string | null;
  lastCheckedAt: string | null;
  verdict: LegacyVerdict | null;
  admissionSource: 'manual' | 'legacy';
  deactivated: boolean;
};

export type BookOption = { number: string; name: string; source: ProjectSource };

type BookDb = Db | Transaction<Schema>;

const LEGACY_VERDICT_NOTE: Readonly<Record<Exclude<LegacyVerdict, 'confirmed'>, string>> = {
  missing: '最近一次核对时报销系统里查不到这个项目号',
  ambiguous: '最近一次核对时这个项目号在报销系统里对上了多条记录',
  unusable: '最近一次核对时这个项目已被报销系统禁用或尚未审核',
  unsafe: '这个项目号含有不能安全使用的字符',
};

const localDay = (now: Date) => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

type Reason = 'deactivated' | 'unsafe' | 'expired' | 'unconfirmed';

function invalidReasons(entry: BookEntry, today: string): Reason[] {
  const reasons: Reason[] = [];
  if (entry.deactivated) reasons.push('deactivated');
  if (!isSafeProjectNumber(entry.number)) reasons.push('unsafe');
  // A manual admission deliberately carries no ERP verdict or check time. Legacy entries preserve their former
  // selectability rules instead of being silently reinterpreted during migration.
  if (entry.admissionSource === 'legacy') {
    if (entry.expiresOn !== null && entry.expiresOn < today) reasons.push('expired');
    if (entry.verdict !== 'confirmed') reasons.push('unconfirmed');
  }
  return reasons;
}

const REASON_LABEL = { deactivated: '已停用', unsafe: '项目号不安全', expired: '已过期', unconfirmed: '复检未通过' } as const;

export function annotate(entry: BookEntry, today: string): ProjectBookEntry {
  const reasons = invalidReasons(entry, today);
  const notes = reasons.map((reason) => {
    if (reason === 'deactivated') return '这个项目已停用，不能再选';
    if (reason === 'expired') return `已过期（过期时间 ${entry.expiresOn}）`;
    if (reason === 'unsafe') return LEGACY_VERDICT_NOTE.unsafe;
    return entry.verdict && entry.verdict !== 'confirmed' ? LEGACY_VERDICT_NOTE[entry.verdict] : '最近一次核对没有通过';
  });
  return {
    number: entry.number,
    name: entry.name,
    expiresOn: entry.expiresOn,
    lastCheckedAt: entry.lastCheckedAt,
    active: !entry.deactivated,
    selectable: reasons.length === 0,
    statusLabel: reasons.length > 0 ? reasons.map((reason) => REASON_LABEL[reason]).join('・') : '可选',
    statusNote: notes.length > 0 ? [...new Set(notes)].join('；') : null,
  };
}

const PUBLIC_RESERVED_LABEL = '公共项目已保留';

function annotatePersonalEntry(entry: BookEntry, today: string, publicNumbers: ReadonlySet<string>): ProjectBookEntry {
  const annotated = annotate(entry, today);
  if (!publicNumbers.has(entry.number)) return annotated;
  const notes = [annotated.statusNote, PROJECT_BOOK_NOTES.publicReserved(entry.number)].filter((note): note is string => note !== null);
  return {
    ...annotated,
    selectable: false,
    statusLabel: annotated.statusLabel === '可选' ? PUBLIC_RESERVED_LABEL : `${annotated.statusLabel}・${PUBLIC_RESERVED_LABEL}`,
    statusNote: [...new Set(notes)].join('；'),
  };
}

function applyEvent(book: Map<string, BookEntry>, event: ProjectBookEventTable, scope: BookRef['scope']): void {
  if (event.maintenance_action === 'edited') {
    const previousNumber = event.previous_number ?? event.number;
    const entry = book.get(previousNumber);
    if (!entry) return;
    book.delete(previousNumber);
    book.set(event.number, { ...entry, number: event.number, name: event.name ?? entry.name });
    return;
  }
  if (event.maintenance_action === 'deactivated') {
    const entry = book.get(event.number);
    if (entry) book.set(event.number, { ...entry, deactivated: true });
    return;
  }
  if (event.maintenance_action === 'restored') {
    const entry = book.get(event.number);
    if (entry) book.set(event.number, { ...entry, deactivated: false });
    return;
  }
  if (event.action === 'removed') {
    const entry = book.get(event.number);
    if (scope === 'personal') book.delete(event.number);
    else if (entry) book.set(event.number, { ...entry, deactivated: true });
    return;
  }
  if (event.action === 'admitted') {
    const manual = event.admission_source === 'manual';
    book.set(event.number, {
      number: event.number,
      name: event.name,
      expiresOn: event.expires_on,
      lastCheckedAt: manual ? null : event.created_at,
      verdict: manual ? null : 'confirmed',
      admissionSource: manual ? 'manual' : 'legacy',
      deactivated: false,
    });
    return;
  }
  const entry = book.get(event.number);
  if (entry) {
    book.set(event.number, {
      ...entry,
      name: event.verdict === 'confirmed' && event.name ? event.name : entry.name,
      verdict: (event.verdict ?? 'unusable') as LegacyVerdict,
      lastCheckedAt: event.created_at,
    });
  }
}

const scoped = (db: BookDb, ref: BookRef) => {
  const query = db.selectFrom('project_book_event').selectAll().where('scope', '=', ref.scope);
  return ref.scope === 'personal' ? query.where('owner_account_id', '=', ref.ownerAccountId) : query.where('owner_account_id', 'is', null);
};

export async function readBook(db: BookDb, ref: BookRef): Promise<BookEntry[]> {
  const events = await scoped(db, ref).orderBy('seq').execute();
  const book = new Map<string, BookEntry>();
  for (const event of events) applyEvent(book, event, ref.scope);
  return [...book.values()];
}

async function personalBooks(db: BookDb): Promise<Map<string, BookEntry[]>> {
  const events = await db.selectFrom('project_book_event').selectAll().where('scope', '=', 'personal').orderBy('seq').execute();
  const folded = new Map<string, Map<string, BookEntry>>();
  for (const event of events) {
    if (!event.owner_account_id) continue;
    const book = folded.get(event.owner_account_id) ?? new Map<string, BookEntry>();
    folded.set(event.owner_account_id, book);
    applyEvent(book, event, 'personal');
  }
  return new Map([...folded].map(([accountId, book]) => [accountId, [...book.values()]]));
}

// A public entry reserves its number even while inactive. This also makes a legacy public/personal collision choose
// the public source for new assignments without deleting either historical record.
export async function bookOptions(db: BookDb, accountId: string, now: Date): Promise<BookOption[]> {
  const today = localDay(now);
  const publicEntries = await readBook(db, { scope: 'public' });
  const reservedByPublic = new Set(publicEntries.map((entry) => entry.number));
  const personal = (await readBook(db, { scope: 'personal', ownerAccountId: accountId }))
    .filter((entry) => !reservedByPublic.has(entry.number))
    .filter((entry) => annotate(entry, today).selectable)
    .map((entry): BookOption => ({ number: entry.number, name: entry.name ?? entry.number, source: 'personal' }));
  const publicOptions = publicEntries
    .filter((entry) => annotate(entry, today).selectable)
    .map((entry): BookOption => ({ number: entry.number, name: entry.name ?? entry.number, source: 'public' }));
  return [...personal, ...publicOptions];
}

type Append = {
  number: string;
  action: 'admitted' | 'checked' | 'removed';
  name?: string | null;
  admissionSource?: 'manual';
  maintenanceAction?: MaintenanceAction;
  previousNumber?: string | null;
};

const bookMutationTail = new WeakMap<object, Promise<void>>();

// The local app has one server per data directory. This queue gives each book transaction an exclusive turn before its
// collision read, while the SQLite transaction keeps the read and append atomic. It prevents two concurrent requests
// from both observing an available number on the same connection.
async function serializeBookMutation<T>(db: Db, work: (tx: Transaction<Schema>) => Promise<T>): Promise<T> {
  const prior = bookMutationTail.get(db) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  bookMutationTail.set(db, prior.then(() => current));
  await prior;
  try {
    return await db.transaction().execute(work);
  } finally {
    release();
  }
}

async function append(tx: BookDb, ref: BookRef, actorAccountId: string, at: string, events: readonly Append[]): Promise<void> {
  if (events.length === 0) return;
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
        verdict: null,
        expires_on: null,
        admission_source: event.admissionSource ?? null,
        maintenance_action: event.maintenanceAction ?? null,
        previous_number: event.previousNumber ?? null,
        actor_account_id: actorAccountId,
        created_at: at,
      })
      .execute();
  }
}

type IntakeDecision = 'admitted' | 'duplicate' | 'public_reserved' | 'personal_collision';
type EditDecision = 'edited' | 'missing' | 'duplicate' | 'public_reserved' | 'personal_collision';
type LifecycleDecision = 'deactivated' | 'restored' | 'not_found' | 'already_active' | 'already_inactive' | 'public_reserved';

export function createBookService(db: Db, ref: BookRef, actorAccountId: string, now: () => Date = () => new Date()) {
  const at = () => `${now().toISOString().slice(0, 19)}Z`;
  const say = (note: string) => (ref.scope === 'public' ? note.replaceAll('个人项目簿', '公共项目簿') : note);

  async function view(): Promise<ProjectBook> {
    const today = localDay(now());
    const entries = await readBook(db, ref);
    if (ref.scope === 'public') return { projects: entries.map((entry) => annotate(entry, today)) };
    const publicNumbers = new Set((await readBook(db, { scope: 'public' })).map((entry) => entry.number));
    return { projects: entries.map((entry) => annotatePersonalEntry(entry, today, publicNumbers)) };
  }

  const result = async (status: ProjectBookResult['status'], note: string, verdict: ProjectBookResult['verdict'] = null, localizeBookName = true): Promise<ProjectBookResult> => ({
    status,
    verdict,
    note: localizeBookName ? say(note) : note,
    book: await view(),
  });

  return {
    view,

    async intake(input: ProjectBookIntakeInput): Promise<ProjectBookResult> {
      const number = input.number.trim();
      const name = input.name.trim();
      if (number === '') return result('rejected', PROJECT_BOOK_NOTES.numberRequired);
      if (!isSafeProjectNumber(number)) return result('rejected', PROJECT_BOOK_NOTES.unsafe(number), 'unsafe');
      if (name === '') return result('rejected', PROJECT_BOOK_NOTES.nameRequired);

      const decision = await serializeBookMutation(db, async (tx): Promise<IntakeDecision> => {
        const current = await readBook(tx, ref);
        if (current.some((entry) => entry.number === number)) return 'duplicate';

        if (ref.scope === 'personal') {
          const publicEntries = await readBook(tx, { scope: 'public' });
          if (publicEntries.some((entry) => entry.number === number)) return 'public_reserved';
        } else {
          const books = await personalBooks(tx);
          if ([...books.values()].some((entries) => entries.some((entry) => entry.number === number))) return 'personal_collision';
        }

        await append(tx, ref, actorAccountId, at(), [{ number, name, action: 'admitted', admissionSource: 'manual' }]);
        return 'admitted';
      });

      if (decision === 'admitted') return result('admitted', PROJECT_BOOK_NOTES.admitted(number, name));
      if (decision === 'duplicate') return result('rejected', PROJECT_BOOK_NOTES.duplicate(number));
      if (decision === 'public_reserved') return result('rejected', PROJECT_BOOK_NOTES.publicReserved(number));
      // This is deliberately not localized: the collision is in a private personal book, not the public book being
      // created, and the note must not disclose whose book it is.
      return result('rejected', PROJECT_BOOK_NOTES.publicPersonalCollision(number), null, false);
    },

    async edit(input: ProjectBookEditInput): Promise<ProjectBookResult> {
      const originalNumber = input.originalNumber.trim();
      const number = input.number.trim();
      const name = input.name.trim();
      if (number === '') return result('rejected', PROJECT_BOOK_NOTES.numberRequired);
      if (!isSafeProjectNumber(number)) return result('rejected', PROJECT_BOOK_NOTES.editUnsafe(number), 'unsafe');
      if (name === '') return result('rejected', PROJECT_BOOK_NOTES.nameRequired);

      const decision = await serializeBookMutation(db, async (tx): Promise<EditDecision> => {
        const current = await readBook(tx, ref);
        if (!current.some((entry) => entry.number === originalNumber)) return 'missing';
        if (number !== originalNumber && current.some((entry) => entry.number === number)) return 'duplicate';

        // A name-only correction preserves a legacy cross-scope collision. A changed identity must meet the same
        // reservation rules as intake, under the same transaction as the appended fact.
        if (number !== originalNumber && ref.scope === 'personal') {
          const publicEntries = await readBook(tx, { scope: 'public' });
          if (publicEntries.some((entry) => entry.number === number)) return 'public_reserved';
        }
        if (number !== originalNumber && ref.scope === 'public') {
          const books = await personalBooks(tx);
          if ([...books.values()].some((entries) => entries.some((entry) => entry.number === number))) return 'personal_collision';
        }

        await append(tx, ref, actorAccountId, at(), [{ number, name, action: 'checked', maintenanceAction: 'edited', previousNumber: originalNumber }]);
        return 'edited';
      });

      if (decision === 'edited') return result('edited', PROJECT_BOOK_NOTES.edited(originalNumber, number, name));
      if (decision === 'missing') return result('rejected', PROJECT_BOOK_NOTES.editMissing(originalNumber));
      if (decision === 'duplicate') return result('rejected', PROJECT_BOOK_NOTES.editDuplicate(number));
      if (decision === 'public_reserved') return result('rejected', PROJECT_BOOK_NOTES.editPublicReserved(number));
      // As with intake, the collision comes from another private book and must not identify its owner.
      return result('rejected', PROJECT_BOOK_NOTES.editPublicPersonalCollision(number), null, false);
    },

    async deactivate(input: ProjectBookLifecycleInput): Promise<ProjectBookResult> {
      const number = input.number.trim();
      const decision = await serializeBookMutation(db, async (tx): Promise<LifecycleDecision> => {
        const entry = (await readBook(tx, ref)).find((candidate) => candidate.number === number);
        if (!entry) return 'not_found';
        if (entry.deactivated) return 'already_inactive';
        await append(tx, ref, actorAccountId, at(), [{ number, action: 'removed', maintenanceAction: 'deactivated' }]);
        return 'deactivated';
      });

      if (decision === 'deactivated') return result('deactivated', PROJECT_BOOK_NOTES.deactivated(number));
      if (decision === 'not_found') return result('rejected', PROJECT_BOOK_NOTES.notFound(number));
      return result('rejected', PROJECT_BOOK_NOTES.alreadyInactive(number));
    },

    async restore(input: ProjectBookLifecycleInput): Promise<ProjectBookResult> {
      const number = input.number.trim();
      const decision = await serializeBookMutation(db, async (tx): Promise<LifecycleDecision> => {
        const entry = (await readBook(tx, ref)).find((candidate) => candidate.number === number);
        if (!entry) return 'not_found';
        if (!entry.deactivated) return 'already_active';
        if (ref.scope === 'personal') {
          const publicEntries = await readBook(tx, { scope: 'public' });
          if (publicEntries.some((candidate) => candidate.number === number)) return 'public_reserved';
        }
        await append(tx, ref, actorAccountId, at(), [{ number, action: 'admitted', maintenanceAction: 'restored' }]);
        return 'restored';
      });

      if (decision === 'restored') return result('restored', PROJECT_BOOK_NOTES.restored(number));
      if (decision === 'not_found') return result('rejected', PROJECT_BOOK_NOTES.notFound(number));
      if (decision === 'already_active') return result('rejected', PROJECT_BOOK_NOTES.alreadyActive(number));
      if (decision === 'public_reserved') return result('rejected', PROJECT_BOOK_NOTES.publicReserved(number));
      return result('rejected', PROJECT_BOOK_NOTES.alreadyInactive(number));
    },

    // Reset is an account-scoped cleanup of the user’s own data. Facts stay append-only so legacy history and task
    // snapshots remain readable; project lifecycle operations are added by #219 instead of being hidden here.
    async clear(): Promise<void> {
      await serializeBookMutation(db, async (tx) => {
        const entries = await readBook(tx, ref);
        await append(tx, ref, actorAccountId, at(), entries.map((entry) => ({ number: entry.number, action: 'removed' as const })));
      });
    },
  };
}

export type BookService = ReturnType<typeof createBookService>;
