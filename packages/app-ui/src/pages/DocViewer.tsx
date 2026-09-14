import type { Material } from '../contract/snapshot';

// 原件栏：一份报销材料的预览，放在待确认项页左栏（DESIGN.md「待确认项：原件与表单」）。
// 原件在「一屏高度减去顶栏、步骤条和页头」的框内等比缩放，栏宽跟着缩放后的原件走；没有预览时占位保持同样的版面位置。
// 父组件按待确认项 key 重建本组件，以后加入的查看状态（缩放、旋转）随切换自然重置。
export function DocViewer({ material }: { material: Material | undefined }) {
  return (
    <div className="app-viewer" data-testid="doc-viewer">
      <DocPreview material={material} />
    </div>
  );
}

function DocPreview({ material }: { material: Material | undefined }) {
  if (!material || !material.previewUrl) {
    return (
      <div className={`app-doc-preview is-boxed is-placeholder is-${material?.shape ?? 'portrait'}`} data-testid="preview">
        <span className="app-caption">没有可用的预览</span>
      </div>
    );
  }
  if (material.mediaType === 'image') {
    return (
      <div className="app-doc-preview is-image">
        <img src={material.previewUrl} alt={`${material.fileName} 原件`} data-testid="preview" />
      </div>
    );
  }
  return (
    <div className={`app-doc-preview is-boxed is-${material.shape}`}>
      <iframe src={material.previewUrl} title={`${material.fileName} 原件`} data-testid="preview" />
    </div>
  );
}
