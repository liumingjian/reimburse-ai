import { useEffect, useState } from 'react';
import { Button } from '@carbon/react';
import { type TaskSnapshot } from '@baox/contract';
import { taskHash } from '../router';
import { DocViewer } from './DocViewer';

export function LodgingPreview({ snapshot, materialId }: { snapshot: TaskSnapshot; materialId: string }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [failed, setFailed] = useState<string[]>([]);
  const [retry, setRetry] = useState(0);
  const evidence = snapshot.lodgingEvidence.find((candidate) => candidate.materialId === materialId);
  const materials = new Map(snapshot.materials.map((material) => [material.materialId, material]));
  const choices = (evidence?.previews ?? []).flatMap((preview) => {
    const material = materials.get(preview.materialId);
    return material ? [{ ...preview, material }] : [];
  });
  const selectedPreview = choices.find((preview) => preview.material.materialId === selectedId) ?? choices.find((preview) => preview.material.materialId === evidence?.defaultMaterialId);
  const selected = selectedPreview?.material;
  const selectedMaterialId = selected?.materialId;
  const previewUrl = selected?.previewUrl;
  useEffect(() => {
    if (!previewUrl || !selectedMaterialId) return;
    const controller = new AbortController();
    // PDF iframes do not reliably signal HTTP errors. Check the same read-only resource before treating it as usable.
    void fetch(previewUrl, { signal: controller.signal }).then(async (response) => {
      await response.body?.cancel();
      if (!response.ok && !controller.signal.aborted) setFailed((ids) => ids.includes(selectedMaterialId) ? ids : [...ids, selectedMaterialId]);
    }).catch(() => {
      if (!controller.signal.aborted) setFailed((ids) => ids.includes(selectedMaterialId) ? ids : [...ids, selectedMaterialId]);
    });
    return () => controller.abort();
  }, [previewUrl, selectedMaterialId, retry]);
  if (!evidence) return <DocViewer material={snapshot.materials.find((material) => material.materialId === materialId)} />;
  const previewFailed = selectedPreview ? !selectedPreview.available || failed.includes(selectedPreview.material.materialId) : false;
  return (
    <section aria-label="住宿材料预览">
      <div className="app-btn-row">
        {choices.map(({ material }) => <Button key={material.materialId} kind="tertiary" size="sm" aria-pressed={material.materialId === selected?.materialId} onClick={() => setSelectedId(material.materialId)}>{material.kind === 'hotel_folio' ? `结账单：${material.fileName}` : `发票：${material.fileName}`}</Button>)}
      </div>
      {evidence.state === 'missing' ? <p role="status">还没有这笔住宿的结账单。请追加结账单后重新盘点；确实没有，可在待确认项中记录缺失。</p> : null}
      {evidence.state === 'unlinked' ? <p role="status">任务中有结账单，但尚未与这笔住宿关联。请在材料盘点中核对结账单与发票的信息；打开预览不会建立关联。</p> : null}
      {evidence.state === 'missing' || evidence.state === 'unlinked' ? <Button kind="ghost" href={taskHash(snapshot.task.taskId, evidence.state === 'missing' ? 'upload' : 'inventory')}>{evidence.state === 'missing' ? '去追加结账单' : '去核对材料关联'}</Button> : null}
      {previewFailed && selected ? <div role="status"><p>材料已在任务中，但预览暂时不可用。这不表示缺少结账单。</p>{selected.previewUrl ? <Button kind="ghost" size="sm" onClick={() => { setFailed((ids) => ids.filter((id) => id !== selected.materialId)); setRetry((value) => value + 1); }}>重试预览</Button> : null}</div> : null}
      {selected?.originalUrl ? <p><a href={selected.originalUrl} target="_blank" rel="noreferrer">{previewFailed ? '打开原件' : '预览空白或打不开？打开原件'}</a></p> : <Button kind="ghost" href={taskHash(snapshot.task.taskId, 'inventory')}>去检查原件状态</Button>}
      {!previewFailed && selected ? <DocViewer key={`${selected.materialId}:${retry}`} material={selected} onPreviewError={() => setFailed((ids) => [...ids, selected.materialId])} /> : null}
    </section>
  );
}
