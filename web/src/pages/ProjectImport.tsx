import { useRef, useState } from 'react';
import { Button, Checkbox, InlineNotification, Select, SelectItem, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@carbon/react';
import { type ProjectImportWorkbook, type ProjectImportPreview } from '@baox/contract';
import { useAppStore } from '../adapter/context';
import type { BookScope } from '../adapter/store';

const STATUS = { add: '新增', update: '更新', skip: '跳过', error: '错误' } as const;

export function ProjectImport({ scope, disabled }: { scope: BookScope; disabled: boolean }) {
  const store = useAppStore();
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [workbook, setWorkbook] = useState<ProjectImportWorkbook | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const preview: ProjectImportPreview | null = workbook?.kind === 'preview' ? workbook.preview : null;

  const load = async (file: File, sheet?: string) => {
    setBusy(true);
    setError(null);
    setSuccess(null);
    setWorkbook(current => sheet !== undefined && current ? { kind: 'choose-sheet', sheets: current.sheets } : null);
    setSelected(new Set());
    try {
      const outcome = await store.adapter.previewProjectImport(scope, file, sheet);
      if (!outcome.ok) { setError(outcome.error.message); return; }
      setWorkbook(outcome.value);
      if (outcome.value.kind === 'preview') setSelected(new Set(outcome.value.preview.rows.filter(row => row.status === 'add').map(row => row.row)));
    } catch { setError('无法读取 Excel，请重试。'); }
    finally { setBusy(false); }
  };
  const commit = async () => {
    if (!preview || selected.size === 0) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await store.adapter.commitProjectImport(scope, { previewId: preview.previewId, rows: [...selected] });
      if (!outcome.ok) { setError(outcome.error.message); return; }
      setSuccess(`导入完成：新增 ${outcome.value.added} 个项目，更新 ${outcome.value.updated} 个项目。`);
      setWorkbook(null);
      setSelected(new Set());
      await (scope === 'public' ? store.loadPublicBook() : store.loadProjectBook());
    } catch { setError('未收到导入结果，请刷新预览核对后重试。'); }
    finally { setBusy(false); }
  };

  return (
    <section className="app-block app-project-import" aria-label={`批量导入${scope === 'public' ? '公共' : '个人'}项目`}>
      <h3>批量导入</h3>
      <p className="app-muted">选择 .xlsx 文件，读取“项目序号”和“项目号”两列。先预览，确认后导入。</p>
      <Button kind="secondary" size="md" disabled={disabled || busy} onClick={() => fileInput.current?.click()}>选择 Excel 文件</Button>
      <input ref={fileInput} aria-label="选择 Excel 文件" hidden id={`project-import-${scope}`} type="file" accept=".xlsx" disabled={disabled || busy} onChange={event => {
        const chosen = event.target.files?.[0];
        if (!chosen) return;
        setFile(chosen);
        void load(chosen);
        event.target.value = '';
      }} />
      {file ? <p>{file.name}</p> : null}
      {workbook && workbook.sheets.length > 1 ? (
        <Select id={`project-import-sheet-${scope}`} labelText="工作表" value={workbook.kind === 'preview' ? workbook.sheet : ''} disabled={busy} onChange={event => { if (file && event.target.value) void load(file, event.target.value); }}>
          <SelectItem value="" text="请选择工作表" />
          {workbook.sheets.map(sheet => <SelectItem key={sheet} value={sheet} text={sheet} />)}
        </Select>
      ) : null}
      {busy ? <p role="status">正在处理…</p> : null}
      {error ? <InlineNotification kind="error" title={error} hideCloseButton lowContrast /> : null}
      {success ? <InlineNotification kind="success" title={success} hideCloseButton lowContrast /> : null}
      {file && error && !preview ? <Button size="sm" kind="secondary" disabled={busy || disabled} onClick={() => void load(file, workbook?.kind === 'preview' ? workbook.sheet : undefined)}>刷新预览</Button> : null}
      {preview ? <>
        <p role="status">{(['add', 'update', 'skip', 'error'] as const).map(status => `${STATUS[status]} ${preview.rows.filter(row => row.status === status).length} 行`).join('，')}。已选择 {selected.size} 行。</p>
        <div className="app-table app-import-preview">
          <Table aria-label="项目导入预览">
            <TableHead><TableRow>{['选择', 'Excel 行号', '项目序号', '原项目号', '导入项目号', '处理结果'].map(label => <TableHeader key={label}>{label}</TableHeader>)}</TableRow></TableHead>
            <TableBody>{preview.rows.map(row => <TableRow key={row.row}>
              <TableCell>{row.status === 'add' || row.status === 'update' ? <Checkbox id={`import-${scope}-${row.row}`} labelText={`选择第 ${row.row} 行`} hideLabel checked={selected.has(row.row)} disabled={busy || disabled} onChange={(_, { checked }) => setSelected(current => { const next = new Set(current); if (checked) next.add(row.row); else next.delete(row.row); return next; })} /> : null}</TableCell>
              <TableCell>{row.row}</TableCell><TableCell>{row.number || '未填写'}</TableCell><TableCell>{row.previousName ?? '无'}</TableCell><TableCell>{row.name || '未填写'}</TableCell><TableCell>{STATUS[row.status]}：{row.note}</TableCell>
            </TableRow>)}</TableBody>
          </Table>
        </div>
        {preview.rows.some(row => row.status === 'error') ? <p>错误行不会导入。可仅导入已选择的正常行。</p> : null}
        <Button size="md" disabled={busy || disabled || selected.size === 0} onClick={() => void commit()}>{preview.rows.some(row => row.status === 'error') ? '仅导入正常行' : '确认导入'}（{selected.size} 行）</Button>
        <Button size="md" kind="secondary" disabled={busy || disabled} onClick={() => { if (file && workbook?.kind === 'preview') void load(file, workbook.sheet); }}>刷新预览</Button>
      </> : null}
    </section>
  );
}
