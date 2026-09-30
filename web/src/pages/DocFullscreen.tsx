import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { IconButton, Modal } from '@carbon/react';
import { RotateClockwise } from '@carbon/icons-react';

// 全屏查看：铺满浏览器窗口，只放原件（或打印稿页图），尽量放大，比屏幕高就往下滚动（DESIGN.md「原件查看器」）。
// 只有两个操作：右上角关闭（点空白处、Esc 也关），和可选的旋转 90°。没有放大缩小：看不清就点开全屏，这一步就够了
// （QA 2026-09-30）。

export type Rotation = 0 | 90 | 180 | 270;
export const nextRotation = (rotation: Rotation): Rotation => ((rotation + 90) % 360) as Rotation;

type Size = { width: number; height: number };

// How an image takes its box:
// - `page`: whole inside the 原件 frame, whose width follows the turned image's ratio (a photo);
// - `width`: fills the frame's width and scrolls down inside it (a rendered PDF);
// - `stage`: the full-screen view, as wide as the window up to a reading width, scrolling with the view.
export type Fit = 'page' | 'width' | 'stage';

// Wider than this, a receipt's text only grows past reading size and the page needs more scrolling.
const STAGE_MAX_WIDTH = 1024;

export function DocImage({ src, alt, rotation, fit, onError, onOpen }: { src: string; alt: string; rotation: Rotation; fit: Fit; onError?: () => void; onOpen?: () => void }) {
  const [natural, setNatural] = useState<Size | null>(null);
  const [box, setBox] = useState<Size | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const sideways = rotation === 90 || rotation === 270;
  // 旋转 90° 或 270° 时宽高互换，按交换后的宽高适应。
  const turned = natural ? (sideways ? { width: natural.height, height: natural.width } : natural) : null;

  // 量框的实际内尺寸（窄窗口里原件框会被栏宽收窄）。
  useLayoutEffect(() => {
    const node = boxRef.current;
    if (!node) return;
    const measure = () => setBox({ width: node.clientWidth, height: node.clientHeight });
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [turned?.width, turned?.height]);

  const scale =
    !turned || !box || box.width <= 0
      ? null
      : fit === 'page'
        ? box.height > 0
          ? Math.min(box.width / turned.width, box.height / turned.height)
          : null
        : Math.min(box.width, fit === 'stage' ? STAGE_MAX_WIDTH : Infinity) / turned.width;
  const canvas = turned && scale !== null ? { width: turned.width * scale, height: turned.height * scale } : null;
  const image = natural && scale !== null ? { width: natural.width * scale, height: natural.height * scale } : null;

  const picture = (
    <div className="app-doc-canvas" style={canvas ? { inlineSize: canvas.width, blockSize: canvas.height } : undefined}>
      <img
        src={src}
        onError={onError}
        alt={alt}
        data-testid={fit === 'stage' ? 'fullscreen-image' : 'preview'}
        draggable={false}
        onLoad={(event) => setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
        style={{
          ...(image ? { inlineSize: image.width, blockSize: image.height } : {}),
          transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
        }}
      />
    </div>
  );
  if (fit === 'stage') {
    return (
      <div ref={boxRef} className="app-fullscreen-image" data-backdrop="">
        {picture}
      </div>
    );
  }
  // 原件框：高度取原件框高；照片的框宽按（旋转后的）比例定，PDF 铺满栏宽。点原件打开全屏查看。
  const frameWidth = fit === 'width' ? '100%' : turned ? `calc(var(--app-doc-frame-block) * ${turned.width / turned.height})` : undefined;
  return (
    <div className={`app-doc-viewer${fit === 'width' ? ' is-fit-width' : ''}`}>
      <div
        ref={boxRef}
        className={`app-doc-preview is-image${onOpen ? ' is-openable' : ''}`}
        style={frameWidth ? { inlineSize: frameWidth } : undefined}
        data-testid="doc-frame"
        onClick={onOpen}
      >
        {picture}
      </div>
    </div>
  );
}

// The full-screen view is a Carbon passive Modal stretched to the window. `header` (the lodging 结账单 switcher) sits in
// a bar above the image with the optional rotate button; a click on the blank stage around the image closes it.
export function DocFullscreen({
  open,
  heading,
  label,
  onClose,
  onRotate,
  header,
  children,
}: {
  open: boolean;
  heading: string;
  label?: string;
  onClose: () => void;
  onRotate?: () => void;
  header?: ReactNode;
  children: ReactNode;
}) {
  const closeOnBlank = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget || (event.target instanceof HTMLElement && event.target.dataset.backdrop !== undefined)) onClose();
  };
  // Portalled to its own host at the end of <body>: inside a dialog, the dialog's transformed container would trap a
  // fixed full-screen view. Carbon's Esc closes only the last visible modal in the DOM and paints later modals on top,
  // and the dialog is itself portalled after this one mounts, so the host moves to the end of <body> on every open.
  // React events still bubble to the dialog through the portal; the dialog lists `.app-doc-fullscreen` among its
  // floating menus (shell/Dialog.tsx), so it neither reads a click here as outside nor pulls focus back.
  const [host] = useState(() => document.createElement('div'));
  useLayoutEffect(() => {
    if (open) document.body.appendChild(host);
  }, [open, host]);
  useEffect(() => () => host.remove(), [host]);
  return createPortal(
    <Modal open={open} passiveModal className="app-doc-fullscreen" modalHeading={heading} modalLabel={label} closeButtonLabel="关闭" onRequestClose={onClose}>
      {open ? (
        <>
          {header || onRotate ? (
            <div className="app-fullscreen-bar">
              {header ? <div className="app-fullscreen-header">{header}</div> : null}
              {onRotate ? (
                <IconButton kind="ghost" size="md" label="旋转 90°" align="bottom" onClick={onRotate}>
                  <RotateClockwise />
                </IconButton>
              ) : null}
            </div>
          ) : null}
          {/* Focus lands on the stage, not the close button: the button's 「关闭」 tooltip would pop up on open and take the
              first Esc to dismiss itself. From the stage, Esc closes at once and the arrow and page keys scroll. */}
          <div className="app-fullscreen-stage" data-testid="fullscreen-stage" tabIndex={-1} data-modal-primary-focus onClick={closeOnBlank}>
            {children}
          </div>
        </>
      ) : null}
    </Modal>,
    host,
  );
}
