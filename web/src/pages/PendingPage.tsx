import { useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { Button, Tag, TextInput } from '@carbon/react';
import { CheckmarkFilled, WarningAltFilled } from '@carbon/icons-react';
import {
  segmentKey,
  isStayScreenshotItem,
  validatePendingAnswer,
  PAYMENT_SCREENSHOT_ACCEPT_ATTRIBUTE,
  STAY_TRIO_COPY,
  PENDING_CHOICE_KEY,
  fieldAnswer,
  isAllocationAnswer,
  type FieldAnswer,
  type Material,
  type PendingAnswer,
  type PendingItem,
  type TaskSnapshot,
} from '@baox/contract';
import { taskHash } from '../router';
import { DetailList } from '../shell/DetailList';
import { FieldGroup } from '../shell/FieldGroup';
import { PageHeader } from '../shell/PageHeader';
import { StatusTag } from '../shell/StatusTag';
import { useAction } from '../shell/useAction';
import { LodgingPreview } from './LodgingPreview';
import { DuplicateBlockers } from './DuplicateBlockers';
import { PAGE_COPY } from './page-copy';

// 待确认项页（核对页，铺满）：上面是紧凑的待确认项队列（图标、标题、文件名；已处理的变淡并带「已处理」标签），
// 下面左边是原件栏（宽度跟着缩放后的原件走），右边占剩余宽度：标题与原因、补填表单（选择或逐段分摊），再往下是读出的字段。
// 契约里的处理人（resolver）这一页不显示。
// 所有答复经 answerPendingItem 携带 stepToken 提交；页面只做格式校验，采用与否由服务端决定（逐段分摊是否按分守恒也是）。
// 选择类待确认项的已选项用选中样式（aria-pressed），不用主按钮。读出的字段不显示来源。
// A 住宿 invoice's missing-screenshot item (#213) also takes the screenshot itself: uploading it makes the item go away.

const EVIDENCE_LABELS: Readonly<Record<Material['fields'][number]['evidence'], string>> = {
  explicit: '',
  derived: '推导',
  ambiguous: '存疑',
  missing: '缺失',
};

function Resolved() {
  return <StatusTag tone="success">已处理</StatusTag>;
}

// One detail list: file name and material type first, then the recognised fields (DESIGN.md「版式统一」).
function MaterialFields({ material }: { material: Material | undefined }) {
  if (!material) return null;
  const read = material.fields.map((field) => ({
    label: field.label,
    value: (
      <>
        {field.value || <span className="app-muted">未填</span>}
        {EVIDENCE_LABELS[field.evidence] ? (
          <Tag className="app-evidence-tag" type={field.evidence === 'derived' ? 'gray' : 'red'} size="sm">
            {EVIDENCE_LABELS[field.evidence]}
          </Tag>
        ) : null}
      </>
    ),
  }));
  return (
    <div className="app-material-fields">
      <DetailList
        label="材料"
        fields={[
          { label: '文件名', value: <span className="app-file-name">{material.fileName}</span> },
          { label: '材料类别', value: material.kindLabel },
          ...read,
        ]}
      />
      {material.fields.length === 0 ? <p className="app-caption">没有读出字段。</p> : null}
    </div>
  );
}

type SubmitState = { busy: boolean; error: string | null };
type FormProps = {
  item: PendingItem;
  fileName: string;
  onSubmit: (answer: PendingAnswer) => Promise<void>;
  onExclude: () => Promise<void>;
  onScreenshot: (file: File) => Promise<void>;
  state: SubmitState;
};

function ServerError({ state }: { state: SubmitState }) {
  return state.error ? (
    <span className="app-action-error" role="alert">
      {state.error}
    </span>
  ) : null;
}

// 字段错误：Carbon 输入框的错误文字区里放一个 role="alert"，读屏立即读出。
const fieldError = (error: string | undefined) => (error ? { invalid: true, invalidText: <span role="alert">{error}</span> } : {});

function AnswerForm({ item, onSubmit, state }: FormProps) {
  // 组件按 itemId 作 key 挂载：切换待确认项时表单重建；已处理的项显示它的答复。
  const [values, setValues] = useState<FieldAnswer>(fieldAnswer(item.answer));
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
    <form className="app-form" onSubmit={submit} noValidate aria-label={item.title}>
      {item.fields.map((field) => (
        <TextInput
          key={field.key}
          id={`pf-${item.itemId}-${field.key}`}
          name={field.key}
          labelText={`${field.label}${field.required ? ' *' : ''}`}
          placeholder={field.placeholder}
          value={values[field.key] ?? ''}
          disabled={resolved || state.busy}
          onChange={(event) => setValues({ ...values, [field.key]: event.target.value })}
          {...fieldError(errors[field.key])}
        />
      ))}
      <div className="app-btn-row">
        {resolved ? (
          <Resolved />
        ) : (
          <Button type="submit" disabled={state.busy}>
            保存并标记已处理
          </Button>
        )}
        <span className="app-caption">补填的值同样经过核对。</span>
        <ServerError state={state} />
      </div>
    </form>
  );
}

// The file input stays hidden behind the button (`.app-screenshot-row`), as on the print page.
function ScreenshotUpload({ fileName, onScreenshot, state }: Pick<FormProps, 'fileName' | 'onScreenshot' | 'state'>) {
  const inputRef = useRef<HTMLInputElement>(null);
  const copy = STAY_TRIO_COPY.screenshot;
  const onChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) void onScreenshot(file);
  };
  return (
    <div className="app-btn-row app-screenshot-row">
      <Button disabled={state.busy} onClick={() => inputRef.current?.click()}>
        {copy.upload}
      </Button>
      <input ref={inputRef} type="file" accept={PAYMENT_SCREENSHOT_ACCEPT_ATTRIBUTE} aria-label={copy.inputLabel(fileName)} onChange={onChange} />
      <span className="app-caption">{copy.uploadNote}</span>
    </div>
  );
}

function ChoiceForm({ item, fileName, onSubmit, onScreenshot, state }: FormProps) {
  const resolved = item.status === 'resolved';
  const chosen = fieldAnswer(item.answer)[PENDING_CHOICE_KEY];
  const manual = item.choices.some((choice) => choice.key === 'manual');
  const excludes = item.choices.some((choice) => choice.key === 'exclude');
  return (
    <div>
      {!resolved && isStayScreenshotItem(item) ? <ScreenshotUpload fileName={fileName} onScreenshot={onScreenshot} state={state} /> : null}
      <div className="app-btn-row">
        {item.choices.map((choice) => (
          <Button
            key={choice.key}
            kind="secondary"
            className={chosen === choice.key ? 'app-toggle is-selected' : 'app-toggle'}
            aria-pressed={chosen === choice.key}
            disabled={resolved || state.busy}
            onClick={() => void onSubmit({ [PENDING_CHOICE_KEY]: choice.key })}
          >
            {choice.label}
          </Button>
        ))}
        {resolved ? <Resolved /> : null}
        <ServerError state={state} />
      </div>
      {excludes ? (
        <p className="app-caption app-choice-note">
          {manual ? '排除后该材料不进入明细，也不上传报销系统；自行手工处理表示你会在报销系统里另行补录，应用同样不碰它。' : '排除后该材料不进入明细，也不进材料包。'}
        </p>
      ) : null}
    </div>
  );
}

// 逐段分摊：每段填价税合计（预填行程单上的读数），或选「这张票我认不出」。页面只拦格式；加起来对不对由服务端判定，
// 不守恒时显示服务端给的错误。选「认不出」的后果说明由服务端给出，处理前后都显示。
function AllocationForm({ item, onSubmit, state }: FormProps) {
  const allocation = item.allocation;
  const answered = item.answer && isAllocationAnswer(item.answer) ? item.answer : null;
  const [amounts, setAmounts] = useState<string[]>(
    () => allocation?.segments.map((segment, index) => (answered && 'amounts' in answered ? answered.amounts[index] : undefined) ?? segment.suggested ?? '') ?? [],
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  if (!allocation) return null;
  const resolved = item.status === 'resolved';
  const gaveUp = answered !== null && 'giveUp' in answered;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const answer: PendingAnswer = { amounts };
    const nextErrors = validatePendingAnswer(item, answer);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    void onSubmit(answer);
  };

  return (
    <form className="app-form" onSubmit={submit} noValidate aria-label={item.title}>
      <p className="app-caption">票面价税合计 {allocation.total} 元；各段加起来必须正好等于它，对不对得上由系统核对。</p>
      {/* 每段先用字段组列出日期与路线（不拼中点串），输入框的标签只写「第 N 段价税合计」。 */}
      {allocation.segments.map((segment, index) => (
        <div key={segment.index} className="app-segment">
          <FieldGroup
            fields={[
              { label: '日期', value: segment.date },
              { label: '路线', value: segment.route },
            ]}
          />
          <TextInput
            id={`pa-${item.itemId}-${segment.index}`}
            className="app-amount-input"
            labelText={`第 ${segment.index} 段价税合计`}
            inputMode="decimal"
            value={amounts[index] ?? ''}
            disabled={resolved || state.busy}
            onChange={(event) => setAmounts(amounts.map((value, position) => (position === index ? event.target.value : value)))}
            {...(segment.suggested ? { helperText: `行程单上写的是 ${segment.suggested}` } : {})}
            {...fieldError(errors[segmentKey(segment.index)])}
          />
        </div>
      ))}
      {errors.allocation ? (
        <p className="app-action-error" role="alert">
          {errors.allocation}
        </p>
      ) : null}
      <div className="app-btn-row">
        {resolved ? (
          <Resolved />
        ) : (
          <>
            <Button type="submit" disabled={state.busy}>
              提交逐段金额
            </Button>
            <Button kind="secondary" disabled={state.busy} onClick={() => void onSubmit({ giveUp: true })}>
              这张票我认不出
            </Button>
          </>
        )}
        <ServerError state={state} />
      </div>
      <p className={gaveUp ? 'app-warning-text' : 'app-caption app-choice-note'} data-testid="give-up-note">
        {gaveUp ? '你选了「这张票我认不出」。' : ''}
        {allocation.giveUpNote}
      </p>
    </form>
  );
}

// 「认不出」留下的阻塞项（内核 allocation_given_up）：不能答复，说明（why）由服务端给出。
// 应用内的出路是排除这张发票（exclude-material，服务端连同它的行程单一起排除）；另一条出路是在上传页追加逐段行程单后重新盘点。
function GivenUpForm({ item, onExclude, state }: FormProps) {
  const resolved = item.status === 'resolved';
  return (
    <div>
      <div className="app-btn-row">
        {resolved ? (
          <Resolved />
        ) : (
          <Button kind="secondary" disabled={state.busy} onClick={() => void onExclude()}>
            排除这张发票及其行程单
          </Button>
        )}
        <ServerError state={state} />
      </div>
      <p className="app-caption app-choice-note">排除后这张发票和它的行程单都不形成明细，也不进材料包。</p>
    </div>
  );
}

function ItemForm(props: FormProps) {
  switch (props.item.kind) {
    case 'choice':
      return <ChoiceForm {...props} />;
    case 'allocation':
      return <AllocationForm {...props} />;
    case 'given_up':
      return <GivenUpForm {...props} />;
    case 'form':
      return <AnswerForm {...props} />;
  }
}

const gaveUpNote = (item: PendingItem): string | null =>
  item.allocation && item.answer && isAllocationAnswer(item.answer) && 'giveUp' in item.answer ? item.allocation.giveUpNote : null;

export function PendingPage({ snapshot }: { snapshot: TaskSnapshot }) {
  const taskId = snapshot.task.taskId;
  const copy = PAGE_COPY.pending;
  const items = snapshot.pendingItems;
  // 还剩几个由服务端给出（inventory.summary），页面不自己数。
  const remaining = snapshot.inventory.summary?.openPendingItemCount ?? 0;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { busy, error, run } = useAction(taskId);
  const state: SubmitState = { busy, error };

  // 默认选中第一个未处理项；答复被采用后跳到下一个未处理项（见 settle）。
  const selected = items.find((item) => item.itemId === selectedId) ?? items.find((item) => item.status === 'open') ?? items[0];

  const materialOf = (item: PendingItem | undefined) => (item ? snapshot.materials.find((material) => material.materialId === item.materialId) : undefined);

  // 采用后跳到下一个未处理项（「认不出」之后新出现的阻塞项也在其中）。
  const settle = (outcome: Awaited<ReturnType<typeof run>>) => {
    if (!outcome.ok) return;
    const next = outcome.snapshot.pendingItems.find((candidate) => candidate.status === 'open');
    setSelectedId(next?.itemId ?? null);
  };
  const submit = async (item: PendingItem, answer: PendingAnswer) => {
    settle(await run((adapter) => adapter.answerPendingItem(taskId, item.itemId, answer, snapshot.step.stepToken)));
  };
  const exclude = async (item: PendingItem) => {
    settle(await run((adapter) => adapter.excludeMaterial(taskId, item.materialId, snapshot.step.stepToken)));
  };
  const attachScreenshot = async (item: PendingItem, file: File) => {
    settle(await run((adapter) => adapter.addPaymentScreenshot(taskId, item.materialId, file)));
  };

  // 跨任务重复发票命中：整批停，没有待确认项，也不能进入项目归属。
  if (snapshot.blockers.length > 0) {
    return (
      <>
        <PageHeader title={copy.title} lead="这批材料整批暂停，没有形成待确认项。" />
        <DuplicateBlockers snapshot={snapshot} />
      </>
    );
  }

  if (items.length === 0 || remaining === 0) {
    return (
      <>
        <PageHeader title={copy.title} lead={items.length === 0 ? '本次盘点没有形成待确认项。' : `本次盘点的 ${items.length} 个待确认项都已处理。`} />
        <section className="app-empty">
          <h2>没有待确认项了</h2>
          {items.length > 0 ? (
            <ul className="app-resolved-list">
              {items.map((item) => {
                const note = gaveUpNote(item);
                return (
                  <li key={item.itemId}>
                    <div className="app-resolved-head">
                      <span>{item.title}</span> <Resolved />
                    </div>
                    <FieldGroup fields={[{ label: '文件名', value: <span className="app-file-name">{materialOf(item)?.fileName ?? item.materialId}</span> }]} />
                    {note ? <div className="app-caption">{note}</div> : null}
                  </li>
                );
              })}
            </ul>
          ) : null}
          <Button size="lg" href={taskHash(taskId, 'project')}>
            进入项目归属
          </Button>
        </section>
      </>
    );
  }

  const material = materialOf(selected);
  return (
    <>
      <PageHeader title={copy.title} lead={`${copy.lead}还剩 ${remaining} 个。`} />
      {/* 队列：每项一行（图标、标题、文件名），当前项用选中底色；已处理的整行变淡，带勾和绿色「已处理」标签。 */}
      <section className="app-queue bleed" aria-label="待确认项清单">
        <ul className="app-item-list">
          {items.map((item) => {
            const file = materialOf(item)?.fileName ?? item.materialId;
            const isSelected = selected?.itemId === item.itemId;
            const done = item.status === 'resolved';
            const classes = [isSelected ? 'is-selected' : '', done ? 'is-done' : ''].filter(Boolean).join(' ');
            return (
              <li key={item.itemId} className={classes || undefined}>
                <button type="button" aria-current={isSelected ? 'true' : undefined} onClick={() => setSelectedId(item.itemId)}>
                  {done ? <CheckmarkFilled className="app-queue-mark is-done" aria-hidden="true" /> : <WarningAltFilled className="app-queue-mark" aria-hidden="true" />}
                  <span className="app-queue-title">{item.title}</span>
                  {/* Most titles already quote the file name (「IMG_4871.jpg」缺少字段); repeating it here would name the
                      same file twice in the row's accessible name, so the sub line only fills in what the title omits. */}
                  {item.title.includes(file) ? null : <span className="app-queue-sub">{file}</span>}
                  {done ? (
                    <StatusTag as="span" tone="success" className="app-queue-tag">
                      已处理
                    </StatusTag>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      </section>
      {selected ? (
        <section className="app-pending-detail" aria-label="待确认项详情">
          <div className="app-review-split">
            <LodgingPreview key={selected.itemId} snapshot={snapshot} materialId={selected.materialId} />
            <div className="app-detail-side">
              <div className="app-detail-head">
                <h2 className="app-section-title">{selected.title}</h2>
                <p className="app-lead app-why">{selected.why}</p>
              </div>
              <ItemForm
                key={selected.itemId}
                item={selected}
                fileName={material?.fileName ?? selected.materialId}
                state={state}
                onSubmit={(answer) => submit(selected, answer)}
                onExclude={() => exclude(selected)}
                onScreenshot={(file) => attachScreenshot(selected, file)}
              />
              <MaterialFields material={material} />
            </div>
          </div>
        </section>
      ) : null}
    </>
  );
}
