import { useState, type FormEvent } from 'react';
import { validatePendingAnswer, type PendingAnswer } from '../contract/actions';
import { PENDING_CHOICE_KEY, type Material, type PendingItem, type TaskSnapshot } from '../contract/snapshot';
import { taskHash } from '../router';
import { useAction } from '../shell/useAction';
import { PAGE_COPY } from './page-copy';

// 待确认项页：左侧清单、右侧详情（原件预览 + 材料字段 + 补填表单或选择）。
// 所有答复经 answerPendingItem 携带 stepToken 提交；页面只做格式校验，采用与否由服务端决定。
// 选择类待确认项的已选项用选中样式（aria-pressed），不用主按钮。

function Preview({ material }: { material: Material | undefined }) {
  if (!material || !material.previewUrl) {
    return (
      <div className={`doc-preview placeholder ${material?.shape ?? 'portrait'}`} data-testid="preview">
        <span className="caption">没有可用的预览</span>
      </div>
    );
  }
  if (material.mediaType === 'image') {
    return (
      <div className={`doc-preview ${material.shape}`}>
        <img src={material.previewUrl} alt={`${material.fileName} 原件`} data-testid="preview" />
      </div>
    );
  }
  return (
    <div className={`doc-preview ${material.shape}`}>
      <iframe src={material.previewUrl} title={`${material.fileName} 原件`} data-testid="preview" />
    </div>
  );
}

function MaterialFields({ material }: { material: Material | undefined }) {
  if (!material) return null;
  return (
    <>
      <div className="caption preview-name">
        <span className="mono">{material.fileName}</span> · {material.kindLabel}
      </div>
      {material.fields.length > 0 ? (
        <dl className="kv">
          {material.fields.map((candidate) => (
            <div key={candidate.key} className="kv-row">
              <dt>{candidate.label}</dt>
              <dd>
                <span className="mono">{candidate.value || <span className="muted">未填</span>}</span>
                <span className="caption source">{candidate.source}</span>
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="caption">没有读出字段。</p>
      )}
    </>
  );
}

type SubmitState = { busy: boolean; error: string | null };

function AnswerForm({ item, onSubmit, state }: { item: PendingItem; onSubmit: (answer: PendingAnswer) => Promise<void>; state: SubmitState }) {
  // 组件按 itemId 作 key 挂载：切换待确认项时表单重建；已处理的项显示它的答复。
  const [values, setValues] = useState<PendingAnswer>(item.answer ?? {});
  const [errors, setErrors] = useState<Record<string, string>>({});

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const nextErrors = validatePendingAnswer(item, values);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    void onSubmit(values);
  };

  const resolved = item.status === 'resolved';
  return (
    <form onSubmit={submit} noValidate aria-label={item.title}>
      {item.fields.map((field) => {
        const id = `pf-${item.itemId}-${field.key}`;
        const error = errors[field.key];
        return (
          <div className="field" key={field.key}>
            <label htmlFor={id}>
              {field.label}
              {field.required ? ' *' : ''}
            </label>
            <input
              className="input"
              id={id}
              name={field.key}
              placeholder={field.placeholder}
              value={values[field.key] ?? ''}
              disabled={resolved || state.busy}
              aria-invalid={error ? 'true' : undefined}
              aria-describedby={error ? `${id}-error` : undefined}
              onChange={(event) => setValues({ ...values, [field.key]: event.target.value })}
            />
            {error ? (
              <div className="error" id={`${id}-error`} role="alert">
                {error}
              </div>
            ) : null}
          </div>
        );
      })}
      <div className="btn-row">
        {resolved ? (
          <span className="badge badge-ok">已处理</span>
        ) : (
          <button className="btn btn-primary" type="submit" disabled={state.busy}>
            保存并标记已处理
          </button>
        )}
        <span className="caption">来源记为 user，同样经过确定性校验。</span>
        {state.error ? (
          <span className="error" role="alert">
            {state.error}
          </span>
        ) : null}
      </div>
    </form>
  );
}

function ChoiceForm({ item, onSubmit, state }: { item: PendingItem; onSubmit: (answer: PendingAnswer) => Promise<void>; state: SubmitState }) {
  const resolved = item.status === 'resolved';
  const chosen = item.answer?.[PENDING_CHOICE_KEY];
  return (
    <div>
      <div className="btn-row">
        {item.choices.map((choice) => (
          <button
            key={choice.key}
            className="btn btn-secondary btn-toggle"
            aria-pressed={chosen === choice.key}
            type="button"
            disabled={resolved || state.busy}
            onClick={() => void onSubmit({ [PENDING_CHOICE_KEY]: choice.key })}
          >
            {choice.label}
          </button>
        ))}
        {resolved ? <span className="badge badge-ok">已处理</span> : null}
        {state.error ? (
          <span className="error" role="alert">
            {state.error}
          </span>
        ) : null}
      </div>
      <p className="caption choice-note">排除后该材料不进入明细，也不上传 ERP；自行手工处理表示你会在 ERP 里另行补录，应用同样不碰它。</p>
    </div>
  );
}

export function PendingPage({ snapshot }: { snapshot: TaskSnapshot }) {
  const taskId = snapshot.task.taskId;
  const copy = PAGE_COPY.pending;
  const items = snapshot.pendingItems;
  // 还剩几个由服务端给出（inventory.summary），页面不自己数。
  const remaining = snapshot.inventory.summary?.openPendingItemCount ?? 0;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { busy, error, run } = useAction(taskId);
  const state: SubmitState = { busy, error };

  // 默认选中第一个未处理项；答复被采用后跳到下一个未处理项（见 submit）。
  const selected = items.find((item) => item.itemId === selectedId) ?? items.find((item) => item.status === 'open') ?? items[0];

  const materialOf = (item: PendingItem | undefined) => (item ? snapshot.materials.find((material) => material.materialId === item.materialId) : undefined);

  const submit = async (item: PendingItem, answer: PendingAnswer) => {
    const outcome = await run((adapter) => adapter.answerPendingItem(taskId, item.itemId, answer, snapshot.step.stepToken));
    if (outcome.ok) {
      const next = outcome.snapshot.pendingItems.find((candidate) => candidate.status === 'open');
      setSelectedId(next?.itemId ?? null);
    }
  };

  if (items.length === 0 || remaining === 0) {
    return (
      <>
        <div className="page-head">
          <div>
            <h1>{copy.title}</h1>
            <p className="lead">{items.length === 0 ? '本次盘点没有形成待确认项。' : `本次盘点的 ${items.length} 个待确认项都已处理。`}</p>
          </div>
        </div>
        <section className="panel">
          <div className="empty">
            <h2>没有待确认项了</h2>
            {items.length > 0 ? (
              <ul className="resolved-list">
                {items.map((item) => (
                  <li key={item.itemId}>
                    {item.title}
                    <span className="mono muted"> · {materialOf(item)?.fileName ?? item.materialId}</span> <span className="badge badge-ok">已处理</span>
                  </li>
                ))}
              </ul>
            ) : null}
            <a className="btn btn-primary btn-lg" href={taskHash(taskId, 'project')}>
              进入项目归属
            </a>
          </div>
        </section>
      </>
    );
  }

  const material = materialOf(selected);
  return (
    <>
      <div className="page-head">
        <div>
          <h1>{copy.title}</h1>
          <p className="lead">
            {copy.lead}还剩 {remaining} 个。
          </p>
        </div>
      </div>
      <div className="split">
        <section className="panel list-panel" aria-label="待确认项清单">
          <ul className="item-list">
            {items.map((item) => {
              const file = materialOf(item)?.fileName ?? item.materialId;
              const isSelected = selected?.itemId === item.itemId;
              return (
                <li key={item.itemId} className={isSelected ? 'selected' : undefined}>
                  <button type="button" aria-current={isSelected ? 'true' : undefined} onClick={() => setSelectedId(item.itemId)}>
                    <div className="title">{item.title}</div>
                    <div className="sub">
                      <span className="mono">{file}</span>
                      {item.status === 'resolved' ? ' · 已处理' : ''}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
        {selected ? (
          <section className="panel" aria-label="待确认项详情">
            <h2>{selected.title}</h2>
            <p className="lead why">{selected.why}</p>
            <div className="detail-grid">
              <div>
                <Preview material={material} />
                <MaterialFields material={material} />
              </div>
              <div>
                {selected.kind === 'choice' ? (
                  <ChoiceForm key={selected.itemId} item={selected} state={state} onSubmit={(answer) => submit(selected, answer)} />
                ) : (
                  <AnswerForm key={selected.itemId} item={selected} state={state} onSubmit={(answer) => submit(selected, answer)} />
                )}
              </div>
            </div>
          </section>
        ) : null}
      </div>
    </>
  );
}
