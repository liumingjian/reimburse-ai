import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { Button, InlineNotification } from '@carbon/react';
import type { PlacementSlot } from '../contract/actions';
import { ActionError } from '../shell/ActionError';
import { PageHeader } from '../shell/PageHeader';
import { useAction } from '../shell/useAction';
import {
  PAYMENT_SCREENSHOT_ACCEPT_ATTRIBUTE,
  type Corners,
  type PaymentScreenshot,
  type Placement,
  type PrintPage as PrintSheetPage,
  type TaskSnapshot,
} from '../contract/snapshot';
import { taskHash } from '../router';
import { CropEditor, formatCorners } from './CropEditor';
import { PAGE_COPY } from './page-copy';

// 打印稿预览：逐页显示服务端渲染的页图与页眉（页眉整句来自快照，页面不拼）；页序跟随统一业务序号。
// 还没有打印稿（或旧稿已作废）时，进入页面即请服务端生成。旋转、四角裁剪只是打印设置：结果以服务端返回的新快照为准，
// 不改原件，也不影响整单明细确认。提醒（如住宿发票还没有支付截图）不阻止下载。
// 支付截图只在这里补充：服务端标了 acceptsPaymentScreenshot 的页（住宿发票）有「补充支付截图」入口，只影响打印稿。
// 页卡、页图与四角裁剪编辑器没有对应的 Carbon 组件，保持手写版式，按钮与提示用 Carbon。

function ScreenshotControl({
  page,
  screenshot,
  busy,
  error,
  onAdd,
  onRemove,
}: {
  page: PrintSheetPage;
  screenshot: PaymentScreenshot | null;
  busy: boolean;
  error: string | null;
  onAdd: (file: File) => void;
  onRemove: (screenshot: PaymentScreenshot) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const voucherName = page.top?.fileName ?? page.pageId;
  const onChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) onAdd(file);
  };
  return (
    <li>
      <div className="app-placement-name">
        <span className="app-caption">支付截图</span>
        {screenshot ? <span className="app-file-name">{screenshot.fileName}</span> : <span className="app-muted">未补充</span>}
      </div>
      <div className="app-caption">仅用于打印稿，放在下半页右侧；不上传报销系统，也不影响整单明细确认。</div>
      <div className="app-btn-row app-screenshot-row">
        {screenshot ? (
          <Button kind="ghost" size="sm" disabled={busy} aria-label={`移除支付截图：${voucherName}`} onClick={() => onRemove(screenshot)}>
            移除
          </Button>
        ) : (
          <Button kind="tertiary" size="sm" disabled={busy} aria-label={`补充支付截图：${voucherName}`} onClick={() => inputRef.current?.click()}>
            补充支付截图
          </Button>
        )}
        <input ref={inputRef} type="file" accept={PAYMENT_SCREENSHOT_ACCEPT_ATTRIBUTE} aria-label={`选择支付截图：${voucherName}`} onChange={onChange} />
        <ActionError message={error} />
      </div>
    </li>
  );
}

const SLOT_LABEL: Readonly<Record<PlacementSlot, string>> = { top: '上半页', bottom: '下半页' };
const SLOTS: readonly PlacementSlot[] = ['top', 'bottom'];

type Editing = { pageId: string; slot: PlacementSlot };

export function PrintPage({ snapshot }: { snapshot: TaskSnapshot }) {
  const taskId = snapshot.task.taskId;
  const copy = PAGE_COPY.print;
  const sheet = snapshot.printSheet;
  const confirmed = snapshot.confirmation.status === 'confirmed';
  const generated = sheet.status === 'generated';
  // 失败原因显示在触发它的按钮旁：generate（页头下载按钮旁）、<pageId>-<slot>（该放置的按钮旁）、crop（裁剪编辑器旁）。
  const { busy, run, errorAt } = useAction(taskId);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  const requested = useRef(false);
  const cropPanel = useRef<HTMLElement>(null);

  // 编辑器放在页卡列表之上：打开时滚到它（jsdom 没有 scrollIntoView）。
  useEffect(() => {
    const panel = cropPanel.current;
    if (editing && panel && typeof panel.scrollIntoView === 'function') panel.scrollIntoView({ block: 'start' });
  }, [editing]);

  // 没有可用的打印稿：请服务端生成（服务端幂等；这里只防同一次进入重复请求）。
  useEffect(() => {
    if (!confirmed || generated || requested.current) return;
    requested.current = true;
    void run((adapter) => adapter.generatePrintSheet(taskId), 'generate').then(() => {
      requested.current = false;
    });
  }, [run, taskId, confirmed, generated]);

  if (!confirmed) {
    return (
      <>
        <PageHeader title="还不能进入这一步" lead="打印稿需要先完成整单明细确认。" />
        <Button href={taskHash(taskId, 'review')}>去整单明细确认</Button>
      </>
    );
  }

  const rotate = (page: PrintSheetPage, slot: PlacementSlot, placement: Placement) =>
    run((adapter) => adapter.rotatePlacement(taskId, page.pageId, slot, !placement.rotate), `${page.pageId}-${slot}`);
  const addScreenshot = (page: PrintSheetPage, voucherMaterialId: string, file: File) =>
    run((adapter) => adapter.addPaymentScreenshot(taskId, voucherMaterialId, file), `shot-${page.pageId}`);
  const removeScreenshot = (page: PrintSheetPage, screenshot: PaymentScreenshot) =>
    run((adapter) => adapter.removePaymentScreenshot(taskId, screenshot.screenshotId), `shot-${page.pageId}`);

  const submitCrop = async (target: Editing, corners: Corners) => {
    const outcome = await run((adapter) => adapter.cropPlacement(taskId, target.pageId, target.slot, corners), 'crop');
    if (!outcome.ok) return;
    // 回执显示服务端记下的坐标（回显），而不是本地草稿。
    const echoed = outcome.snapshot.printSheet.pages.find((page) => page.pageId === target.pageId)?.[target.slot]?.corners;
    setReceipt(echoed ? `已提交裁剪：${formatCorners(echoed)}` : '已提交裁剪。');
    setEditing(null);
  };

  const editingPage = editing ? sheet.pages.find((page) => page.pageId === editing.pageId) : undefined;
  const editingPlacement = editing && editingPage ? editingPage[editing.slot] : null;

  return (
    <>
      <PageHeader
        title={copy.title}
        lead={copy.lead}
        actions={
          <>
            {generated && sheet.url ? (
              <Button href={sheet.url} {...({ download: sheet.fileName ?? true } as object)}>
                下载打印稿 PDF
              </Button>
            ) : (
              <Button disabled>下载打印稿 PDF</Button>
            )}
            <ActionError message={errorAt('generate')} />
          </>
        }
      />

      {sheet.status === 'stale' ? (
        <InlineNotification kind="warning" role="status" lowContrast hideCloseButton statusIconDescription="注意" title="材料变更后旧打印稿已作废，正在按新的确认数据重新生成。" />
      ) : null}
      {generated && sheet.notices.length > 0 ? (
        <section className="app-print-notices" role="status" aria-label="打印提醒">
          <InlineNotification kind="warning" role="log" lowContrast hideCloseButton statusIconDescription="注意">
            {sheet.notices.map((notice) => (
              <p key={notice}>{notice}</p>
            ))}
          </InlineNotification>
        </section>
      ) : null}
      {receipt ? (
        <InlineNotification kind="success" role="status" lowContrast hideCloseButton statusIconDescription="成功">
          <span data-testid="crop-receipt">{receipt}</span>
        </InlineNotification>
      ) : null}

      {editing && editingPage && editingPlacement?.corners && editingPlacement.imageUrl ? (
        <section className="app-crop-panel" aria-label="四角裁剪" ref={cropPanel}>
          <div className="app-crop-head">
            <h2 className="app-section-title">{`调整四角 · ${editingPlacement.fileName}`}</h2>
            <span className="app-caption">{editingPage.header}</span>
          </div>
          <CropEditor
            key={`${editing.pageId}-${editing.slot}`}
            imageUrl={editingPlacement.imageUrl}
            alt={`${editingPlacement.fileName} 原图`}
            initial={editingPlacement.corners}
            busy={busy}
            onSubmit={(corners) => void submitCrop(editing, corners)}
            onCancel={() => setEditing(null)}
          />
          <ActionError message={errorAt('crop')} />
        </section>
      ) : null}

      {generated ? (
        <>
          <p className="app-caption app-print-summary">
            {sheet.fileName ? `${sheet.fileName} · ` : ''}
            {`${sheet.pages.length} 页 A4 纵向。旋转与裁剪只保存为打印设置，不改原件，也不影响整单明细确认。`}
          </p>
          <ol className="app-print-pages" aria-label="打印稿页面">
            {sheet.pages.map((page, index) => (
              <li key={page.pageId} className="app-page-card" aria-label={page.header}>
                <div className="page-hdr">{page.header}</div>
                <img className="app-page-image" src={page.imageUrl} alt={`第 ${index + 1} 页页图`} data-testid={`page-image-${page.pageId}`} />
                <ul className="app-placements">
                  {SLOTS.map((slot) => {
                    const placement = page[slot];
                    if (!placement) return null;
                    const rotateLabel = placement.rotate ? '改为竖放' : '旋转 90°';
                    return (
                      <li key={slot}>
                        <div className="app-placement-name">
                          <span className="app-caption">{SLOT_LABEL[slot]}</span>
                          <span className="app-file-name">{placement.fileName}</span>
                        </div>
                        <div className="app-caption">
                          {placement.rotate ? '旋转 90° 放置' : '竖放'}
                          {placement.croppable ? (placement.cropAdjusted ? ' · 已手动微调裁剪' : ' · 已自动裁边矫正') : ''}
                        </div>
                        <div className="app-btn-row">
                          <Button kind="ghost" size="sm" disabled={busy} aria-label={`${rotateLabel}：${placement.fileName}`} onClick={() => void rotate(page, slot, placement)}>
                            {rotateLabel}
                          </Button>
                          {placement.croppable && placement.corners && placement.imageUrl ? (
                            <Button
                              kind="ghost"
                              size="sm"
                              disabled={busy}
                              aria-label={`调整四角：${placement.fileName}`}
                              onClick={() => {
                                setReceipt(null);
                                setEditing({ pageId: page.pageId, slot });
                              }}
                            >
                              调整四角
                            </Button>
                          ) : null}
                          <ActionError message={errorAt(`${page.pageId}-${slot}`)} />
                        </div>
                      </li>
                    );
                  })}
                  {page.acceptsPaymentScreenshot && page.top ? (
                    <ScreenshotControl
                      page={page}
                      screenshot={snapshot.paymentScreenshots.find((shot) => shot.screenshotId === page.screenshotId) ?? null}
                      busy={busy}
                      error={errorAt(`shot-${page.pageId}`)}
                      onAdd={(file) => void addScreenshot(page, page.top?.materialId ?? '', file)}
                      onRemove={(shot) => void removeScreenshot(page, shot)}
                    />
                  ) : null}
                </ul>
              </li>
            ))}
          </ol>
        </>
      ) : (
        <section className="app-block">
          <p className="app-loading" role="status">
            正在生成打印稿…
          </p>
        </section>
      )}
    </>
  );
}
