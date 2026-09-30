import { useEffect, useState } from 'react';
import { Button, ContentSwitcher, Switch } from '@carbon/react';
import { type TaskSnapshot } from '@baox/contract';
import { taskHash } from '../router';
import { ActionGroup } from '../shell/ActionGroup';
import { FileName } from '../shell/FileName';
import { DocViewer } from './DocViewer';

export function LodgingPreview({ snapshot, materialId }: { snapshot: TaskSnapshot; materialId: string }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [failed, setFailed] = useState<string[]>([]);
  const [retry, setRetry] = useState(0);
  const evidence = snapshot.lodgingEvidence.find((candidate) => candidate.materialId === materialId);
  const materials = new Map(snapshot.materials.map((material) => [material.materialId, material]));
  // Only the 结账单 or other 证明材料 is previewed, never the invoice: the folio lists the stay's items and amounts that
  // remind the user what to fill in, while an invoice alone does not (QA 2026-09-30).
  const choices = (evidence?.previews ?? []).flatMap((preview) => {
    const material = materials.get(preview.materialId);
    return material && material.kind !== 'vat_invoice' ? [{ ...preview, material }] : [];
  });
  const selectedPreview = choices.find((preview) => preview.material.materialId === selectedId) ?? choices.find((preview) => preview.material.materialId === evidence?.defaultMaterialId) ?? choices[0];
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
  const selectedIndex = Math.max(0, choices.findIndex(({ material }) => material.materialId === selected?.materialId));
  // The folios are a ContentSwitcher inside the viewer frame: equal-width switches, file names with a middle ellipsis.
  const switcher =
    choices.length > 0 ? (
      <ContentSwitcher className="app-doc-switcher" size="md" selectedIndex={selectedIndex} onChange={({ index }) => setSelectedId(choices[index ?? 0]?.material.materialId ?? null)}>
        {choices.map(({ material }) => {
          const kind = material.kind === 'hotel_folio' ? '结账单' : '证明材料';
          return (
            <Switch key={material.materialId} name={material.materialId} aria-label={`${kind}：${material.fileName}`}>
              <span className="app-switch-kind">{kind}</span>
              <FileName name={material.fileName} />
            </Switch>
          );
        })}
      </ContentSwitcher>
    ) : null;
  const retryPreview = (materialId: string) => {
    setFailed((ids) => ids.filter((id) => id !== materialId));
    setRetry((value) => value + 1);
  };
  return (
    <section className="app-lodging-preview" aria-label="住宿材料预览">
      {evidence.state === 'missing' ? <p role="status">还没有这笔住宿的结账单。请追加结账单后重新盘点；确实没有，可在待确认项中记录缺失。</p> : null}
      {evidence.state === 'unlinked' ? <p role="status">任务中有结账单，但尚未与这笔住宿关联。请在材料盘点中核对结账单与发票的信息；打开预览不会建立关联。</p> : null}
      {evidence.state === 'missing' || evidence.state === 'unlinked' ? (
        <Button kind="ghost" size="md" href={taskHash(snapshot.task.taskId, evidence.state === 'missing' ? 'upload' : 'inventory')}>
          {evidence.state === 'missing' ? '去追加结账单' : '去核对材料关联'}
        </Button>
      ) : null}
      {selected ? (
        <DocViewer
          key={`${selected.materialId}:${retry}`}
          material={selected}
          header={switcher}
          onPreviewError={() => setFailed((ids) => [...ids, selected.materialId])}
          unavailable={
            previewFailed ? (
              <div role="status">
                <p>材料已在任务中，但预览暂时不可用。这不表示缺少结账单。</p>
                <ActionGroup>
                  {selected.previewUrl ? (
                    <Button kind="secondary" size="md" onClick={() => retryPreview(selected.materialId)}>
                      重试预览
                    </Button>
                  ) : null}
                  {selected.originalUrl ? (
                    <Button kind="ghost" size="md" href={selected.originalUrl} target="_blank" rel="noreferrer">
                      打开原件
                    </Button>
                  ) : null}
                </ActionGroup>
              </div>
            ) : undefined
          }
        />
      ) : null}
      {selected?.originalUrl && !previewFailed ? (
        <p className="app-caption app-viewer-note">
          <a href={selected.originalUrl} target="_blank" rel="noreferrer">
            预览空白或打不开？打开原件
          </a>
        </p>
      ) : null}
      {!selected?.originalUrl ? (
        <Button kind="ghost" size="md" href={taskHash(snapshot.task.taskId, 'inventory')}>
          去检查原件状态
        </Button>
      ) : null}
    </section>
  );
}
