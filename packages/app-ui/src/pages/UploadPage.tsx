import { useRef, useState, type DragEvent, type MouseEvent } from 'react';
import { Button, InlineNotification, Tag } from '@carbon/react';
import { Add, CheckmarkFilled, Document, Upload, WarningAltFilled } from '@carbon/icons-react';
import { UPLOAD_ACCEPT_ATTRIBUTE, type TaskSnapshot, type UploadBatch } from '../contract/snapshot';
import { formatBytes, hashPrefix } from '../format';
import { navigate, taskHash } from '../router';
import { ActionError } from '../shell/ActionError';
import { PageHeader } from '../shell/PageHeader';
import { useAction } from '../shell/useAction';
import { useReopenUpload } from '../shell/useReopenUpload';
import { PAGE_COPY } from './page-copy';

// 上传材料页：拖入或选择文件 → 适配器逐文件给出接收/拒绝 → 按上传批次列出；可追加下一批；有材料后出现「开始材料盘点」。
// 页面不判定文件是否合规：所有结果来自快照里的批次记录。
// 整单明细已确认的任务再追加下一批，先弹出同一份二次确认，再请服务端使确认失效（回到上传阶段）。
// 版式：拖放区在最上面；每个批次是一节，文件是通栏的紧凑行（状态用 Carbon 标签，带文字）。

function Dropzone({ busyCount, disabled, onFiles }: { busyCount: number; disabled: boolean; onFiles: (files: File[]) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const pick = (list: FileList | null) => {
    const files = list ? Array.from(list) : [];
    if (files.length > 0) onFiles(files);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragOver(false);
    if (!disabled) pick(event.dataTransfer.files);
  };

  const onZoneClick = (event: MouseEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('button')) return;
    inputRef.current?.click();
  };

  return (
    <div
      className={dragOver ? 'app-dropzone is-dragover' : 'app-dropzone'}
      onDragOver={(event) => {
        event.preventDefault();
        if (!disabled) setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
      onClick={onZoneClick}
      data-testid="dropzone"
    >
      <Upload size={32} className="app-dropzone-icon" aria-hidden="true" />
      {busyCount > 0 ? (
        <strong role="status">正在接收 {busyCount} 份文件…</strong>
      ) : (
        <>
          <strong>拖入文件，或点击选择</strong>
          <span className="app-muted">支持 PDF、JPG、PNG，单个文件不超过 20MB。原件会被复制进任务目录，不会被修改。</span>
          <Button kind="tertiary" size="md" disabled={disabled} onClick={() => inputRef.current?.click()}>
            选择文件
          </Button>
        </>
      )}
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={UPLOAD_ACCEPT_ATTRIBUTE}
        aria-label="选择文件"
        disabled={disabled}
        onChange={(event) => {
          pick(event.target.files);
          event.target.value = '';
        }}
      />
    </div>
  );
}

function BatchPanel({ batch }: { batch: UploadBatch }) {
  const accepted = batch.files.filter((file) => file.status === 'accepted').length;
  const rejected = batch.files.length - accepted;
  const title = `上传批次 #${batch.no} · ${accepted} 份材料`;
  return (
    <section className="app-block" aria-labelledby={`batch-${batch.batchId}`}>
      <div className="app-block-head">
        <h2 className="app-section-title" id={`batch-${batch.batchId}`}>
          {title}
        </h2>
        {rejected === 0 ? (
          <Tag type="green" renderIcon={CheckmarkFilled}>
            已复制入任务目录
          </Tag>
        ) : (
          <Tag type="warm-gray" renderIcon={WarningAltFilled}>
            拒绝 {rejected} 份
          </Tag>
        )}
      </div>
      <ul className="app-file-list bleed">
        {batch.files.map((file, index) => (
          <li key={file.fileId} className={file.status === 'rejected' ? 'is-rejected' : undefined}>
            <span className="app-file-index">{String(index + 1).padStart(2, '0')}</span>
            <Document className="app-file-icon" aria-hidden="true" />
            <span className="app-file-name">{file.fileName}</span>
            {file.status === 'accepted' ? (
              <>
                <Tag type="green" size="sm">
                  已接收
                </Tag>
                <span className="app-code app-muted">{file.contentHash ? hashPrefix(file.contentHash) : ''}</span>
              </>
            ) : (
              <>
                <Tag type="red" size="sm">
                  拒绝
                </Tag>
                <span className="app-file-reason">{file.reason}</span>
              </>
            )}
            <span className="app-file-size app-muted">{formatBytes(file.size)}</span>
          </li>
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
          <Dropzone busyCount={busyCount} disabled={busy} onFiles={(files) => void upload(files)} />
          {error ? (
            <p className="app-action-error app-block-note" role="alert">
              {error}
            </p>
          ) : null}
        </section>
      ) : (
        <div className="app-btn-row app-block">
          <Button disabled={busy || !hasMaterials} onClick={() => void startInventory()}>
            开始材料盘点
          </Button>
          <Button kind="ghost" renderIcon={Add} disabled={busy} onClick={append}>
            追加下一批
          </Button>
          <span className="app-caption">{hasMaterials ? '开始盘点后，追加或删除材料会形成新的盘点版本。' : '还没有被接收的材料，请追加下一批。'}</span>
          <ActionError message={error} />
        </div>
      )}
      {reopen.dialog}
    </>
  );
}
