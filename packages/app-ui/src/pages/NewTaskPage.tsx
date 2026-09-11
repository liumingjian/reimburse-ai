import { useState, type FormEvent } from 'react';
import { useAppStore } from '../adapter/context';
import { CreateTaskInputSchema } from '../contract/actions';
import { TASKS_HASH, navigate, taskHash } from '../router';
import { AppShell } from '../shell/AppShell';

export function NewTaskPage() {
  const store = useAppStore();
  const [name, setName] = useState('');
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsed = CreateTaskInputSchema.safeParse({ name, periodStart: periodStart || null, periodEnd: periodEnd || null });
    if (!parsed.success) {
      setError('任务名称必填。');
      return;
    }
    setSubmitting(true);
    setError(null);
    const outcome = await store.adapter.createTask(parsed.data);
    setSubmitting(false);
    if (!outcome.ok) {
      setError(outcome.error.message);
      return;
    }
    store.acceptSnapshot(outcome.snapshot);
    navigate(taskHash(outcome.snapshot.task.taskId, 'upload'));
  };

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
              aria-invalid={error ? 'true' : undefined}
              required
            />
            {error ? (
              <div className="error" role="alert">
                {error}
              </div>
            ) : (
              <div className="hint">建议写年月加事由，方便在列表里辨认。</div>
            )}
          </div>
          <div className="form-grid">
            <div className="field">
              <label htmlFor="task-from">开始日期</label>
              <input className="input" id="task-from" type="date" value={periodStart} onChange={(event) => setPeriodStart(event.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="task-to">结束日期</label>
              <input className="input" id="task-to" type="date" value={periodEnd} onChange={(event) => setPeriodEnd(event.target.value)} />
            </div>
          </div>
          <div className="btn-row">
            <button className="btn btn-primary" type="submit" disabled={submitting}>
              创建并上传材料
            </button>
            <a className="btn btn-tertiary" href={TASKS_HASH}>
              取消
            </a>
          </div>
        </form>
      </section>
    </AppShell>
  );
}
