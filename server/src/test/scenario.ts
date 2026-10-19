import { randomBytes } from 'node:crypto';
import { ProjectBookSchema, type Line, type TaskSnapshot, type TaskStage } from '@baox/contract';
import { createCredentialVault } from '../erp/credential-vault';
import { drafted, scripted, type Script, type ScriptedExecutor } from '../erp/testing/fake-executor';
import { api, sample, type Upload } from './api';
import { BACKSTOP_MS } from './deadlines';
import { createTestServer, type TestClient, type TestServer, type TestServerOptions } from './harness';
import { presetParser, type PresetParser } from './parse-presets';

// The scenario builder: put a reimbursement task (报销任务) at any stage in one call, through public HTTP actions only.
//
//   server = await scenarioServer();                                      // beforeEach; close() in afterEach
//   const scene = await scenario(server).at('actions');                   // hotel invoice + folio, confirmed on P-2307
//   const stuck = await scenario(server).at('reconcile', { erp: readbackMismatch });
//   expect(await scene.refused('set-home-city', { homeCity: '上海' })).toEqual({ status: 400, code: 'task_closed' });
//
// `at` climbs one fixed ladder and stops at the first rung whose snapshot is in the asked stage; a stage the ladder
// passes by (a pending item nobody answered, an ERP script that lands elsewhere) throws, naming where it ended up:
//
//   upload     create the task, upload `materials`
//   inventory  start-inventory, wait until parsed          → pending (open items), inventory (blocked) or project
//              (with `stayTrio: 'answered'`, the 住宿 trio items are answered with 确认没有 first)
//   project    answer every 住宿 trio item with 确认没有    → project
//   review     submit-project-assignment (`projects`)      → review
//   actions    confirm-review                              → actions / choose_action
//   erp        start-erp-write, wait for the job           → done (ERP 草稿已交接 by default), reconcile, actions, …
//
// The `erp` stage itself is never stopped on: it lasts only while a job runs, and the rung waits for the job to end.
//
// Parsing replays preset outcomes (`parse-presets.ts`) unless the server was given a real parser; the fill job is the
// server's scripted executor, and `erp` queues the scripts this scene's task plays (right after the task is created, so
// they also serve a 去报销 the test starts itself from `actions`, and never a later scene's task).

export const SCENARIO_PROJECTS = [
  { number: 'P-2307', name: '华东客户交付' },
  { number: 'P-3312', name: '产品调研' },
] as const;

export type ScenarioServer = TestServer & {
  // The scripted fill executor, or null when the test brought its own `erpExecutor` (or 'paired').
  erp: ScriptedExecutor | null;
  // The preset parser, or null when the test brought its own `parser` (real parsing is opt-in: `inlineExecutor()`).
  presets: PresetParser | null;
  // ERP 凭据 that passed their 试登录, stored for the account as the 设置页 leaves them, without running one: a
  // 去报销 in the paired 本地执行器 (`erpExecutor: 'paired'`) needs them before anything starts (ADR-0037). Needs
  // the server's key, which such a server has unless the test passed `erpCredentialKey: null`.
  authoriseErpCredentials(accountId: string, credentials?: { account: string; password: string }): Promise<void>;
};

// `createTestServer` with the scenario defaults: preset parsing and a scripted
// fill executor that 暂存s the bill (ERP 草稿已交接), as every 去报销 ends (ADR-0037). Any option overrides its default; `erpExecutor: 'paired'` keeps the
// production wiring, where 去报销 runs in the account's paired 本地执行器 (a `fakeLocalExecutor` in tests), and gives the
// server a key for the ERP 凭据 unless the test chose one.
export type ScenarioServerOptions = Omit<TestServerOptions, 'erpExecutor'> & { erpExecutor?: TestServerOptions['erpExecutor'] | 'paired' };

export async function scenarioServer(options: ScenarioServerOptions = {}): Promise<ScenarioServer> {
  const presets = options.parser ? null : presetParser();
  const erp = options.erpExecutor ? null : scripted(drafted);
  const { erpExecutor, ...rest } = options;
  const key = 'erpCredentialKey' in rest ? (rest.erpCredentialKey ?? null) : erpExecutor === 'paired' ? randomBytes(32) : null;
  const server = await createTestServer({
    ...rest,
    erpCredentialKey: key,
    parser: options.parser ?? presets!,
    ...(erpExecutor === 'paired' ? {} : { erpExecutor: erpExecutor ?? erp! }),
  });
  const authoriseErpCredentials = async (accountId: string, { account, password } = { account: 'zhangsan', password: 'erp-Pa55' }) => {
    if (!key) throw new Error('scenario: authorised ERP 凭据 need the server\'s erpCredentialKey');
    const at = server.clock.now().toISOString();
    await server.db.deleteFrom('erp_credential').where('account_id', '=', accountId).execute();
    await server.db.insertInto('erp_credential')
      .values({ account_id: accountId, erp_account: account, password_sealed: createCredentialVault(key).seal(accountId, password), status: 'authorised', message: null, saved_at: at, checked_at: at })
      .execute();
  };
  return { ...server, erp, presets, authoriseErpCredentials };
}

export type ScenarioOptions = {
  // Sample prefixes from @baox/fixtures (`'m07'`) or ready uploads. Default: the 全季 hotel invoice and its folio.
  materials?: ReadonlyArray<string | Upload>;
  // Scripts the fill job plays, one per run (the last repeats). Needs the scenario server's scripted executor.
  erp?: Script | readonly Script[];
  homeCity?: string;
  // The project number each line is assigned to (default P-2307). SCENARIO_PROJECTS and a number given here are
  // entered in the account's project book first; numbers a function returns must be among them.
  projects?: string | ((line: Line) => string);
  purpose?: string;
  // The 住宿 trio items (#213) the inventory raises for a hotel invoice. 'answered': each open one is answered with
  // 确认没有 before the inventory rung is checked, so `at('pending')` stops on the other open items. 'open': left for
  // the test. Default: 'open' for at('inventory' | 'pending'), 'answered' for the later stages (which need them closed).
  stayTrio?: 'answered' | 'open';
  // 'as_is': leave the account's project book as the test left it (no SCENARIO_PROJECTS, no `projects` number), for a
  // test about the book itself. A rung past `project` then needs the assigned numbers already in the book.
  projectBook?: 'scenario' | 'as_is';
};

export type Refusal = { status: number; code: string };

export type Scene = {
  client: TestClient;
  task: TaskSnapshot['task'];
  // The snapshot `at` stopped on.
  reached: TaskSnapshot;
  // The task's current snapshot.
  snapshot: () => Promise<TaskSnapshot>;
  // Posts an action with the current step token (or `stepToken`), as the page would.
  act: (name: string, body?: Record<string, unknown>, stepToken?: string) => Promise<Response>;
  // `act`, expecting 200: the snapshot it returned.
  accept: (name: string, body?: Record<string, unknown>) => Promise<TaskSnapshot>;
  // `act`, expecting a refusal: its status and error code.
  refused: (name: string, body?: Record<string, unknown>) => Promise<Refusal>;
  // Waits until no parser, fill or 对账 job runs for the task, and returns the snapshot.
  settled: () => Promise<TaskSnapshot>;
  // `accept`, then `settled`: for an action that starts a background job (start-erp-write, reconcile, refill).
  run: (name: string, body?: Record<string, unknown>) => Promise<TaskSnapshot>;
};

const LADDER: readonly TaskStage[] = ['upload', 'inventory', 'pending', 'project', 'review', 'actions', 'done', 'reconcile'];
const DEFAULT_MATERIALS = ['m01', 'm02'];

// `client`: the account the task belongs to; a fresh signed-in account by default.
export function scenario(server: ScenarioServer, client?: TestClient) {
  return {
    // A scene for a task that already exists (a restarted server's, say), where it stands now. Needs `client`.
    async of(taskId: string): Promise<Scene> {
      if (!client) throw new Error('scenario: of(taskId) needs the client that owns the task');
      const reached = await api(() => client).current(taskId);
      return { ...sceneOf(client)(reached.task), reached };
    },

    async at(stage: TaskStage, options: ScenarioOptions = {}): Promise<Scene> {
      if (!LADDER.includes(stage)) throw new Error(`scenario: no rung leads to stage ${stage}`);
      const owner = client ?? (await server.signIn());
      const scene = sceneOf(owner);
      const http = api(() => owner);
      const stop = (snapshot: TaskSnapshot, rung: string): Scene | null => {
        if (snapshot.stage === stage) return { ...scene(snapshot.task), reached: snapshot };
        const failed = snapshot.materials.flatMap((material) => (server.presets?.misses().includes(material.fileName) ? [material.fileName] : []));
        if (failed.length > 0) throw new Error(`scenario: no preset parse outcome for ${failed.join(', ')}; pass a real parser to scenarioServer({ parser })`);
        return rung === 'erp' ? missed(snapshot, rung) : null;
      };
      // Before the next rung: a task that is not where that rung starts (a pending item nobody answered, a blocked
      // inventory) was passed by, and says where it is instead of letting the rung's action be refused.
      const startsAt = (snapshot: TaskSnapshot, from: TaskStage, rung: string): void => {
        if (snapshot.stage !== from) missed(snapshot, rung);
      };
      const missed = (snapshot: TaskSnapshot, rung: string): never => {
        const open = snapshot.pendingItems.filter((item) => item.status === 'open').map((item) => item.itemId);
        throw new Error(`scenario: asked for stage ${stage}, but after ${rung} the task is at ${snapshot.stage} / ${snapshot.step.kind}` + (open.length ? ` (open items: ${open.join(', ')})` : '') + (snapshot.blockers.length ? ` (blockers: ${snapshot.blockers.map((b) => b.kind).join(', ')})` : ''));
      };

      if (options.erp && !server.erp) throw new Error('scenario: `erp` scripts need the scripted executor; this server was given its own erpExecutor');

      const assign = options.projects ?? SCENARIO_PROJECTS[0].number;
      const projectOf = typeof assign === 'string' ? () => assign : assign;
      // Before the task exists, as an employee would have: the project page then asks to assign, not to fill the book.
      if (options.projectBook !== 'as_is') await enterProjects(owner, typeof assign === 'string' ? [assign] : []);

      const { task } = await http.createTask(options.homeCity ?? '杭州');
      // Queued for this task only, so a test that stops at `actions` and starts 去报销 itself gets them too, and a later
      // scene on the same server (which never reached 去报销 here or not) plays its own.
      if (options.erp) server.erp!.queueFor(task.taskId, ...(typeof options.erp === 'function' ? [options.erp] : options.erp));
      const uploads = (options.materials ?? DEFAULT_MATERIALS).map((material) => (typeof material === 'string' ? sample(material) : material));
      let current = uploads.length > 0 ? await http.upload(task.taskId, uploads) : await http.current(task.taskId);
      const atUpload = stop(current, 'upload');
      if (atUpload) return atUpload;

      await http.accepted(await http.act(current, 'start-inventory'));
      current = await settle(http.current, task.taskId);
      const answerTrio = (options.stayTrio ?? (stage === 'inventory' || stage === 'pending' ? 'open' : 'answered')) === 'answered';
      if (answerTrio) current = await http.withoutStayGaps(current);
      const atInventory = stop(current, 'inventory');
      if (atInventory) return atInventory;
      if (stage === 'inventory' || stage === 'pending') missed(current, 'inventory');

      if (!answerTrio) current = await http.withoutStayGaps(current);
      const atProject = stop(current, 'answering the 住宿 trio');
      if (atProject) return atProject;

      startsAt(current, 'project', 'answering the 住宿 trio');
      current = await http.accepted(await http.act(current, 'submit-project-assignment', {
        purpose: options.purpose ?? '上海产品评审出差',
        projects: Object.fromEntries(current.lines.map((line) => [line.lineId, projectOf(line)])),
      }));
      const atReview = stop(current, 'submit-project-assignment');
      if (atReview) return atReview;

      startsAt(current, 'review', 'submit-project-assignment');
      current = await http.accepted(await http.act(current, 'confirm-review', { digest: current.confirmation.digest }));
      const atActions = stop(current, 'confirm-review');
      if (atActions) return atActions;
      if (stage === 'project' || stage === 'review') missed(current, 'confirm-review');

      startsAt(current, 'actions', 'confirm-review');
      await http.accepted(await http.act(current, 'start-erp-write'));
      current = await settle(http.current, task.taskId);
      return stop(current, 'erp')!;
    },
  };
}

function sceneOf(client: TestClient) {
  const http = api(() => client);
  return (task: TaskSnapshot['task']): Omit<Scene, 'reached'> => {
    const act = async (name: string, body: Record<string, unknown> = {}, stepToken?: string) =>
      http.act(await http.current(task.taskId), name, body, stepToken);
    return {
      client,
      task,
      snapshot: () => http.current(task.taskId),
      act,
      accept: async (name, body) => http.accepted(await act(name, body)),
      async refused(name, body) {
        const response = await act(name, body);
        if (response.status === 200) throw new Error(`scenario: ${name} was accepted, not refused`);
        const payload = (await response.json()) as { error?: { code?: string } };
        return { status: response.status, code: payload.error?.code ?? '' };
      },
      settled: () => settle(http.current, task.taskId),
      async run(name, body) {
        await http.accepted(await act(name, body));
        return settle(http.current, task.taskId);
      },
    };
  };
}

// No background job is left: the inventory run is parsed, no fill job runs, and no 对账 job is reading (a reconcile
// stage with no step and not handed off is one in flight).
async function settle(current: (taskId: string) => Promise<TaskSnapshot>, taskId: string): Promise<TaskSnapshot> {
  const deadline = Date.now() + BACKSTOP_MS;
  for (;;) {
    const snapshot = await current(taskId);
    const busy = snapshot.inventory.status === 'running' || snapshot.erp.status === 'running' || (snapshot.stage === 'reconcile' && snapshot.step.kind === 'none' && snapshot.reconcile.status !== 'handed_off');
    if (!busy) return snapshot;
    if (Date.now() > deadline) throw new Error(`scenario: still busy after ${BACKSTOP_MS} ms: inventory ${snapshot.inventory.status}, erp ${snapshot.erp.status}, stage ${snapshot.stage} / ${snapshot.step.kind}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// Enters SCENARIO_PROJECTS and any other assigned number the account's personal project book lacks, so a test can
// reassign lines to P-3312 later without entering it itself.
async function enterProjects(client: TestClient, numbers: readonly string[]): Promise<void> {
  const book = ProjectBookSchema.parse(await (await client.request('/api/project-book')).json());
  const known = new Set(book.projects.map((project) => project.number));
  for (const number of new Set([...SCENARIO_PROJECTS.map((project) => project.number), ...numbers])) {
    if (known.has(number)) continue;
    const name = SCENARIO_PROJECTS.find((project) => project.number === number)?.name ?? number;
    const response = await client.post('/api/project-book/intake', { number, name });
    if (response.status !== 200) throw new Error(`scenario: entering project ${number} failed: ${response.status} ${await response.text()}`);
  }
}
