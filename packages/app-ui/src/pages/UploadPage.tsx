import { useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import { Button, InlineNotification, ProgressBar, Tag } from '@carbon/react';
import { Add, Document, DocumentPdf, Image as ImageIcon } from '@carbon/icons-react';
import { UPLOAD_ACCEPT_ATTRIBUTE, UPLOAD_ACCEPTED_EXTENSIONS, type TaskSnapshot, type UploadBatch, type UploadFileResult } from '../contract/snapshot';
import { formatBytes, hashPrefix } from '../format';
import { navigate, taskHash } from '../router';
import { ActionBar } from '../shell/ActionBar';
import { FieldGroup } from '../shell/FieldGroup';
import { PageHeader } from '../shell/PageHeader';
import { StatusTag } from '../shell/StatusTag';
import { useAction } from '../shell/useAction';
import { useReopenUpload } from '../shell/useReopenUpload';
import { PAGE_COPY } from './page-copy';

// 上传材料页：拖入或选择文件 → 适配器逐文件给出接收/拒绝 → 按上传批次列出；可追加下一批；有材料后出现「开始材料盘点」。
// 页面不判定文件是否合规：所有结果来自快照里的批次记录。
// 整单明细已确认的任务再追加下一批，先弹出同一份二次确认，再请服务端使确认失效（回到上传阶段）。
// The drop zone is design A from the QA prototype: a centred pictogram, the main line, the link-style prompt and the
// format tags; the append area uses its one-line form. File rows are tagged only when rejected (exceptions only).

// 开始材料盘点 (start material inventory) and 追加下一批 (append next batch) live in the sticky action bar (#141),
// hidden while the append area is open.
// The line under the drop zone states the next step. Inventory starts only when the employee clicks 开始材料盘点
// (the server never starts it after an upload), and the copy says so.
export const UPLOAD_NEXT_STEP = '上传后点「开始材料盘点」，系统开始盘点。';
// Accessible name of the drop zone and of its file input. The visible copy is longer and changes with the drag state.
export const UPLOAD_PROMPT = '拖入文件，或点击选择';
export const UPLOAD_TITLE = '把材料拖到这里';
export const UPLOAD_ORIGINALS_NOTE = '原件会被复制进任务目录，不会被修改。';
const UPLOAD_DROP_NOW = '松开即可上传';
const UPLOAD_FORMATS = ['PDF', 'JPG', 'PNG', '单个 ≤ 20MB'] as const;

// Document with an upload badge, drawn in the Carbon pictogram manner; Carbon ships no drop-zone illustration.
function UploadPictogram() {
  return (
    <svg className="app-dropzone-pictogram" viewBox="0 0 72 72" aria-hidden="true" focusable="false">
      <path className="app-pictogram-paper" d="M18 8h24l12 12v38a2 2 0 0 1-2 2H18a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2Z" />
      <path className="app-pictogram-fold" d="M42 8v12h12" />
      <path className="app-pictogram-lines" d="M23 28h20M23 35h24M23 42h14" />
      <g className="app-pictogram-badge">
        <circle cx="52" cy="52" r="13" />
        <path d="M52 59V45m-6 6 6-6 6 6" />
      </g>
    </svg>
  );
}

// Handwritten because Carbon's FileUploaderDropContainer only takes a string label. Like Carbon's, the zone answers
// Enter and Space itself; it is a div with the button role so it can hold the pictogram, tags and progress bar.
// Its name comes from a visually hidden prompt; the visible copy is aria-hidden so the name stays short.
function Dropzone({ busyCount, disabled, compact, onFiles }: { busyCount: number; disabled: boolean; compact: boolean; onFiles: (files: File[]) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const pick = (list: FileList | null) => {
    const files = list ? Array.from(list) : [];
    if (files.length > 0) onFiles(files);
  };
  const openPicker = () => {
    if (!disabled) inputRef.current?.click();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    openPicker();
  };
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragOver(false);
    if (!disabled) pick(event.dataTransfer.files);
  };

  const busyText = `正在接收 ${busyCount} 份文件…`;
  const className = ['app-dropzone', compact && 'is-compact', dragOver && 'is-dragover'].filter(Boolean).join(' ');
  return (
    <div>
      {compact ? null : <p className="cds--label">材料文件</p>}
      <div
        className={className}
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled}
        data-testid="dropzone"
        onClick={openPicker}
        onKeyDown={onKeyDown}
        onDragOver={(event) => {
          event.preventDefault();
          if (!disabled) setDragOver(true);
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragOver(false);
        }}
        onDrop={onDrop}
      >
        <span className="cds--visually-hidden">{UPLOAD_PROMPT}</span>
        <UploadPictogram />
        {busyCount > 0 ? (
          <span className="app-dropzone-busy">
            <span className="app-dropzone-title" role="status">
              {busyText}
            </span>
            <ProgressBar className="app-dropzone-progress" label={busyText} hideLabel size="small" />
          </span>
        ) : (
          <>
            {compact ? (
              <span className="app-dropzone-title" aria-hidden="true">
                {dragOver ? (
                  UPLOAD_DROP_NOW
                ) : (
                  <>
                    追加材料：拖到这里，或 <span className="app-dropzone-link">点击选择</span>
                  </>
                )}
              </span>
            ) : (
              <>
                <span className="app-dropzone-title" aria-hidden="true">
                  {dragOver ? UPLOAD_DROP_NOW : UPLOAD_TITLE}
                </span>
                <span className="app-dropzone-hint" aria-hidden="true">
                  或 <span className="app-dropzone-link">点击选择文件</span>，可一次选多份
                </span>
              </>
            )}
            <span className="app-dropzone-tags" aria-hidden="true">
              {UPLOAD_FORMATS.map((format) => (
                <Tag key={format} type="gray" size="sm">
                  {format}
                </Tag>
              ))}
            </span>
          </>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={UPLOAD_ACCEPT_ATTRIBUTE}
        aria-label={UPLOAD_PROMPT}
        className="cds--visually-hidden"
        tabIndex={-1}
        disabled={disabled}
        onChange={(event) => {
          pick(event.target.files);
          event.target.value = '';
        }}
      />
      <p className="cds--form__helper-text">{UPLOAD_NEXT_STEP}</p>
      <p className="cds--form__helper-text">{UPLOAD_ORIGINALS_NOTE}</p>
    </div>
  );
}

// File kind by name extension, for display only. Every accepted extension other than pdf is an image, read from the
// contract's accepted list so the icon and the accepted formats cannot drift apart. HEIC is rejected on upload but is
// still an image, so a rejected HEIC row keeps the image icon.
function fileKind(fileName: string): 'pdf' | 'image' | null {
  const extension = fileName.split('.').pop()?.toLowerCase() ?? '';
  if (extension === 'pdf') return 'pdf';
  if (extension === 'heic' || (UPLOAD_ACCEPTED_EXTENSIONS as readonly string[]).includes(extension)) return 'image';
  return null;
}

// Icon by file type from the existing record (file name extension); anything else gets the plain document icon.
function FileIcon({ fileName }: { fileName: string }) {
  const kind = fileKind(fileName);
  if (kind === 'pdf') return <DocumentPdf className="app-file-icon" aria-label="PDF" />;
  if (kind === 'image') return <ImageIcon className="app-file-icon" aria-label="图片" />;
  return <Document className="app-file-icon" aria-hidden="true" />;
}

function FileRow({ file, index }: { file: UploadFileResult; index: number }) {
  const rejected = file.status === 'rejected';
  const digest = file.contentHash ? hashPrefix(file.contentHash) : null;
  return (
    <li className={rejected ? 'is-rejected' : undefined}>
      <span className="app-file-index">{String(index + 1).padStart(2, '0')}</span>
      <FileIcon fileName={file.fileName} />
      <span className="app-file-name" title={digest ? `内容哈希 ${digest}` : undefined}>
        {file.fileName}
      </span>
      {rejected ? (
        <>
          <Tag type="red" size="sm">
            拒绝
          </Tag>
          <span className="app-file-reason">{file.reason}</span>
        </>
      ) : null}
      <span className="app-file-size app-muted">{formatBytes(file.size)}</span>
    </li>
  );
}

function BatchPanel({ batch }: { batch: UploadBatch }) {
  const accepted = batch.files.filter((file) => file.status === 'accepted').length;
  const rejected = batch.files.length - accepted;
  return (
    <section className="app-block" aria-labelledby={`batch-${batch.batchId}`}>
      <div className="app-block-head">
        <h2 className="app-section-title" id={`batch-${batch.batchId}`}>
          上传批次 #{batch.no}
        </h2>
        <FieldGroup fields={[{ label: '材料', value: `${accepted} 份` }]} />
        {rejected === 0 ? (
          <StatusTag tone="success">已复制入任务目录</StatusTag>
        ) : (
          <StatusTag tone="warning">拒绝 {rejected} 份</StatusTag>
        )}
      </div>
      <ul className="app-file-list bleed">
        {batch.files.map((file, index) => (
          <FileRow key={file.fileId} file={file} index={index} />
        ))}
      </ul>
    </section>
  );
}

export function UploadPage({ snapshot }: { snapshot: TaskSnapshot }) {
  const taskId = snapshot.task.taskId;
  const invalidated = snapshot.confirmation.status === 'invalidated';
  // 因追加材料回到上传阶段的任务，一进来就打开追加区。
  const [appending, setAppending] = useState(invalidated && snapshot.stage === 'upload');
  const [busyCount, setBusyCount] = useState(0);
  const { busy: acting, error, run } = useAction(taskId);
  const reopen = useReopenUpload(snapshot, () => setAppending(true));
  const copy = PAGE_COPY.upload;
  const hasBatches = snapshot.batches.length > 0;
  const hasMaterials = snapshot.materials.length > 0;
  const busy = busyCount > 0 || acting;
  const confirmed = snapshot.confirmation.status === 'confirmed';

  // 已确认的任务追加下一批：先二次确认，服务端使确认失效后再打开追加区。
  const append = () => {
    if (confirmed) reopen.open();
    else setAppending(true);
  };

  const upload = async (files: File[]) => {
    setBusyCount(files.length);
    const outcome = await run((adapter) => adapter.uploadBatch(taskId, files));
    setBusyCount(0);
    if (outcome.ok) setAppending(false);
  };

  const startInventory = async () => {
    const outcome = await run((adapter) => adapter.startInventory(taskId, snapshot.step.stepToken));
    if (outcome.ok) navigate(taskHash(taskId, 'inventory'));
  };

  return (
    <>
      <PageHeader title={copy.title} lead={copy.lead} />
      {invalidated && snapshot.confirmation.notice ? (
        <InlineNotification kind="warning" role="status" lowContrast hideCloseButton statusIconDescription="注意" title={snapshot.confirmation.notice} />
      ) : null}
      {snapshot.batches.map((batch) => (
        <BatchPanel key={batch.batchId} batch={batch} />
      ))}
      {!hasBatches || appending ? (
        <section className={hasBatches ? 'app-block' : 'app-upload-first'} aria-label={hasBatches ? '追加下一批' : '上传文件'}>
          {hasBatches ? (
            <div className="app-block-head">
              <h2 className="app-section-title">追加下一批</h2>
              <Button kind="ghost" size="sm" disabled={busy} onClick={() => setAppending(false)}>
                取消
              </Button>
            </div>
          ) : null}
          <Dropzone busyCount={busyCount} disabled={busy} compact={hasBatches} onFiles={(files) => void upload(files)} />
          {error ? (
            <p className="app-action-error app-block-note" role="alert">
              {error}
            </p>
          ) : null}
        </section>
      ) : (
        <ActionBar
          label="下一步"
          consequence={hasMaterials ? '开始盘点后，追加或删除材料会形成新的盘点版本。' : null}
          caption={hasMaterials ? null : '还没有被接收的材料，请追加下一批。'}
          actions={
            <>
              <Button kind="ghost" renderIcon={Add} disabled={busy} onClick={append}>
                追加下一批
              </Button>
              <Button disabled={busy || !hasMaterials} onClick={() => void startInventory()}>
                开始材料盘点
              </Button>
            </>
          }
          error={error}
        />
      )}
      {reopen.dialog}
    </>
  );
}
