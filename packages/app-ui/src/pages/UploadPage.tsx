import { useState } from 'react';
import { Button, FileUploaderDropContainer, InlineNotification, Tag } from '@carbon/react';
import { Add, CheckmarkFilled, Document, DocumentPdf, Image as ImageIcon, Upload, WarningAltFilled } from '@carbon/icons-react';
import { UPLOAD_ACCEPT_ATTRIBUTE, UPLOAD_ACCEPTED_EXTENSIONS, type TaskSnapshot, type UploadBatch, type UploadFileResult } from '../contract/snapshot';
import { formatBytes, hashPrefix } from '../format';
import { navigate, taskHash } from '../router';
import { ActionBar } from '../shell/ActionBar';
import { FieldGroup } from '../shell/FieldGroup';
import { PageHeader } from '../shell/PageHeader';
import { useAction } from '../shell/useAction';
import { useReopenUpload } from '../shell/useReopenUpload';
import { PAGE_COPY } from './page-copy';

// 上传材料页：拖入或选择文件 → 适配器逐文件给出接收/拒绝 → 按上传批次列出；可追加下一批；有材料后出现「开始材料盘点」。
// 页面不判定文件是否合规：所有结果来自快照里的批次记录。
// 整单明细已确认的任务再追加下一批，先弹出同一份二次确认，再请服务端使确认失效（回到上传阶段）。
// Layout follows Carbon's file uploader: label and format rules above a stock FileUploaderDropContainer that spans the
// form width, holding a 16px upload icon and the link-style prompt. File rows are tagged only when rejected (exceptions only).

// 开始材料盘点 (start material inventory) and 追加下一批 (append next batch) live in the sticky action bar (#141),
// hidden while the append area is open.
// The line under the drop zone states the next step. Inventory starts only when the employee clicks 开始材料盘点
// (the server never starts it after an upload), and the copy says so.
export const UPLOAD_NEXT_STEP = '上传后点「开始材料盘点」，系统开始盘点。';
export const UPLOAD_PROMPT = '拖入文件，或点击选择';

const ACCEPT = UPLOAD_ACCEPT_ATTRIBUTE.split(',');
// Carbon drops files whose name has no extension before onAddFiles. This pattern matches an empty
// extension instead, so every file reaches the server, which alone decides accept or reject.
const ANY_EXTENSION = String.raw`\.?[^.]*$`;

function Dropzone({ busyCount, disabled, onFiles }: { busyCount: number; disabled: boolean; onFiles: (files: File[]) => void }) {
  return (
    <div className="cds--form-item">
      <p className="cds--file--label">材料文件</p>
      <p className="cds--label-description">支持 PDF、JPG、PNG，单个文件不超过 20MB。原件会被复制进任务目录，不会被修改。</p>
      {/* labelText only takes a string, so the icon is a sibling laid over the zone; it takes no clicks and has no name. */}
      <div className="app-upload-drop">
        <FileUploaderDropContainer
          labelText={UPLOAD_PROMPT}
          multiple
          accept={ACCEPT}
          pattern={ANY_EXTENSION}
          disabled={disabled}
          data-testid="dropzone"
          onAddFiles={(_event, { addedFiles }) => {
            // Carbon flags type mismatches on the File objects; the page ignores that and lets the server judge.
            if (addedFiles.length > 0) onFiles([...addedFiles]);
          }}
        />
        <Upload size={16} className="app-upload-drop-icon" aria-hidden="true" data-testid="upload-drop-icon" />
      </div>
      {busyCount > 0 ? (
        <p className="cds--form__helper-text" role="status">
          正在接收 {busyCount} 份文件…
        </p>
      ) : (
        <p className="cds--form__helper-text">{UPLOAD_NEXT_STEP}</p>
      )}
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
          <Dropzone busyCount={busyCount} disabled={busy} onFiles={(files) => void upload(files)} />
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
