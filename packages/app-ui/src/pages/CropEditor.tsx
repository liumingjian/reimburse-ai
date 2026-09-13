import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { Button } from '@carbon/react';
import type { Corners } from '../contract/snapshot';

// 四角裁剪编辑器：在原图上拖动四个角点（指针事件；选中角点后方向键微调，Shift 每次 10 像素）。
// 角点坐标一律是原图像素：显示尺寸与原图尺寸（naturalWidth / naturalHeight）之比换算，取整并限制在原图范围内。
// 编辑中的角点只是表单草稿；提交后以服务端回显的坐标为准。Carbon 没有对应组件：编辑器手写，按钮用 Carbon。

export const CORNER_NAMES = ['左上角', '右上角', '右下角', '左下角'] as const;

const KEY_STEP = 1;
const KEY_STEP_LARGE = 10;
const ARROWS: Readonly<Record<string, readonly [number, number]>> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

type Size = { width: number; height: number };

export function formatPoint([x, y]: readonly [number, number]): string {
  return `(${Math.round(x)}, ${Math.round(y)})`;
}

export function formatCorners(corners: Corners): string {
  return corners.map(formatPoint).join(' ');
}

const clamp = (value: number, max: number) => Math.min(Math.max(value, 0), max);
const copy = (corners: Corners): Corners => corners.map(([x, y]) => [x, y]) as Corners;

export function CropEditor({
  imageUrl,
  alt,
  initial,
  busy,
  onSubmit,
  onCancel,
}: {
  imageUrl: string;
  alt: string;
  initial: Corners;
  busy: boolean;
  onSubmit: (corners: Corners) => void;
  onCancel: () => void;
}) {
  const imageRef = useRef<HTMLImageElement>(null);
  const dragging = useRef<number | null>(null);
  const [natural, setNatural] = useState<Size | null>(null);
  const [corners, setCorners] = useState<Corners>(() => copy(initial));

  const readNatural = () => {
    const image = imageRef.current;
    if (image && image.naturalWidth > 0 && image.naturalHeight > 0) setNatural({ width: image.naturalWidth, height: image.naturalHeight });
  };

  // 图片可能在挂载前已从缓存载入完成，onLoad 不再触发。
  useEffect(() => {
    if (imageRef.current?.complete) readNatural();
  }, []);

  const setCorner = (index: number, point: [number, number]) =>
    setCorners((previous) => {
      const next = copy(previous);
      next[index] = point;
      return next;
    });

  // 指针位置（视口坐标）→ 原图像素。
  const toNatural = (clientX: number, clientY: number): [number, number] | null => {
    const image = imageRef.current;
    if (!image || !natural) return null;
    const rect = image.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const x = Math.round(((clientX - rect.left) * natural.width) / rect.width);
    const y = Math.round(((clientY - rect.top) * natural.height) / rect.height);
    return [clamp(x, natural.width), clamp(y, natural.height)];
  };

  const onPointerDown = (index: number, event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.currentTarget.focus();
    dragging.current = index;
    if (typeof event.currentTarget.setPointerCapture === 'function') event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (index: number, event: PointerEvent<HTMLButtonElement>) => {
    if (dragging.current !== index) return;
    const point = toNatural(event.clientX, event.clientY);
    if (point) setCorner(index, point);
  };

  const endDrag = (event: PointerEvent<HTMLButtonElement>) => {
    dragging.current = null;
    if (typeof event.currentTarget.hasPointerCapture === 'function' && event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const onKeyDown = (index: number, event: KeyboardEvent<HTMLButtonElement>) => {
    const arrow = ARROWS[event.key];
    const point = corners[index];
    if (!arrow || !natural || !point) return;
    event.preventDefault();
    const step = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
    setCorner(index, [clamp(point[0] + arrow[0] * step, natural.width), clamp(point[1] + arrow[1] * step, natural.height)]);
  };

  const percent = (value: number, total: number) => `${(value / total) * 100}%`;

  return (
    <div className="crop-editor">
      <div className="crop-stage">
        <img ref={imageRef} src={imageUrl} alt={alt} draggable={false} onLoad={readNatural} />
        {natural ? (
          <>
            <svg className="crop-outline" viewBox={`0 0 ${natural.width} ${natural.height}`} preserveAspectRatio="none" aria-hidden="true">
              <polygon points={corners.map(([x, y]) => `${x},${y}`).join(' ')} />
            </svg>
            {corners.map((point, index) => (
              <button
                key={CORNER_NAMES[index]}
                type="button"
                className="crop-handle"
                aria-label={`拖动${CORNER_NAMES[index]}`}
                style={{ left: percent(point[0], natural.width), top: percent(point[1], natural.height) }}
                onPointerDown={(event) => onPointerDown(index, event)}
                onPointerMove={(event) => onPointerMove(index, event)}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
                onKeyDown={(event) => onKeyDown(index, event)}
              />
            ))}
          </>
        ) : null}
      </div>
      <div className="crop-side">
        <p className="app-caption">拖动四个角点贴合纸张边缘；选中角点后可用方向键微调，按住 Shift 每次移动 10 像素。坐标以原图像素计。</p>
        {natural ? (
          <p className="app-caption">
            原图 <span>{`${natural.width} x ${natural.height}`}</span>
          </p>
        ) : (
          <p className="app-caption">正在载入原图…</p>
        )}
        <ol className="crop-coords" aria-label="四角坐标">
          {corners.map((point, index) => (
            <li key={CORNER_NAMES[index]} data-testid={`corner-${index}`}>
              <span>{CORNER_NAMES[index]}</span>
              <span>{formatPoint(point)}</span>
            </li>
          ))}
        </ol>
        <div className="app-btn-row">
          <Button size="sm" disabled={busy || !natural} onClick={() => onSubmit(copy(corners))}>
            提交裁剪
          </Button>
          <Button kind="ghost" size="sm" disabled={busy} onClick={() => setCorners(copy(initial))}>
            恢复
          </Button>
          <Button kind="ghost" size="sm" disabled={busy} onClick={onCancel}>
            取消
          </Button>
        </div>
      </div>
    </div>
  );
}
