import { useState } from 'react';
import { ContentSwitcher, Switch } from '@carbon/react';
import type { TaskSnapshot } from '@baox/contract';
import { FileName } from '../shell/FileName';
import { DocViewer } from './DocViewer';

export function DiningPreview({ snapshot, materialId }: { snapshot: TaskSnapshot; materialId: string }) {
  const [selectedId, setSelectedId] = useState(materialId);
  const anchor = snapshot.materials.find((material) => material.materialId === materialId);
  const choices = snapshot.materials.filter((material) =>
    (material.materialId === materialId || anchor?.linkedMaterialIds.includes(material.materialId)) &&
    (material.kind === 'vat_invoice' || material.kind === 'dining_receipt'),
  );
  const selected = choices.find((material) => material.materialId === selectedId) ?? choices[0];
  return (
    <section aria-label="餐饮材料预览">
      <DocViewer material={selected} header={
        <ContentSwitcher className="app-doc-switcher" size="md" selectedIndex={Math.max(0, choices.findIndex((material) => material.materialId === selected?.materialId))} onChange={({ index }) => setSelectedId(choices[index ?? 0]?.materialId ?? materialId)}>
          {choices.map((material) => {
            const kind = material.kind === 'dining_receipt' ? '餐饮小票' : '发票';
            return <Switch key={material.materialId} name={material.materialId} aria-label={`${kind}：${material.fileName}`}><span className="app-switch-kind">{kind}</span><FileName name={material.fileName} /></Switch>;
          })}
        </ContentSwitcher>
      } />
      {selected?.originalUrl ? <p className="app-caption app-viewer-note"><a href={selected.originalUrl} target="_blank" rel="noreferrer">预览空白或打不开？打开原件</a></p> : null}
    </section>
  );
}
