import { useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { Button, IconButton, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Tag, TextInput } from '@carbon/react';
import { CheckmarkFilled, TrashCan, WarningAltFilled } from '@carbon/icons-react';
import {
  segmentKey,
  validatePendingAnswer,
  PAYMENT_SCREENSHOT_ACCEPT_ATTRIBUTE,
  PAYMENT_SCREENSHOT_ERRORS,
  STAY_TRIO_COPY,
  STAY_TRIO_CONFIRM_NONE,
  PENDING_CHOICE_KEY,
  fieldAnswer,
  isAllocationAnswer,
  type FieldAnswer,
  type Material,
  type PendingAnswer,
  type PaymentScreenshot,
  type PendingItem,
  type PendingScreenshotGroup,
  type TaskSnapshot,
} from '@baox/contract';
import { taskHash } from '../router';
import { DetailList } from '../shell/DetailList';
import { FieldGroup } from '../shell/FieldGroup';
import { FileName } from '../shell/FileName';
import { PageHeader } from '../shell/PageHeader';
import { StatusTag } from '../shell/StatusTag';
import { useAction } from '../shell/useAction';
import { ActionGroup } from '../shell/ActionGroup';
import { LodgingPreview } from './LodgingPreview';
import { DuplicateBlockers } from './DuplicateBlockers';
import { PAGE_COPY } from './page-copy';

// 待确认项页（核对页，铺满）：上面是紧凑的待确认项队列（图标、标题、文件名；已处理的变淡并带「已处理」标签），
// 下面左边是原件栏（宽度跟着缩放后的原件走），右边占剩余宽度：标题与原因、补填表单（选择或逐段分摊），再往下是读出的字段。
// 契约里的处理人（resolver）这一页不显示。
// 所有答复经 answerPendingItem 携带 stepToken 提交；页面只做格式校验，采用与否由服务端决定（逐段分摊是否按分守恒也是）。
// 选择类待确认项的已选项用选中样式（aria-pressed），不用主按钮。读出的字段不显示来源。
// A 住宿 invoice's missing-screenshot item (#213) also takes the screenshots themselves, the group its `screenshotGroup`
// names, up to its cap (#331): several per file dialog, uploaded one by one in order, shown as thumbnails in upload
// order, each removable. The item stays open until the filer presses 「已传齐」. A resolved screenshot item still takes
// additions and removals (#332), from the queue or from the all-done view, until the server locks the group
// (`screenshotGroup.locked`); an upload after 「确认没有支付截图」 supersedes it, and removing the last screenshot opens
// the item again.

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
        <span>{field.value || <span className="app-muted">未填</span>}</span>
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
  // The missing-screenshot item's group (#331); absent for any other item.
  screenshots?: ScreenshotGroupProps | undefined;
  state: SubmitState;
};
// What the item's `screenshotGroup` says (cap, lock), its screenshots in upload order, and the group's actions.
type ScreenshotGroupProps = Pick<PendingScreenshotGroup, 'cap' | 'locked'> & {
  shots: readonly PaymentScreenshot[];
  onAdd: (files: readonly File[]) => Promise<void>;
  onRemove: (screenshotId: string) => Promise<void>;
  onComplete: () => Promise<void>;
};

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
      {resolved ? (
        <Resolved />
      ) : (
        <ActionGroup caption="补填的值同样经过核对。" error={state.error}>
          <Button type="submit" size="md" disabled={state.busy}>
            保存并标记已处理
          </Button>
        </ActionGroup>
      )}
    </form>
  );
}

// One button group: side actions (排除) first as ghost, the other answers as secondary. For a 住宿 invoice missing its
// payment screenshots, 上传支付截图 is secondary too and 「已传齐」 the primary, last; 「确认没有支付截图」 is offered only
// while the group is empty. The chosen answer keeps aria-pressed when revisited. The file input stays hidden behind
// the upload button. Once resolved (unless by 排除), the group still takes uploads and removals while not locked.
function ChoiceForm({ item, fileName, onSubmit, screenshots: group, state }: FormProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const resolved = item.status === 'resolved';
  const chosen = fieldAnswer(item.answer)[PENDING_CHOICE_KEY];
  const manual = item.choices.some((choice) => choice.key === 'manual');
  const excludes = item.choices.some((choice) => choice.key === 'exclude');
  const screenshot = group !== undefined && chosen !== 'exclude';
  const editable = screenshot && !group?.locked;
  const screenshots = group?.shots ?? [];
  const copy = STAY_TRIO_COPY.screenshot;
  const full = screenshots.length >= (group?.cap ?? Infinity);
  const choices = [...item.choices]
    .filter((choice) => !(screenshots.length > 0 && choice.key === STAY_TRIO_CONFIRM_NONE))
    .sort((a, b) => Number(b.key === 'exclude') - Number(a.key === 'exclude'));
  const onChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files ?? [])];
    event.target.value = '';
    if (files.length > 0) void group?.onAdd(files);
  };
  const notes = [
    editable ? copy.uploadNote : null,
    screenshot && group?.locked ? STAY_TRIO_COPY.changeLocked : null,
    excludes ? (manual ? '排除后该材料不进入明细，也不上传报销系统；自行手工处理表示你会在报销系统里另行补录，应用同样不碰它。' : '排除后该材料不进入明细，也不进材料包。') : null,
  ].filter(Boolean);
  return (
    <div className="app-choice-form app-screenshot-row">
      {resolved ? <Resolved /> : null}
      {editable ? <input ref={inputRef} type="file" multiple accept={PAYMENT_SCREENSHOT_ACCEPT_ATTRIBUTE} aria-label={copy.inputLabel(fileName)} onChange={onChange} /> : null}
      {screenshot && screenshots.length > 0 ? (
        <div className="app-screenshot-group">
          <p className="app-screenshot-count">{copy.count(screenshots.length)}</p>
          <ol className="app-screenshot-thumbs" aria-label="已上传的支付截图">
            {screenshots.map((shot, index) => (
              <li key={shot.screenshotId}>
                <img src={shot.url} alt={copy.thumbnail(shot.fileName, index + 1)} />
                {editable ? (
                  <IconButton kind="ghost" size="sm" align="bottom" disabled={state.busy} label={copy.remove(shot.fileName, index + 1)} onClick={() => void group?.onRemove(shot.screenshotId)}>
                    <TrashCan />
                  </IconButton>
                ) : null}
              </li>
            ))}
          </ol>
          {editable && full ? <p className="app-caption">{PAYMENT_SCREENSHOT_ERRORS.cap}</p> : null}
        </div>
      ) : null}
      <ActionGroup caption={notes.length > 0 ? notes.join('') : undefined} error={state.error}>
        {choices.map((choice) => (
          <Button
            key={choice.key}
            size="md"
            kind={choice.key === 'exclude' ? 'ghost' : 'secondary'}
            className={chosen === choice.key ? 'app-toggle is-selected' : 'app-toggle'}
            aria-pressed={chosen === choice.key}
            disabled={resolved || state.busy}
            onClick={() => void onSubmit({ [PENDING_CHOICE_KEY]: choice.key })}
          >
            {choice.label}
          </Button>
        ))}
        {editable ? (
          <Button size="md" kind="secondary" disabled={state.busy || full} onClick={() => inputRef.current?.click()}>
            {copy.upload}
          </Button>
        ) : null}
        {editable && !resolved ? (
          <Button size="md" disabled={state.busy || screenshots.length === 0} onClick={() => void group?.onComplete()}>
            {copy.complete}
          </Button>
        ) : null}
      </ActionGroup>
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
      {resolved ? (
        <Resolved />
      ) : (
        <ActionGroup error={state.error}>
          <Button kind="secondary" size="md" disabled={state.busy} onClick={() => void onSubmit({ giveUp: true })}>
            这张票我认不出
          </Button>
          <Button type="submit" size="md" disabled={state.busy}>
            提交逐段金额
          </Button>
        </ActionGroup>
      )}
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
    <div className="app-choice-form">
      {resolved ? <Resolved /> : null}
      <ActionGroup caption="排除后这张发票和它的行程单都不形成明细，也不进材料包。" error={state.error}>
        {resolved ? null : (
          <Button kind="secondary" size="md" disabled={state.busy} onClick={() => void onExclude()}>
            排除这张发票及其行程单
          </Button>
        )}
      </ActionGroup>
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
  // Several files go up one request each, in order; the first refusal (the cap, a non-image) stops the rest. The item
  // stays selected: uploading does not settle it.
  const attachScreenshots = async (item: PendingItem, files: readonly File[]) => {
    await run(async (adapter) => {
      let outcome = await adapter.addPaymentScreenshot(taskId, item.materialId, files[0]!);
      for (const file of files.slice(1)) {
        if (!outcome.ok) break;
        outcome = await adapter.addPaymentScreenshot(taskId, item.materialId, file);
      }
      return outcome;
    });
  };
  const removeScreenshot = async (screenshotId: string) => {
    await run((adapter) => adapter.removePaymentScreenshot(taskId, screenshotId));
  };
  const completeScreenshots = async (item: PendingItem) => {
    settle(await run((adapter) => adapter.completePaymentScreenshots(taskId, item.materialId)));
  };
  // The item's group as the server gives it (`screenshotGroup`), with the screenshots it names.
  const groupOf = (item: PendingItem): ScreenshotGroupProps | undefined => {
    const group = item.screenshotGroup;
    if (!group) return undefined;
    const shots = group.screenshotIds.flatMap((id) => snapshot.paymentScreenshots.find((shot) => shot.screenshotId === id) ?? []);
    return {
      cap: group.cap,
      locked: group.locked,
      shots,
      onAdd: (files) => attachScreenshots(item, files),
      onRemove: removeScreenshot,
      onComplete: () => completeScreenshots(item),
    };
  };
  // A resolved screenshot item the filer can still change (#332): reachable from the all-done view too.
  const reopenable = (item: PendingItem) => item.screenshotGroup !== null && !item.screenshotGroup.locked && fieldAnswer(item.answer)[PENDING_CHOICE_KEY] !== 'exclude';

  // 选中项的详情：左边原件，右边标题、原因与表单，再往下是读出的字段。
  const detailOf = (item: PendingItem) => {
    const material = materialOf(item);
    return (
      <section className="app-pending-detail" aria-label="待确认项详情">
        <div className="app-review-split">
          <LodgingPreview key={item.itemId} snapshot={snapshot} materialId={item.materialId} />
          <div className="app-detail-side">
            <div className="app-detail-head">
              <h2 className="app-section-title">{item.title}</h2>
              <p className="app-lead app-why">{item.why}</p>
            </div>
            <ItemForm
              key={item.itemId}
              item={item}
              fileName={material?.fileName ?? item.materialId}
              state={state}
              onSubmit={(answer) => submit(item, answer)}
              onExclude={() => exclude(item)}
              screenshots={groupOf(item)}
            />
            <MaterialFields material={material} />
          </div>
        </div>
      </section>
    );
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
    // Only an item the filer opened here is shown in full; the rest stay one table row each.
    const opened = items.find((item) => item.itemId === selectedId && reopenable(item));
    return (
      <>
        <PageHeader title={copy.title} lead={items.length === 0 ? '本次盘点没有形成待确认项。' : `本次盘点的 ${items.length} 个待确认项都已处理。`} />
        <section className="app-block app-pending-done" aria-labelledby="pending-done-title">
          <h2 className="app-section-title" id="pending-done-title">
            没有待确认项了
          </h2>
          {items.length > 0 ? (
            <div className="bleed app-table">
              <Table aria-label="已处理的待确认项">
                <TableHead>
                  <TableRow>
                    <TableHeader>待确认项</TableHeader>
                    <TableHeader>文件</TableHeader>
                    <TableHeader>状态</TableHeader>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {items.map((item) => {
                    const note = gaveUpNote(item);
                    return (
                      <TableRow key={item.itemId}>
                        <TableCell className="app-wrap">
                          {item.title}
                          {note ? <div className="app-caption">{note}</div> : null}
                          {reopenable(item) ? (
                            <div>
                              <Button kind="ghost" size="sm" aria-expanded={opened?.itemId === item.itemId} onClick={() => setSelectedId(opened?.itemId === item.itemId ? null : item.itemId)}>
                                {STAY_TRIO_COPY.screenshot.reopen}
                              </Button>
                            </div>
                          ) : null}
                        </TableCell>
                        <TableCell>
                          <FileName name={materialOf(item)?.fileName ?? item.materialId} />
                        </TableCell>
                        <TableCell className="app-nowrap">
                          <Resolved />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          ) : null}
          <ActionGroup>
            <Button size="md" href={taskHash(taskId, 'project')}>
              进入项目归属
            </Button>
          </ActionGroup>
        </section>
        {opened ? detailOf(opened) : null}
      </>
    );
  }

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
      {selected ? detailOf(selected) : null}
    </>
  );
}
