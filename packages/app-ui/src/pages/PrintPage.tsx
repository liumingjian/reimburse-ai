import { useEffect, useRef, useState } from 'react';
import type { PlacementSlot } from '../contract/actions';
import { ActionError } from '../shell/ActionError';
import { useAction } from '../shell/useAction';
import type { Corners, Placement, PrintPage as PrintSheetPage, TaskSnapshot } from '../contract/snapshot';
import { taskHash } from '../router';
import { CropEditor, formatCorners } from './CropEditor';
import { PAGE_COPY } from './page-copy';

// 打印稿预览：逐页显示服务端渲染的页图与页眉（页眉整句来自快照，页面不拼）。
// 还没有打印稿（或旧稿已作废）时，进入页面即请服务端生成。旋转、四角裁剪只是打印设置：结果以服务端返回的新快照为准，
// 不改原件，也不影响整单明细确认。提醒（如住宿发票还没有支付截图）不阻止下载。

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
        <div className="page-head">
          <div>
            <h1>还不能进入这一步</h1>
            <p className="lead">打印稿需要先完成整单明细确认。</p>
          </div>
        </div>
        <a className="btn btn-primary" href={taskHash(taskId, 'review')}>
          去整单明细确认
        </a>
      </>
    );
  }

  const rotate = (page: PrintSheetPage, slot: PlacementSlot, placement: Placement) =>
    run((adapter) => adapter.rotatePlacement(taskId, page.pageId, slot, !placement.rotate), `${page.pageId}-${slot}`);

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
      <div className="page-head">
        <div>
          <h1>{copy.title}</h1>
          <p className="lead">{copy.lead}</p>
        </div>
        <div className="actions">
          <a className="btn btn-tertiary" href={taskHash(taskId, 'review')}>
            返回确认页
          </a>
          {generated && sheet.url ? (
            <a className="btn btn-primary" href={sheet.url} download={sheet.fileName ?? true}>
              下载打印稿 PDF
            </a>
          ) : (
            <button className="btn btn-primary" type="button" disabled>
              下载打印稿 PDF
            </button>
          )}
          <ActionError message={errorAt('generate')} />
        </div>
      </div>

      {sheet.status === 'stale' ? (
        <div className="notice notice-warn" role="status">
          材料变更后旧打印稿已作废，正在按新的确认数据重新生成。
        </div>
      ) : null}
      {generated && sheet.notices.length > 0 ? (
        <div className="notice notice-warn print-notices" role="status" aria-label="打印提醒">
          {sheet.notices.map((notice) => (
            <p key={notice}>{notice}</p>
          ))}
          <div className="btn-row">
            <a className="btn btn-secondary btn-sm" href={taskHash(taskId, 'review')}>
              去确认页补充支付截图
            </a>
          </div>
        </div>
      ) : null}
      {receipt ? (
        <div className="notice notice-ok" role="status" data-testid="crop-receipt">
          {receipt}
        </div>
      ) : null}

      {editing && editingPage && editingPlacement?.corners && editingPlacement.imageUrl ? (
        <section className="panel crop-panel" aria-label="四角裁剪" ref={cropPanel}>
          <div className="crop-head">
            <h2>{`调整四角 · ${editingPlacement.fileName}`}</h2>
            <span className="caption mono">{editingPage.header}</span>
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
          <p className="caption print-summary">
            {sheet.fileName ? `${sheet.fileName} · ` : ''}
            {`${sheet.pages.length} 页 A4 纵向。旋转与裁剪只保存为打印设置，不改原件，也不影响整单明细确认。`}
          </p>
          <ol className="print-pages" aria-label="打印稿页面">
            {sheet.pages.map((page, index) => (
              <li key={page.pageId} className="page-card" aria-label={page.header}>
                <div className="page-hdr mono">{page.header}</div>
                <img className="page-image" src={page.imageUrl} alt={`第 ${index + 1} 页页图`} data-testid={`page-image-${page.pageId}`} />
                <ul className="placements">
                  {SLOTS.map((slot) => {
                    const placement = page[slot];
                    if (!placement) return null;
                    const rotateLabel = placement.rotate ? '改为竖放' : '旋转 90°';
                    return (
                      <li key={slot}>
                        <div className="placement-name">
                          <span className="caption">{SLOT_LABEL[slot]}</span>
                          <span className="mono">{placement.fileName}</span>
                        </div>
                        <div className="caption">
                          {placement.rotate ? '旋转 90° 放置' : '竖放'}
                          {placement.croppable ? (placement.cropAdjusted ? ' · 已手动微调裁剪' : ' · 已自动裁边矫正') : ''}
                        </div>
                        <div className="btn-row">
                          <button
                            className="btn btn-tertiary btn-sm"
                            type="button"
                            disabled={busy}
                            aria-label={`${rotateLabel}：${placement.fileName}`}
                            onClick={() => void rotate(page, slot, placement)}
                          >
                            {rotateLabel}
                          </button>
                          {placement.croppable && placement.corners && placement.imageUrl ? (
                            <button
                              className="btn btn-tertiary btn-sm"
                              type="button"
                              disabled={busy}
                              aria-label={`调整四角：${placement.fileName}`}
                              onClick={() => {
                                setReceipt(null);
                                setEditing({ pageId: page.pageId, slot });
                              }}
                            >
                              调整四角
                            </button>
                          ) : null}
                          <ActionError message={errorAt(`${page.pageId}-${slot}`)} />
                        </div>
                      </li>
                    );
                  })}
                  {page.screenshotId ? <li className="caption">下半页右侧放支付截图。</li> : null}
                </ul>
              </li>
            ))}
          </ol>
        </>
      ) : (
        <section className="panel">
          <p className="caption loading" role="status">
            正在生成打印稿…
          </p>
        </section>
      )}
    </>
  );
}
