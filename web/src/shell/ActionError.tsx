import { STALE_STEP_CODE, type ActionOutcome } from '@baox/contract';

// 动作失败的就地提示：一律放在触发它的按钮旁，不用弹窗、不用 window.alert。
// stepToken 过期不算这里的失败：仓库已换上最新快照，并由任务页顶部显示「任务已在别处推进」。

export function failureMessage(outcome: ActionOutcome): string | null {
  if (outcome.ok || outcome.error.code === STALE_STEP_CODE) return null;
  return outcome.error.message;
}

export function ActionError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <span className="app-action-error" role="alert">
      {message}
    </span>
  );
}
