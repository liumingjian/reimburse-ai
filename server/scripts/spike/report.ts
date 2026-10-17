// The spike's report: one PASS / FAIL / SKIP line per check on stdout, and the same facts as JSON with a screenshot per
// step in one directory. Everything that leaves this process goes through `redact` first: the owner hands this
// directory to a maintainer, and it must carry shapes, counts and timings — never the password, the account, a
// person's name, an amount, an invoice number or a 单据编号. The one deliberate exception is the 单据编号 of the S5
// test draft, which the owner needs in order to delete that draft by hand; it is stored under `draftBillNo` only.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { screenshot, type CdpSession } from '@baox/erp-executor/cdp';

export type Status = 'PASS' | 'FAIL' | 'SKIP';
export type Verdict = { status: Status; reason: string };
export type Observations = Record<string, unknown>;
export type CheckRecord = Verdict & { id: string; title: string; ms: number; observations: Observations; screenshots: string[] };

/** Keys whose string values are written verbatim. Nothing else is. */
const VERBATIM = new Set(['draftBillNo', 'screenshots', 'dir', 'file']);

export class Report {
  readonly dir: string;
  readonly checks: CheckRecord[] = [];
  readonly notes: string[] = [];
  private readonly secrets = new Set<string>();
  private shots = 0;
  private current: CheckRecord | null = null;
  private readonly startedAt = new Date();

  constructor(dir: string) {
    this.dir = resolve(dir);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  /** A value that must never be written anywhere: credentials, and the display name once it is read. */
  secret(value: string | null | undefined) {
    if (value && value.trim().length >= 2) this.secrets.add(value.trim());
  }

  /**
   * Long digit runs (invoice numbers, 单据编号, phone numbers) and money-shaped numbers become placeholders, and every
   * registered secret is cut out. Applied to every string this report prints or writes.
   */
  redact(text: unknown): string {
    let out = String(text ?? '');
    for (const secret of this.secrets) out = out.split(secret).join('＊＊＊');
    return out.replace(/\d{6,}/g, (m) => `<${m.length}位数字>`).replace(/\d[\d,]*\.\d{2}(?!\d)/g, '<金额>');
  }

  private clean(value: unknown, key = ''): unknown {
    if (typeof value === 'string') return VERBATIM.has(key) ? value : this.redact(value);
    if (Array.isArray(value)) return value.map((v) => this.clean(v, key));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, this.clean(v, k)]));
    }
    return value;
  }

  say(line: string) { console.log(`[spike] ${this.redact(line)}`); }

  note(line: string) {
    this.notes.push(this.redact(line));
    this.say(line);
  }

  /** A PNG of what the page shows now, filed under the running check. Never throws: a missing picture is not a result. */
  async shot(session: CdpSession | null | undefined, name: string): Promise<string | null> {
    if (!session) return null;
    const data = await screenshot(session).catch(() => null);
    if (!data) return null;
    this.shots += 1;
    const file = `${String(this.shots).padStart(2, '0')}-${(this.current?.id ?? 'run').toLowerCase()}-${name.replace(/[^\w-]+/g, '_')}.png`;
    writeFileSync(join(this.dir, file), Buffer.from(data, 'base64'), { mode: 0o600 });
    this.current?.screenshots.push(file);
    return file;
  }

  /** Run one check. A throw is a FAIL carrying the error's message; the observations gathered so far are kept. */
  async check(id: string, title: string, body: (obs: Observations) => Promise<Verdict>): Promise<CheckRecord> {
    const record: CheckRecord = { id, title, status: 'FAIL', reason: '', ms: 0, observations: {}, screenshots: [] };
    this.current = record;
    this.checks.push(record);
    this.say(`${id} ${title} …`);
    const started = Date.now();
    try {
      Object.assign(record, await body(record.observations));
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      record.status = 'FAIL';
      record.reason = `${typeof code === 'string' ? `${code}: ` : ''}${error instanceof Error ? error.message : String(error)}`;
    }
    record.ms = Date.now() - started;
    record.reason = this.redact(record.reason);
    this.current = null;
    console.log(`${id} ${record.status.padEnd(4)} ${record.reason} (${(record.ms / 1000).toFixed(1)}s)`);
    this.write();
    return record;
  }

  skip(id: string, title: string, reason: string) {
    return this.check(id, title, async () => ({ status: 'SKIP', reason }));
  }

  /** Rewritten after every check, so a run that dies halfway still leaves what it learnt. */
  write(extra: Observations = {}) {
    const body = this.clean({
      startedAt: this.startedAt.toISOString(), writtenAt: new Date().toISOString(), dir: this.dir,
      checks: this.checks, notes: this.notes, ...extra,
    });
    writeFileSync(join(this.dir, 'report.json'), `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  }
}
