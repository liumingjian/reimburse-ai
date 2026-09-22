import { useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { IconButton } from '@carbon/react';
import { FitToScreen, RotateClockwise, ZoomIn, ZoomOut } from '@carbon/icons-react';
import type { Material } from '@baox/contract';

// 原件栏：一份报销材料的预览，放在待确认项页左栏（DESIGN.md「待确认项：原件与表单」「原件查看器」）。
// 原件在「一屏高度减去顶栏、步骤条和页头」的框内等比缩放，栏宽跟着缩放后的原件走；没有预览时占位保持同样的版面位置。
// 图片原件带查看工具栏（适应窗口、放大、缩小、旋转 90°）。查看状态只在本组件里：不写服务端，与打印稿的旋转、裁剪无关。
// 父组件按待确认项 key 重建本组件，切换待确认项时缩放与旋转自然重置。
export function DocViewer({ material, onPreviewError }: { material: Material | undefined; onPreviewError?: () => void }) {
  return (
    <div className="app-viewer" data-testid="doc-viewer">
      <DocPreview material={material} {...(onPreviewError ? { onPreviewError } : {})} />
    </div>
  );
}

function DocPreview({ material, onPreviewError }: { material: Material | undefined; onPreviewError?: () => void }) {
  if (!material || !material.previewUrl) {
    return (
      <div className={`app-doc-preview is-boxed is-placeholder is-${material?.shape ?? 'portrait'}`} data-testid="preview">
        <span className="app-caption">没有可用的预览</span>
      </div>
    );
  }
  if (material.mediaType === 'image') {
    return <ImageViewer src={material.previewUrl} alt={`${material.fileName} 原件`} {...(onPreviewError ? { onPreviewError } : {})} />;
  }
  // PDF 用浏览器自带的预览（自带缩放），不显示图片工具栏。
  return (
    <div className={`app-doc-preview is-boxed is-${material.shape}`}>
      <iframe src={material.previewUrl} title={`${material.fileName} 原件`} data-testid="preview" onError={onPreviewError} />
    </div>
  );
}

// 缩放档位：相对「适应窗口」的倍数，1 即适应窗口。
const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4] as const;
const FIT_STEP = ZOOM_STEPS.indexOf(1);
type Rotation = 0 | 90 | 180 | 270;

type Size = { width: number; height: number };

function ImageViewer({ src, alt, onPreviewError }: { src: string; alt: string; onPreviewError?: () => void }) {
  const [step, setStep] = useState(FIT_STEP);
  const [rotation, setRotation] = useState<Rotation>(0);
  const [natural, setNatural] = useState<Size | null>(null);
  const [frame, setFrame] = useState<Size | null>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);

  const zoom = ZOOM_STEPS[step] ?? 1;
  const sideways = rotation === 90 || rotation === 270;
  // 旋转 90° 或 270° 时宽高互换，按交换后的宽高适应。
  const turned = natural ? (sideways ? { width: natural.height, height: natural.width } : natural) : null;

  // 量原件框的实际内尺寸（窄窗口里框会被栏宽收窄）。
  useLayoutEffect(() => {
    const node = frameRef.current;
    if (!node) return;
    const measure = () => setFrame({ width: node.clientWidth, height: node.clientHeight });
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [turned?.width, turned?.height]);

  const fit = turned && frame && frame.width > 0 && frame.height > 0 ? Math.min(frame.width / turned.width, frame.height / turned.height) : null;
  const scale = fit === null ? null : fit * zoom;

  // 换档时保持框中心所看的位置不变。
  const previousScale = useRef(scale);
  useLayoutEffect(() => {
    const node = frameRef.current;
    const before = previousScale.current;
    previousScale.current = scale;
    if (!node || before === null || scale === null || before === scale) return;
    const ratio = scale / before;
    node.scrollLeft = (node.scrollLeft + node.clientWidth / 2) * ratio - node.clientWidth / 2;
    node.scrollTop = (node.scrollTop + node.clientHeight / 2) * ratio - node.clientHeight / 2;
  }, [scale]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const node = frameRef.current;
    if (!node || event.button !== 0) return;
    drag.current = { x: event.clientX, y: event.clientY, left: node.scrollLeft, top: node.scrollTop };
    node.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const node = frameRef.current;
    const start = drag.current;
    if (!node || !start) return;
    node.scrollLeft = start.left - (event.clientX - start.x);
    node.scrollTop = start.top - (event.clientY - start.y);
  };
  const endDrag = () => {
    drag.current = null;
  };

  const canvas = turned && scale !== null ? { width: turned.width * scale, height: turned.height * scale } : null;
  const image = natural && scale !== null ? { width: natural.width * scale, height: natural.height * scale } : null;
  // 框宽按适应后的原件定（栏宽跟着走），缩放时不变，放大后在框内滚动。
  const frameWidth = turned ? `calc(var(--app-doc-frame-block) * ${turned.width / turned.height})` : undefined;

  return (
    <div className="app-doc-viewer">
      <div className="app-doc-toolbar" role="toolbar" aria-label="原件查看">
        <IconButton kind="ghost" size="sm" label="适应窗口" align="bottom" onClick={() => setStep(FIT_STEP)}>
          <FitToScreen />
        </IconButton>
        <IconButton kind="ghost" size="sm" label="放大" align="bottom" disabled={step >= ZOOM_STEPS.length - 1} onClick={() => setStep((current) => Math.min(current + 1, ZOOM_STEPS.length - 1))}>
          <ZoomIn />
        </IconButton>
        <IconButton kind="ghost" size="sm" label="缩小" align="bottom" disabled={step <= 0} onClick={() => setStep((current) => Math.max(current - 1, 0))}>
          <ZoomOut />
        </IconButton>
        <IconButton kind="ghost" size="sm" label="旋转 90°" align="bottom" onClick={() => setRotation((current) => ((current + 90) % 360) as Rotation)}>
          <RotateClockwise />
        </IconButton>
        <p className="app-doc-zoom" role="status" aria-live="polite">
          <span className="cds--visually-hidden">当前倍数 </span>
          {Math.round(zoom * 100)}%
        </p>
      </div>
      <div
        ref={frameRef}
        className={`app-doc-preview is-image${zoom > 1 ? ' is-pannable' : ''}`}
        style={frameWidth ? { inlineSize: frameWidth } : undefined}
        data-testid="doc-frame"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div className="app-doc-canvas" style={canvas ? { inlineSize: canvas.width, blockSize: canvas.height } : undefined}>
          <img
            src={src}
            onError={onPreviewError}
            alt={alt}
            data-testid="preview"
            draggable={false}
            onLoad={(event) => setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
            style={{
              ...(image ? { inlineSize: image.width, blockSize: image.height } : {}),
              transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
            }}
          />
        </div>
      </div>
    </div>
  );
}
