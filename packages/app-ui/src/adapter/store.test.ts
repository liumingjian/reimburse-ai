import { describe, expect, test, vi } from 'vitest';
import { STALE_STEP_CODE, STALE_STEP_NOTICE } from '../contract/actions';
import type { AdapterEvent, AppAdapter } from '../contract/adapter';
import type { TaskSnapshot } from '../contract/snapshot';
import { t1Snapshot } from '../mock/fixtures/tasks';
import { AppStore } from './store';

// 仓库只断言可观察的状态：当前快照、提示、连接状态。适配器是一个只会按顺序给快照的替身。
function fakeAdapter(sequence: TaskSnapshot[]) {
  let index = 0;
  let listener: ((event: AdapterEvent) => void) | null = null;
  const adapter = {
    listTasks: async () => ({ employee: null, tasks: [] }),
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
