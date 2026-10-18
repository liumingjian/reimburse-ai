import { Link } from '@carbon/react';
import { STALE_STEP_CODE, type ActionLink, type ActionOutcome } from '@baox/contract';
import { settingsHash, useRoute } from '../router';

// 动作失败的就地提示：一律放在触发它的按钮旁，不用弹窗、不用 window.alert。
// stepToken 过期不算这里的失败：仓库已换上最新快照，并由任务页顶部显示「任务已在别处推进」。
// 带 `link` 的拒绝（没有配对本地执行器时的去报销，#437）在原因后面给出能处理它的页面。从任务页去的设置页给出
// 回到这一页的入口，回来不会自动开始。

export const ACTION_LINK_LABELS: Readonly<Record<ActionLink, string>> = { settings: '去设置页' };

export type ActionFailureView = { message: string; link: ActionLink | null };

export function failureOf(outcome: ActionOutcome): ActionFailureView | null {
  if (outcome.ok || outcome.error.code === STALE_STEP_CODE) return null;
  return { message: outcome.error.message, link: outcome.error.link ?? null };
}

export function ActionError({ message, link = null }: { message: string | null; link?: ActionLink | null }) {
  const route = useRoute();
  if (!message) return null;
  const returnTo = route.kind === 'task' && route.page ? { taskId: route.taskId, page: route.page } : null;
  return (
    <span className="app-action-error" role="alert">
      {message}
      {link === 'settings' ? (
        <>
          {' '}
          <Link inline href={settingsHash(returnTo)}>
            {ACTION_LINK_LABELS.settings}
          </Link>
        </>
      ) : null}
    </span>
  );
}
