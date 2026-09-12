import { describe, expect, test, vi } from 'vitest';
import { STALE_STEP_CODE, STALE_STEP_NOTICE } from '../contract/actions';
import { ServiceUnavailableError, type AdapterEvent, type AppAdapter } from '../contract/adapter';
import type { TaskSnapshot } from '../contract/snapshot';
import { t1Snapshot } from '../mock/fixtures/tasks';
import { AppStore } from './store';

// 仓库只断言可观察的状态：当前快照、提示、连接状态。适配器是一个只会按顺序给快照的替身。
function fakeAdapter(sequence: TaskSnapshot[]) {
  let index = 0;
  let listener: ((event: AdapterEvent) => void) | null = null;
  const adapter = {
    listTasks: async () => ({ employee: null, homeCity: null, tasks: [] }),
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

describe('AppStore', () => {
  test('任务列表连接类失败：标记 offline（全页横幅）并按退避自动重试，恢复后列表就绪、offline 清除', async () => {
    let calls = 0;
    const adapter = {
      listTasks: async () => {
        calls += 1;
        if (calls < 3) throw new ServiceUnavailableError();
        return { employee: null, homeCity: null, tasks: [] };
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
});
