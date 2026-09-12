import { useState, type FormEvent } from 'react';
import { useAppStore } from '../adapter/context';
import { CreateTaskInputSchema } from '../contract/actions';
import type { HomeCityDefault, TaskList } from '../contract/task-list';
import { navigate, taskHash } from '../router';
import { ConfirmDialog } from '../shell/Dialog';

// 新建报销任务弹层（任务列表页上，`#/tasks/new` 深链也打开它）。任务名称与费用期间由服务端生成，这里只确认报销人与常驻城市。
// 常驻城市的默认值来自服务端（记住的城市或网络位置候选），页面只照它预填并说明来源，从不自己定位。
export const NEW_TASK_COPY = {
  title: '新建报销任务',
  lead: '任务名称由系统生成，盘点后按材料的日期与城市自动命名。',
  employee: '报销人',
  homeCity: '常驻城市',
  submit: '创建并上传材料',
  explain: '常驻城市用来区分本地市内交通与外地市内交通，只用于这次新建的任务；已有任务保留各自创建时的城市。',
  loading: '正在读取报销人与常驻城市…',
  placeholder: '如：杭州',
} as const;

export const HOME_CITY_CAPTIONS: Readonly<Record<HomeCityDefault['source'] | 'none', string>> = {
  network: '根据网络位置推测，不对可直接改成你的常驻城市。',
  remembered: '上次确认的常驻城市，可直接修改。',
  none: '没有获取到网络位置，请填写你的常驻城市。',
};

// 列表还没读到时弹层先显示读取中（按钮不可用）；读到后按服务端默认值预填，员工一改就以输入为准。整个过程是同一个弹层，不重新挂载。
export function NewTaskDialog({ taskList, onClose }: { taskList: TaskList | null; onClose: () => void }) {
  const store = useAppStore();
  const candidate = taskList?.homeCity ?? null;
  const [edited, setEdited] = useState<string | null>(null);
  const homeCity = edited ?? candidate?.value ?? '';
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!taskList || busy) return;
    const parsed = CreateTaskInputSchema.safeParse({ homeCity });
    if (!parsed.success) {
      setFieldError(parsed.error.issues[0]?.message ?? null);
      return;
    }
    setFieldError(null);
    setSubmitError(null);
    setBusy(true);
    const outcome = await store.adapter.createTask(parsed.data);
    setBusy(false);
    if (!outcome.ok) {
      setSubmitError(outcome.error.message);
      return;
    }
    store.acceptSnapshot(outcome.snapshot);
    navigate(taskHash(outcome.snapshot.task.taskId, 'upload'));
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void submit();
  };

  const caption = HOME_CITY_CAPTIONS[candidate?.source ?? 'none'];

  return (
    <ConfirmDialog
      title={NEW_TASK_COPY.title}
      confirmLabel={NEW_TASK_COPY.submit}
      busy={busy || !taskList}
      error={submitError}
      focusCancel={false}
      onConfirm={() => void submit()}
      onCancel={onClose}
    >
      {!taskList ? (
        <p className="caption loading">{NEW_TASK_COPY.loading}</p>
      ) : (
      <form className="new-task-form" onSubmit={onSubmit} noValidate>
        <p className="lead">{NEW_TASK_COPY.lead}</p>
        <div className="field">
          <label htmlFor="new-task-employee">{NEW_TASK_COPY.employee}</label>
          <input className="input" id="new-task-employee" value={taskList.employee ? `${taskList.employee.name} · ${taskList.employee.department}` : '未确认'} readOnly />
        </div>
        <div className="field">
          <label htmlFor="new-task-home-city">{NEW_TASK_COPY.homeCity}</label>
          <input
            className="input"
            id="new-task-home-city"
            name="homeCity"
            value={homeCity}
            placeholder={NEW_TASK_COPY.placeholder}
            autoFocus
            required
            onChange={(event) => setEdited(event.target.value)}
            // 表单里还有只读的报销人输入框，浏览器不做隐式提交；回车在这里直接提交。
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void submit();
              }
            }}
            aria-invalid={fieldError ? 'true' : undefined}
            aria-describedby={fieldError ? 'new-task-home-city-error' : 'new-task-home-city-hint'}
          />
          {fieldError ? (
            <div className="error" id="new-task-home-city-error" role="alert">
              {fieldError}
            </div>
          ) : null}
          <div className="hint" id="new-task-home-city-hint">
            {caption}
          </div>
        </div>
        <p className="caption">{NEW_TASK_COPY.explain}</p>
      </form>
      )}
    </ConfirmDialog>
  );
}
