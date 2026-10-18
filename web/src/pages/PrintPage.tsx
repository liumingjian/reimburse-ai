import { useEffect, useRef, useState } from 'react';
import { Button, ContentSwitcher, IconButton, InlineNotification, Switch } from '@carbon/react';
import { Crop, RotateClockwise, RotateCounterclockwise } from '@carbon/icons-react';
import { type PlacementSlot, type Corners, type Placement, type PrintPage as PrintSheetPage, type TaskSnapshot } from '@baox/contract';
import { ActionError } from '../shell/ActionError';
import { FieldGroup } from '../shell/FieldGroup';
import { PageHeader } from '../shell/PageHeader';
import { useAction } from '../shell/useAction';
import { navigate, taskHash } from '../router';
import { CropEditor, formatCorners } from './CropEditor';
import { DocFullscreen, DocImage } from './DocFullscreen';
import { PAGE_COPY } from './page-copy';

// 打印稿预览：服务端渲染的页图平铺成网格，一屏看多页；每行几页由员工选（3、4、5，记在本机浏览器）。页眉整句来自快照，
// 页面不拼；页序跟随统一业务序号。点页图全屏看这一页（与原件共用 DocFullscreen）。
// 还没有打印稿（或旧稿已作废）时，进入页面即请服务端生成。旋转、四角裁剪只是打印设置：页图上每一半各有图标按钮，
// 结果以服务端返回的新快照为准，不改原件，也不影响整单明细确认。提醒（如住宿发票还没有支付截图）不阻止下载。
// 支付截图不在这里补充（QA 2026-09-30）：住宿发票缺支付截图在待确认项里上传；预览页只看、只调版面。
// 页卡、页图与四角裁剪编辑器没有对应的 Carbon 组件，保持手写版式，按钮、切换器与弹窗用 Carbon。

const SLOTS: readonly PlacementSlot[] = ['top', 'bottom'];
const PER_ROW = [3, 4, 5] as const;
type PerRow = (typeof PER_ROW)[number];
const PER_ROW_KEY = 'baox.print.perRow';
const DEFAULT_PER_ROW: PerRow = 4;

function readPerRow(): PerRow {
  try {
    const stored = Number(globalThis.localStorage?.getItem(PER_ROW_KEY));
    return PER_ROW.find((value) => value === stored) ?? DEFAULT_PER_ROW;
  } catch {
    return DEFAULT_PER_ROW;
  }
}

function storePerRow(value: PerRow) {
  try {
    globalThis.localStorage?.setItem(PER_ROW_KEY, String(value));
  } catch {
    // Private mode or storage disabled: the choice lasts for this page only.
  }
}

type Editing = { pageId: string; slot: PlacementSlot };

export function PrintPage({ snapshot }: { snapshot: TaskSnapshot }) {
  const taskId = snapshot.task.taskId;
  const copy = PAGE_COPY.print;
  const sheet = snapshot.printSheet;
  const confirmed = snapshot.confirmation.status === 'confirmed';
  const generated = sheet.status === 'generated';
  // 失败原因显示在触发它的按钮旁：generate（页头下载按钮旁）、<pageId>-<slot>（该放置的按钮旁）、crop（裁剪编辑器旁）。
  const { busy, run, errorAt, linkAt } = useAction(taskId);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [perRow, setPerRow] = useState<PerRow>(readPerRow);
  const [enlarged, setEnlarged] = useState<{ page: PrintSheetPage; index: number } | null>(null);
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

  const fillErp = async () => {
    const outcome = await run((adapter) => adapter.startErpWrite(taskId, snapshot.step.stepToken), 'erp');
    if (outcome.ok) navigate(taskHash(taskId, 'erp'));
  };

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
            {snapshot.erp.status === 'idle' ? (
              <Button kind="secondary" disabled={busy} onClick={() => void fillErp()}>去报销</Button>
            ) : (
              <Button kind="secondary" href={taskHash(taskId, 'erp')}>查看填报进度</Button>
            )}
            {generated && sheet.url ? (
              <Button href={sheet.url} {...({ download: sheet.fileName ?? true } as object)}>
                下载打印稿 PDF
              </Button>
            ) : (
              <Button disabled>下载打印稿 PDF</Button>
            )}
          </>
        }
      />
      {/* Header action errors sit under the header, not between its buttons. */}
      {errorAt('erp') || errorAt('generate') ? (
        <p className="app-notice-block">
          <ActionError message={errorAt('erp')} link={linkAt('erp')} />
          <ActionError message={errorAt('generate')} />
        </p>
      ) : null}

      <p className="app-caption">去报销会自动填写已确认的明细并暂存到报销系统，你检查后自己提交。</p>
      <div className="app-print-toolbar" role="toolbar" aria-label="打印稿查看">
        <ContentSwitcher
          className="app-per-row-switcher"
          size="sm"
          aria-label="每行页数"
          selectedIndex={PER_ROW.indexOf(perRow)}
          onChange={({ index }) => {
            const value = PER_ROW[index ?? 0] ?? DEFAULT_PER_ROW;
            setPerRow(value);
            storePerRow(value);
          }}
        >
          {PER_ROW.map((value) => (
            <Switch key={value} name={String(value)} text={`每行 ${value} 页`} />
          ))}
        </ContentSwitcher>
        <span className="app-caption">点页图全屏查看；页图右上角的图标调整这一半的放置与裁剪。</span>
      </div>

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
            <h2 className="app-section-title">调整四角</h2>
            <FieldGroup
              fields={[
                { label: '文件名', value: <span className="app-file-name">{editingPlacement.fileName}</span> },
                { label: '所在页', value: editingPage.header },
              ]}
            />
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
          <div className="app-print-summary">
            <FieldGroup
              label="打印稿"
              fields={[
                ...(sheet.fileName ? [{ label: '文件名', value: <span className="app-file-name">{sheet.fileName}</span> }] : []),
                { label: '页数', value: `${sheet.pages.length} 页 A4 纵向` },
              ]}
            />
            <p className="app-caption">旋转与裁剪只保存为打印设置，不改原件，也不影响整单明细确认。</p>
          </div>
          <ol className="app-print-pages" aria-label="打印稿页面" style={{ gridTemplateColumns: `repeat(${perRow}, minmax(0, 1fr))` }}>
            {sheet.pages.map((page, index) => (
              <li key={page.pageId} className="app-page-card" aria-label={page.header}>
                <div className="page-hdr" title={page.header}>
                  {page.header}
                </div>
                <div className="app-page-figure">
                  <button type="button" className="app-page-open" aria-label={`全屏查看第 ${index + 1} 页`} onClick={() => setEnlarged({ page, index })}>
                    <img className="app-page-image" src={page.imageUrl} alt={`第 ${index + 1} 页页图`} loading="lazy" decoding="async" data-testid={`page-image-${page.pageId}`} />
                  </button>
                  {SLOTS.map((slot) => {
                    const placement = page[slot];
                    if (!placement) return null;
                    return (
                      <PlacementActions
                        key={slot}
                        slot={slot}
                        placement={placement}
                        busy={busy}
                        onRotate={() => void rotate(page, slot, placement)}
                        onCrop={() => {
                          setReceipt(null);
                          setEditing({ pageId: page.pageId, slot });
                        }}
                      />
                    );
                  })}
                </div>
                {SLOTS.map((slot) => (
                  <ActionError key={slot} message={errorAt(`${page.pageId}-${slot}`)} />
                ))}
              </li>
            ))}
          </ol>
          {/* The same full-screen view as a 原件: only look, no page actions there. */}
          <DocFullscreen open={enlarged !== null} heading={enlarged?.page.header ?? ''} {...(enlarged ? { label: `第 ${enlarged.index + 1} 页` } : {})} onClose={() => setEnlarged(null)}>
            {enlarged ? <DocImage key={enlarged.page.imageUrl} src={enlarged.page.imageUrl} alt={`第 ${enlarged.index + 1} 页页图（全屏）`} rotation={0} fit="stage" /> : null}
          </DocFullscreen>
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

// Icon buttons over one half of the page image (the voucher on top, the 证明材料 below): rotate or back to upright,
// and adjust the four corners of a photo. The accessible name carries the file name.
function PlacementActions({
  slot,
  placement,
  busy,
  onRotate,
  onCrop,
}: {
  slot: PlacementSlot;
  placement: Placement;
  busy: boolean;
  onRotate: () => void;
  onCrop: () => void;
}) {
  const rotateLabel = placement.rotate ? '改为竖放' : '旋转 90°';
  return (
    <div className={`app-placement-actions is-${slot}`}>
      <IconButton kind="secondary" size="sm" align="left" disabled={busy} label={`${rotateLabel}：${placement.fileName}`} onClick={onRotate}>
        {placement.rotate ? <RotateCounterclockwise /> : <RotateClockwise />}
      </IconButton>
      {placement.croppable && placement.corners && placement.imageUrl ? (
        <IconButton kind="secondary" size="sm" align="left" disabled={busy} label={`调整四角：${placement.fileName}`} onClick={onCrop}>
          <Crop />
        </IconButton>
      ) : null}
    </div>
  );
}
