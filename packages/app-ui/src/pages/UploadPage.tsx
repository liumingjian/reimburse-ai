import { useCallback, useRef, useState, type DragEvent, type MouseEvent } from 'react';
import { useAppStore } from '../adapter/context';
import { STALE_STEP_CODE } from '../contract/actions';
import { UPLOAD_ACCEPT_ATTRIBUTE, type TaskSnapshot, type UploadBatch } from '../contract/snapshot';
import { formatBytes, hashPrefix } from '../format';
import { navigate, taskHash } from '../router';
import { ActionError, failureMessage } from '../shell/ActionError';
import { ConfirmDialog, REOPEN_DIALOG } from '../shell/Dialog';
import { PAGE_COPY } from './page-copy';

// 上传材料页：拖入或选择文件 → 适配器逐文件给出接收/拒绝 → 按上传批次列出；可追加下一批；有材料后出现「开始材料盘点」。
// 页面不判定文件是否合规：所有结果来自快照里的批次记录。
// 整单明细已确认的任务再追加下一批，先弹出同一份二次确认，再请服务端使确认失效（回到上传阶段）。

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
      className={dragOver ? 'dropzone dragover' : 'dropzone'}
      onDragOver={(event) => {
        event.preventDefault();
        if (!disabled) setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
      onClick={onZoneClick}
      data-testid="dropzone"
    >
      {busyCount > 0 ? (
        <strong role="status">正在接收 {busyCount} 份文件…</strong>
      ) : (
        <>
          <strong>拖入文件，或点击选择</strong>
          <span className="muted">支持 PDF、JPG、PNG，单个文件不超过 20MB。原件会被复制进任务目录，不会被修改。</span>
          <button className="btn btn-secondary" type="button" disabled={disabled} onClick={() => inputRef.current?.click()}>
            选择文件
          </button>
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
    <section className="panel" aria-labelledby={`batch-${batch.batchId}`}>
      <div className="panel-head">
        <h2 id={`batch-${batch.batchId}`}>{title}</h2>
        {rejected === 0 ? <span className="badge badge-ok">已复制入任务目录</span> : <span className="badge badge-warn">拒绝 {rejected} 份</span>}
      </div>
      <ul className="file-list">
        {batch.files.map((file, index) => (
          <li key={file.fileId} className={file.status === 'rejected' ? 'rejected' : undefined}>
            <span className="mono muted">{String(index + 1).padStart(2, '0')}</span>
            <span className="name">{file.fileName}</span>
            {file.status === 'accepted' ? (
              <>
                <span className="badge badge-ok">已接收</span>
                <span className="mono muted">{file.contentHash ? hashPrefix(file.contentHash) : ''}</span>
              </>
            ) : (
              <>
                <span className="badge badge-err">拒绝</span>
                <span className="reason">{file.reason}</span>
              </>
            )}
            <span className="size mono muted">{formatBytes(file.size)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function UploadPage({ snapshot }: { snapshot: TaskSnapshot }) {
  const store = useAppStore();
  const taskId = snapshot.task.taskId;
  const invalidated = snapshot.confirmation.status === 'invalidated';
  // 因追加材料回到上传阶段的任务，一进来就打开追加区。
  const [appending, setAppending] = useState(invalidated && snapshot.stage === 'upload');
  const [busyCount, setBusyCount] = useState(0);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [reopening, setReopening] = useState(false);
  const [reopenError, setReopenError] = useState<string | null>(null);
  const copy = PAGE_COPY.upload;
  const hasBatches = snapshot.batches.length > 0;
  const hasMaterials = snapshot.materials.length > 0;
  const busy = busyCount > 0 || starting;
  const confirmed = snapshot.confirmation.status === 'confirmed';

  const closeDialog = useCallback(() => {
    setDialogOpen(false);
    setReopenError(null);
  }, []);

  // 已确认的任务追加下一批：先二次确认，服务端使确认失效后再打开追加区。
  const append = () => {
    if (confirmed) setDialogOpen(true);
    else setAppending(true);
  };

  const reopen = async () => {
    setReopenError(null);
    setReopening(true);
    const outcome = await store.act(taskId, (adapter) => adapter.reopenUpload(taskId, snapshot.step.stepToken));
    setReopening(false);
    if (outcome.ok) {
      setDialogOpen(false);
      setAppending(true);
    } else if (outcome.error.code === STALE_STEP_CODE) {
      setDialogOpen(false);
    } else {
      setReopenError(outcome.error.message);
    }
  };

  const upload = async (files: File[]) => {
    setError(null);
    setBusyCount(files.length);
    const outcome = await store.act(taskId, (adapter) => adapter.uploadBatch(taskId, files));
    setBusyCount(0);
    if (outcome.ok) setAppending(false);
    else setError(outcome.error.message);
  };

  const startInventory = async () => {
    setError(null);
    setStarting(true);
    const outcome = await store.act(taskId, (adapter) => adapter.startInventory(taskId, snapshot.step.stepToken));
    setStarting(false);
    if (outcome.ok) navigate(taskHash(taskId, 'inventory'));
    else setError(failureMessage(outcome));
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{copy.title}</h1>
          <p className="lead">{copy.lead}</p>
        </div>
      </div>
      {invalidated && snapshot.confirmation.notice ? (
        <div className="notice notice-warn" role="status">
          {snapshot.confirmation.notice}
        </div>
      ) : null}
      {snapshot.batches.map((batch) => (
        <BatchPanel key={batch.batchId} batch={batch} />
      ))}
      {!hasBatches || appending ? (
        <section className="panel" aria-label={hasBatches ? '追加下一批' : '上传文件'}>
          {hasBatches ? (
            <div className="panel-head">
              <h2>追加下一批</h2>
              <button className="btn btn-tertiary btn-sm" type="button" disabled={busy} onClick={() => setAppending(false)}>
                取消
              </button>
            </div>
          ) : null}
          <Dropzone busyCount={busyCount} disabled={busy} onFiles={(files) => void upload(files)} />
          {error ? (
            <p className="error upload-error" role="alert">
              {error}
            </p>
          ) : null}
        </section>
      ) : (
        <section className="panel">
          <div className="btn-row">
            <button className="btn btn-primary" type="button" disabled={busy || !hasMaterials} onClick={() => void startInventory()}>
              开始材料盘点
            </button>
            <button className="btn btn-tertiary" type="button" disabled={busy} onClick={append}>
              追加下一批
            </button>
            <span className="caption">{hasMaterials ? '开始盘点后，追加或删除材料会形成新的盘点版本。' : '还没有被接收的材料，请追加下一批。'}</span>
            <ActionError message={error} />
          </div>
        </section>
      )}
      {dialogOpen ? (
        <ConfirmDialog title={REOPEN_DIALOG.title} confirmLabel={REOPEN_DIALOG.confirm} busy={reopening} error={reopenError} onConfirm={() => void reopen()} onCancel={closeDialog}>
          <p className="lead">{REOPEN_DIALOG.body}</p>
        </ConfirmDialog>
      ) : null}
    </>
  );
}
