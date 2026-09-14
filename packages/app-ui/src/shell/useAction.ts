import { useCallback, useState } from 'react';
import { useAppStore } from '../adapter/context';
import type { ActionOutcome, AppAdapter } from '../contract/adapter';
import { failureMessage } from './ActionError';

// 动作的忙碌状态与就地失败原因，配合 <ActionError>：run 期间 busy 为真；失败原因（stale_step 除外）按 key 记下，
// 显示在触发它的按钮旁。一页上有多个失败位置时（如打印稿每个放置一处）用 key 区分；同一时刻只保留最近一次失败。

const DEFAULT_KEY = 'default';

export type ActionRunner = {
  busy: boolean;
  // 默认位置的失败原因。
  error: string | null;
  errorAt(key: string): string | null;
  run(action: (adapter: AppAdapter) => Promise<ActionOutcome>, key?: string): Promise<ActionOutcome>;
  clearError(): void;
};

export function useAction(taskId: string): ActionRunner {
  const store = useAppStore();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);

  const run = useCallback(
    async (action: (adapter: AppAdapter) => Promise<ActionOutcome>, key: string = DEFAULT_KEY) => {
      setBusy(true);
      setFailure(null);
      const outcome = await store.act(taskId, action);
      setBusy(false);
      const message = failureMessage(outcome);
      setFailure(message ? { key, message } : null);
      return outcome;
    },
    [store, taskId],
  );

  const clearError = useCallback(() => setFailure(null), []);
  const errorAt = (key: string) => (failure?.key === key ? failure.message : null);

  return { busy, error: errorAt(DEFAULT_KEY), errorAt, run, clearError };
}
