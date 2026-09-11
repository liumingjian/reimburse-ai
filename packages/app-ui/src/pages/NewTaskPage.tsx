import { useState, type FormEvent } from 'react';
import { useAppStore } from '../adapter/context';
import { CreateTaskInputSchema } from '../contract/actions';
import { TASKS_HASH, navigate, taskHash } from '../router';
import { AppShell } from '../shell/AppShell';

type FieldKey = 'name' | 'periodStart' | 'periodEnd';
type FieldErrors = Partial<Record<FieldKey, string>>;

const FIELD_KEYS: readonly FieldKey[] = ['name', 'periodStart', 'periodEnd'];

// 表单校验只用契约里的 CreateTaskInputSchema：名称必填，日期范围起止合法且结束不早于开始。
function validate(input: { name: string; periodStart: string; periodEnd: string }) {
  const parsed = CreateTaskInputSchema.safeParse({
    name: input.name,
    periodStart: input.periodStart || null,
    periodEnd: input.periodEnd || null,
  });
  if (parsed.success) return { data: parsed.data, errors: null };
  const errors: FieldErrors = {};
  for (const issue of parsed.error.issues) {
    const key = issue.path[0];
    if (typeof key === 'string' && FIELD_KEYS.includes(key as FieldKey) && !errors[key as FieldKey]) errors[key as FieldKey] = issue.message;
  }
  return { data: null, errors };
}

export function NewTaskPage() {
  const store = useAppStore();
  const [name, setName] = useState('');
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const result = validate({ name, periodStart, periodEnd });
    if (!result.data) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    setSubmitError(null);
    setSubmitting(true);
    const outcome = await store.adapter.createTask(result.data);
    setSubmitting(false);
    if (!outcome.ok) {
      setSubmitError(outcome.error.message);
      return;
    }
    store.acceptSnapshot(outcome.snapshot);
    navigate(taskHash(outcome.snapshot.task.taskId, 'upload'));
  };

  const describedBy = (key: FieldKey, hintId?: string) => (errors[key] ? `${key}-error` : hintId);

  return (
    <AppShell nav="tasks">
      <div className="page-head">
        <div>
          <h1>新建报销任务</h1>
          <p className="lead">只需要一个名称。费用期间可以留空，盘点后由材料日期推出。</p>
        </div>
      </div>
      <section className="panel form-panel">
        <form onSubmit={(event) => void onSubmit(event)} noValidate>
          <div className="field">
            <label htmlFor="task-name">任务名称</label>
            <input
              className="input"
              id="task-name"
              name="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="如：2026-09 杭州出差（客户验收）"
              aria-invalid={errors.name ? 'true' : undefined}
              aria-describedby={describedBy('name', 'task-name-hint')}
              required
            />
            {errors.name ? (
              <div className="error" id="name-error" role="alert">
                {errors.name}
              </div>
            ) : (
              <div className="hint" id="task-name-hint">
                建议写年月加事由，方便在列表里辨认。
              </div>
            )}
          </div>
          <div className="form-grid">
            <div className="field">
              <label htmlFor="task-from">开始日期</label>
              <input
                className="input"
                id="task-from"
                name="periodStart"
                type="date"
                value={periodStart}
                onChange={(event) => setPeriodStart(event.target.value)}
                aria-invalid={errors.periodStart ? 'true' : undefined}
                aria-describedby={describedBy('periodStart')}
              />
              {errors.periodStart ? (
                <div className="error" id="periodStart-error" role="alert">
                  {errors.periodStart}
                </div>
              ) : null}
            </div>
            <div className="field">
              <label htmlFor="task-to">结束日期</label>
              <input
                className="input"
                id="task-to"
                name="periodEnd"
                type="date"
                value={periodEnd}
                onChange={(event) => setPeriodEnd(event.target.value)}
                aria-invalid={errors.periodEnd ? 'true' : undefined}
                aria-describedby={describedBy('periodEnd')}
              />
              {errors.periodEnd ? (
                <div className="error" id="periodEnd-error" role="alert">
                  {errors.periodEnd}
                </div>
              ) : null}
            </div>
          </div>
          <div className="btn-row">
            <button className="btn btn-primary" type="submit" disabled={submitting}>
              创建并上传材料
            </button>
            <a className="btn btn-tertiary" href={TASKS_HASH}>
              取消
            </a>
            {submitError ? (
              <span className="error" role="alert">
                {submitError}
              </span>
            ) : null}
          </div>
        </form>
      </section>
    </AppShell>
  );
}
