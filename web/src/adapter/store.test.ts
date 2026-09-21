import { describe, expect, test, vi } from 'vitest';
import { ADMIN_ERRORS, AUTH_ERRORS, PASSWORD_CHANGE_REQUIRED_CODE, STALE_STEP_CODE, STALE_STEP_NOTICE, ServiceUnavailableError, UNAUTHENTICATED_CODE, UnauthenticatedError, type ActionOutcome, type AdapterEvent, type AppAdapter, type ProjectBook, type TaskSnapshot } from '@baox/contract';
import { createMockAdapter } from '../mock/mock-adapter';
import { t1Snapshot } from '../mock/fixtures/tasks';
import { AppStore } from './store';

// 仓库只断言可观察的状态：当前快照、提示、连接状态。适配器是一个只会按顺序给快照的替身。
function fakeAdapter(sequence: TaskSnapshot[]) {
  let index = 0;
  let listener: ((event: AdapterEvent) => void) | null = null;
  const adapter = {
    listTasks: async () => ({ homeCity: null, tasks: [] }),
    getSnapshot: async () => {
      const snapshot = sequence[Math.min(index, sequence.length - 1)];
      index += 1;
      if (!snapshot) throw new Error('没有快照');
      return structuredClone(snapshot);
    },
    subscribe: (_taskId: string, onEvent: (event: AdapterEvent) => void) => {
      listener = onEvent;
      return () => {
        listener = null;
      };
    },
  } as unknown as AppAdapter;
  return { adapter, emit: (event: AdapterEvent) => listener?.(event) };
}

async function opened(sequence: TaskSnapshot[]) {
  const fake = fakeAdapter(sequence);
  const store = new AppStore(fake.adapter, { validate: true });
  store.openTask('T1');
  await vi.waitFor(() => expect(store.entry('T1').snapshot?.stage).toBe(sequence[0]?.stage));
  return { store, ...fake };
}

function projectSnapshot(revision: number, projectNumber: string): TaskSnapshot {
  const snapshot = t1Snapshot('project');
  return {
    ...snapshot,
    revision,
    projectAssignment: {
      ...snapshot.projectAssignment,
      projects: [{ number: projectNumber, name: `${projectNumber} 项目`, source: 'public' }],
    },
  };
}

function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
  let reject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('AppStore：作废、重置与启动类动作', () => {
  const emptyList = { homeCity: null, tasks: [] };

  test('作废成功后丢掉这个任务缓存的快照；完全重置成功后清掉所有任务快照，项目簿回到未加载', async () => {
    const { store, adapter } = await opened([t1Snapshot('review')]);
    const fake = adapter as unknown as Record<string, unknown>;
    fake.abandonTask = async () => ({ ok: true, taskList: emptyList });
    fake.resetAll = async () => ({ ok: true, taskList: emptyList });
    expect(store.entry('T1').snapshot?.stage).toBe('review');
    expect((await store.abandonTask('T1')).ok).toBe(true);
    expect(store.entry('T1').snapshot).toBeNull();

    await store.refreshTask('T1');
    expect(store.entry('T1').snapshot?.stage).toBe('review');
    expect((await store.resetAll()).ok).toBe(true);
    expect(store.getState().tasks).toEqual({});
    expect(store.getState().projectBook.status).toBe('idle');
    expect(store.getState().taskList.data?.tasks).toEqual([]);
  });

  test('ignores a pending personal book read after reset', async () => {
    const adapter = createMockAdapter({ seed: null, fault: null });
    const store = new AppStore(adapter, { validate: true });
    const stale = await adapter.getProjectBook();
    const pending = deferred<ProjectBook>();
    adapter.getProjectBook = async () => pending.promise;

    const read = store.loadProjectBook();
    expect(store.getState().projectBook.status).toBe('loading');
    expect((await store.resetAll()).ok).toBe(true);
    pending.resolve(stale);
    await read;

    expect(store.getState().projectBook).toEqual({ status: 'idle', data: null, error: null });
  });

  test('作废失败时快照留着', async () => {
    const { store, adapter } = await opened([t1Snapshot('review')]);
    (adapter as unknown as Record<string, unknown>).abandonTask = async () => ({ ok: false, error: { code: 'not_abandonable', message: '不能作废' }, taskList: emptyList });
    expect((await store.abandonTask('T1')).ok).toBe(false);
    expect(store.entry('T1').snapshot?.stage).toBe('review');
  });

  test('返回任务列表的动作带回的列表形状不对：按失败返回而不是抛出（调用方的「处理中」能复位）', async () => {
    const store = new AppStore(fakeAdapter([t1Snapshot('review')]).adapter, { validate: true });
    const outcome = await store.taskListAction(async () => ({ ok: true, taskList: { tasks: 'bad' } as never }));
    expect(outcome).toMatchObject({ ok: false, error: { code: 'adapter_error' } });
  });
});

describe('AppStore：应用账号会话', () => {
  test('读任务列表遇到 401：重读会话，页面随之回到登录', async () => {
    let signedIn = true;
    const adapter = {
      getSession: async () => (signedIn ? { status: 'signed_in', account: { accountId: 'a1', username: '张三', role: 'user' } } : { status: 'signed_out', account: null }),
      listTasks: async () => {
        throw new UnauthenticatedError();
      },
    } as unknown as AppAdapter;
    const store = new AppStore(adapter, { validate: true });
    await store.loadSession();
    expect(store.getState().session.data?.status).toBe('signed_in');
    signedIn = false;
    await store.loadTaskList();
    await vi.waitFor(() => expect(store.getState().session.data?.status).toBe('signed_out'));
  });

  // 读路径靠 UnauthenticatedError，动作路径只拿得到服务端的错误码：两条路都得回到登录，
  // 否则会话早就没了，页面还把它当成一次普通的页内错误显示。
  test('动作遇到 401 与 403 password_change_required：同样重读会话，门随之回到登录', async () => {
    for (const error of [
      { code: UNAUTHENTICATED_CODE, message: AUTH_ERRORS.unauthenticated },
      { code: PASSWORD_CHANGE_REQUIRED_CODE, message: ADMIN_ERRORS.passwordChangeRequired },
    ]) {
      let signedIn = true;
      const adapter = {
        getSession: async () => (signedIn ? { status: 'signed_in', account: { accountId: 'a1', username: '张三', role: 'user' } } : { status: 'signed_out', account: null }),
      } as unknown as AppAdapter;
      const store = new AppStore(adapter, { validate: true });
      await store.loadSession();
      expect(store.getState().session.data?.status).toBe('signed_in');

      signedIn = false;
      await store.act('T1', async () => ({ ok: false, error, snapshot: null }));
      await vi.waitFor(() => expect(store.getState().session.data?.status).toBe('signed_out'));
    }
  });

  test('返回任务列表的动作遇到 401 也重读会话', async () => {
    let signedIn = true;
    const adapter = {
      getSession: async () => (signedIn ? { status: 'signed_in', account: { accountId: 'a1', username: '张三', role: 'user' } } : { status: 'signed_out', account: null }),
      resetAll: async () => ({ ok: false, error: { code: UNAUTHENTICATED_CODE, message: AUTH_ERRORS.unauthenticated }, taskList: null }),
    } as unknown as AppAdapter;
    const store = new AppStore(adapter, { validate: true });
    await store.loadSession();
    signedIn = false;
    expect((await store.resetAll()).ok).toBe(false);
    await vi.waitFor(() => expect(store.getState().session.data?.status).toBe('signed_out'));
  });

  test('换了账号就丢掉上一个账号缓存的任务列表与快照', async () => {
    const { store, adapter } = await opened([t1Snapshot('review')]);
    const fake = adapter as unknown as Record<string, unknown>;
    fake.getSession = async () => ({ status: 'signed_in', account: { accountId: 'a1', username: '张三', role: 'user' } });
    await store.loadSession();
    await store.loadTaskList();
    await store.refreshTask('T1');
    expect(store.entry('T1').snapshot).not.toBeNull();
    fake.logout = async () => ({ ok: true, session: { status: 'signed_out', account: null } });
    expect((await store.auth((a) => a.logout())).ok).toBe(true);
    expect(store.getState().tasks).toEqual({});
    expect(store.getState().taskList.status).toBe('idle');
  });

  test('ignores a pending personal book read after logout', async () => {
    const adapter = createMockAdapter({ seed: null, fault: null });
    const store = new AppStore(adapter, { validate: true });
    await store.loadSession();
    const stale = await adapter.getProjectBook();
    const pending = deferred<ProjectBook>();
    adapter.getProjectBook = async () => pending.promise;

    const read = store.loadProjectBook();
    expect((await store.auth((current) => current.logout())).ok).toBe(true);
    pending.resolve(stale);
    await read;

    expect(store.getState().projectBook).toEqual({ status: 'idle', data: null, error: null });
  });
});

describe('AppStore', () => {
  test('clears a converted personal entry when its required refresh fails', async () => {
    const adapter = createMockAdapter({ seed: null, fault: null });
    const store = new AppStore(adapter, { validate: true });
    await store.loadProjectBook();
    expect(store.getState().projectBook.data?.projects.some((project) => project.number === 'P-2307')).toBe(true);

    expect(await store.projectBookAction((current) => current.intakePublicProject({ number: 'P-2307', name: '公共项目' }), 'public')).toMatchObject({ ok: true, result: { status: 'conversion_required' } });
    adapter.getProjectBook = async () => {
      throw new Error('personal book unavailable');
    };
    expect(await store.projectBookAction((current) => current.confirmPublicProjectConversion({ operation: 'intake', number: 'P-2307', name: '公共项目' }), 'public')).toMatchObject({ ok: true, result: { status: 'converted' } });

    expect(store.getState().projectBook).toEqual({ status: 'error', data: null, error: 'personal book unavailable' });
  });

  test('keeps a personal action result over an older personal book read', async () => {
    const adapter = createMockAdapter({ seed: null, fault: null, bookEmpty: true });
    const store = new AppStore(adapter, { validate: true });
    const stale = await adapter.getProjectBook();
    const pending = deferred<ProjectBook>();
    adapter.getProjectBook = async () => pending.promise;

    const read = store.loadProjectBook();
    expect(await store.projectBookAction((current) => current.intakeProject({ number: 'P-NEW', name: '新项目' }))).toMatchObject({ ok: true, result: { status: 'admitted' } });
    expect(store.getState().projectBook.data?.projects.some((project) => project.number === 'P-NEW')).toBe(true);

    pending.resolve(stale);
    await read;

    expect(store.getState().projectBook.data?.projects.some((project) => project.number === 'P-NEW')).toBe(true);
  });

  test('keeps the converted personal book after an older pre-conversion read succeeds', async () => {
    const adapter = createMockAdapter({ seed: null, fault: null, bookEmpty: true });
    const store = new AppStore(adapter, { validate: true });
    expect(await store.projectBookAction((current) => current.intakeProject({ number: 'OWN-1', name: '个人项目' }))).toMatchObject({ ok: true, result: { status: 'admitted' } });
    const readCurrentBook = adapter.getProjectBook;
    const stale = await readCurrentBook();
    const pending = deferred<ProjectBook>();
    let reads = 0;
    adapter.getProjectBook = async () => {
      reads += 1;
      return reads === 1 ? pending.promise : readCurrentBook();
    };

    const preConversionRead = store.loadProjectBook();
    expect(await store.projectBookAction((current) => current.intakePublicProject({ number: 'OWN-1', name: '公共项目' }), 'public')).toMatchObject({ ok: true, result: { status: 'conversion_required' } });
    expect(await store.projectBookAction((current) => current.confirmPublicProjectConversion({ operation: 'intake', number: 'OWN-1', name: '公共项目' }), 'public')).toMatchObject({ ok: true, result: { status: 'converted' } });
    expect(store.getState().projectBook.data?.projects.some((project) => project.number === 'OWN-1')).toBe(false);

    pending.resolve(stale);
    await preConversionRead;

    expect(store.getState().projectBook).toMatchObject({ status: 'ready', error: null });
    expect(store.getState().projectBook.data?.projects.some((project) => project.number === 'OWN-1')).toBe(false);
  });

  test('keeps the converted personal book after an older pre-conversion read fails', async () => {
    const adapter = createMockAdapter({ seed: null, fault: null, bookEmpty: true });
    const store = new AppStore(adapter, { validate: true });
    expect(await store.projectBookAction((current) => current.intakeProject({ number: 'OWN-1', name: '个人项目' }))).toMatchObject({ ok: true, result: { status: 'admitted' } });
    const readCurrentBook = adapter.getProjectBook;
    const pending = deferred<ProjectBook>();
    let reads = 0;
    adapter.getProjectBook = async () => {
      reads += 1;
      return reads === 1 ? pending.promise : readCurrentBook();
    };

    const preConversionRead = store.loadProjectBook();
    expect(await store.projectBookAction((current) => current.intakePublicProject({ number: 'OWN-1', name: '公共项目' }), 'public')).toMatchObject({ ok: true, result: { status: 'conversion_required' } });
    expect(await store.projectBookAction((current) => current.confirmPublicProjectConversion({ operation: 'intake', number: 'OWN-1', name: '公共项目' }), 'public')).toMatchObject({ ok: true, result: { status: 'converted' } });

    pending.reject(new Error('old personal read failed'));
    await preConversionRead;

    expect(store.getState().projectBook).toMatchObject({ status: 'ready', error: null });
    expect(store.getState().projectBook.data?.projects.some((project) => project.number === 'OWN-1')).toBe(false);
  });

  test('任务列表连接类失败：标记 offline（全页横幅）并按退避自动重试，恢复后列表就绪、offline 清除', async () => {
    let calls = 0;
    const adapter = {
      listTasks: async () => {
        calls += 1;
        if (calls < 3) throw new ServiceUnavailableError('offline');
        return { homeCity: null, tasks: [] };
      },
    } as unknown as AppAdapter;
    const store = new AppStore(adapter, { validate: true, listRetryDelay: () => 5 });
    await store.loadTaskList();
    expect(store.getState().taskList.offline).toBe(true);
    expect(store.getState().taskList.error).toBeNull();
    await vi.waitFor(() => expect(store.getState().taskList.status).toBe('ready'));
    expect(store.getState().taskList.offline).toBe(false);
    expect(calls).toBe(3);
  });

  test('任务列表其他失败：显示加载失败，不标记 offline、不自动重试', async () => {
    let calls = 0;
    const adapter = {
      listTasks: async () => {
        calls += 1;
        throw new Error('任务列表的格式与契约不符');
      },
    } as unknown as AppAdapter;
    const store = new AppStore(adapter, { validate: true, listRetryDelay: () => 1 });
    await store.loadTaskList();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(store.getState().taskList).toMatchObject({ status: 'error', offline: false, error: '任务列表的格式与契约不符' });
    expect(calls).toBe(1);
  });

  test('stepToken 过期（409）带最新快照：换上最新快照并留下提示', async () => {
    const { store } = await opened([t1Snapshot('review')]);
    const outcome = await store.act('T1', async () => ({ ok: false, error: { code: STALE_STEP_CODE, message: STALE_STEP_NOTICE }, snapshot: t1Snapshot('actions') }));
    expect(outcome.ok).toBe(false);
    expect(store.entry('T1').snapshot?.stage).toBe('actions');
    expect(store.entry('T1').notice).toBe(STALE_STEP_NOTICE);
  });

  test('409 没带快照：重新拉取最新快照', async () => {
    const { store } = await opened([t1Snapshot('review'), t1Snapshot('actions')]);
    await store.act('T1', async () => ({ ok: false, error: { code: STALE_STEP_CODE, message: STALE_STEP_NOTICE }, snapshot: null }));
    await vi.waitFor(() => expect(store.entry('T1').snapshot?.stage).toBe('actions'));
    expect(store.entry('T1').notice).toBe(STALE_STEP_NOTICE);
  });

  test('普通失败不改快照、不留提示', async () => {
    const { store } = await opened([t1Snapshot('review')]);
    await store.act('T1', async () => ({ ok: false, error: { code: 'digest_mismatch', message: 'x' }, snapshot: null }));
    expect(store.entry('T1').snapshot?.stage).toBe('review');
    expect(store.entry('T1').notice).toBeNull();
  });

  test('适配器抛错时动作按失败返回，原因可以就地显示', async () => {
    const { store } = await opened([t1Snapshot('review')]);
    const outcome = await store.act('T1', async () => {
      throw new Error('连接被拒绝');
    });
    expect(outcome).toMatchObject({ ok: false, error: { message: '连接被拒绝' }, snapshot: null });
  });

  test('事件流断开时连接状态变为 disconnected；恢复后重新拉取快照', async () => {
    const { store, emit } = await opened([t1Snapshot('review'), t1Snapshot('done')]);
    emit({ type: 'connection', state: 'disconnected' });
    expect(store.getState().connection).toBe('disconnected');
    emit({ type: 'connection', state: 'connected' });
    expect(store.getState().connection).toBe('connected');
    await vi.waitFor(() => expect(store.entry('T1').snapshot?.stage).toBe('done'));
  });

  test('keeps a newer subscription snapshot when an older action response arrives later', async () => {
    const initial = projectSnapshot(25, 'P-ORIGINAL');
    const olderResponse = projectSnapshot(26, 'P-PENDING');
    const refreshedBySubscription = projectSnapshot(30, 'P-PUBLIC-REFRESHED');
    let resolveAction: (outcome: ActionOutcome) => void = () => undefined;
    const response = new Promise<ActionOutcome>((resolve) => {
      resolveAction = resolve;
    });
    const { store, emit } = await opened([initial]);

    const action = store.act('T1', async () => response);
    emit({ type: 'snapshot', snapshot: refreshedBySubscription });
    resolveAction({ ok: true, snapshot: olderResponse });
    await action;

    expect(store.entry('T1').snapshot).toMatchObject({
      revision: 30,
      projectAssignment: { projects: [{ number: 'P-PUBLIC-REFRESHED', source: 'public' }] },
    });
  });

  test('accepts a newer HTTP action snapshot after a subscription snapshot', async () => {
    const { store } = await opened([projectSnapshot(30, 'P-PUBLIC-REFRESHED')]);
    await store.act('T1', async () => ({ ok: true, snapshot: projectSnapshot(31, 'P-HTTP-NEWER') }));

    expect(store.entry('T1').snapshot).toMatchObject({
      revision: 31,
      projectAssignment: { projects: [{ number: 'P-HTTP-NEWER', source: 'public' }] },
    });
  });

  test('accepts an unchanged revision to complete a refresh', async () => {
    const current = projectSnapshot(30, 'P-CURRENT');
    let fail = true;
    const adapter = {
      getSnapshot: async () => {
        if (fail) throw new Error('temporary read failure');
        return structuredClone(current);
      },
    } as unknown as AppAdapter;
    const store = new AppStore(adapter, { validate: true });
    store.acceptSnapshot(current);

    await store.refreshTask('T1');
    expect(store.entry('T1')).toMatchObject({ status: 'error', error: 'temporary read failure', snapshot: { revision: 30 } });

    fail = false;
    const refresh = store.refreshTask('T1');
    expect(store.entry('T1')).toMatchObject({ status: 'loading', error: null, snapshot: { revision: 30 } });
    await refresh;

    expect(store.entry('T1')).toMatchObject({ status: 'ready', error: null, snapshot: { revision: 30 } });
  });
});
