import { useEffect, useState, type ReactNode } from 'react';
import { Button, InlineLoading } from '@carbon/react';
import { Maximize } from '@carbon/icons-react';
import type { Material } from '@baox/contract';
import { DocFullscreen, DocImage, nextRotation, type Rotation } from './DocFullscreen';
import { renderPdf, type RenderedPdf } from './pdf-render';

// 原件栏：一份报销材料的预览，放在待确认项页左栏（DESIGN.md「待确认项：原件与表单」「原件查看器」）。
// 原件在「一屏高度减去顶栏、步骤条和页头」的框内整页显示，栏宽跟着原件走；没有预览时占位保持同样的版面位置。
// 框里不放工具栏：点原件或「全屏查看」打开全屏，在全屏里看清、旋转（QA 2026-09-30：框太小，框内放大仍看不清）。
// 查看状态只在本组件里：不写服务端，与打印稿的旋转、裁剪无关；换一份材料时旋转回到 0。
// PDF 原件先用 pdf.js 渲染成一张图（逐页竖排），框里和全屏共用；渲染失败才退回浏览器自带的 PDF 预览（iframe）。
// `header` sits inside the sticky frame above the preview (the lodging 结账单 switcher), so it stays with the document
// while the page scrolls; the full-screen view repeats it, so switching there keeps the view open. `unavailable`
// replaces the preview with a message in a frame of the same size.
export function DocViewer({
  material,
  onPreviewError,
  header,
  unavailable,
}: {
  material: Material | undefined;
  onPreviewError?: () => void;
  header?: ReactNode;
  unavailable?: ReactNode;
}) {
  const source = usePreviewSource(material);
  const [open, setOpen] = useState(false);
  const [turn, setTurn] = useState<{ materialId: string | undefined; rotation: Rotation }>({ materialId: undefined, rotation: 0 });
  const rotation = turn.materialId === material?.materialId ? turn.rotation : 0;
  const alt = material ? `${material.fileName} 原件` : '原件';
  // Full screen and rotation only apply to something drawn as an image: a photo or a rendered PDF.
  const viewable = !unavailable && (source.kind === 'image' || source.kind === 'pdf');
  const onError = onPreviewError ? { onError: onPreviewError } : {};
  const rotate = () => setTurn({ materialId: material?.materialId, rotation: nextRotation(rotation) });

  return (
    <div className="app-viewer" data-testid="doc-viewer">
      {header ? <div className="app-viewer-header">{header}</div> : null}
      {unavailable ? (
        <div className={`app-doc-preview is-boxed is-placeholder is-${material?.shape ?? 'portrait'}`}>
          <div className="app-doc-unavailable">{unavailable}</div>
        </div>
      ) : (
        <FramePreview material={material} source={source} alt={alt} rotation={rotation} onOpen={() => setOpen(true)} {...onError} />
      )}
      {viewable ? (
        <Button kind="ghost" size="sm" className="app-doc-open" renderIcon={Maximize} onClick={() => setOpen(true)}>
          全屏查看
        </Button>
      ) : null}
      <DocFullscreen open={open} heading={material?.fileName ?? '原件'} label="原件" header={header} onClose={() => setOpen(false)} {...(viewable ? { onRotate: rotate } : {})}>
        {unavailable ? <div className="app-doc-unavailable">{unavailable}</div> : <StagePreview source={source} alt={alt} rotation={rotation} {...onError} />}
      </DocFullscreen>
    </div>
  );
}

// jsdom has no URL.revokeObjectURL.
const revokeUrl = (url: string) => {
  if (typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url);
};

type Source =
  | { kind: 'none' }
  | { kind: 'image'; url: string }
  | { kind: 'rendering' }
  | { kind: 'pdf'; pdf: RenderedPdf }
  | { kind: 'native'; url: string };

type PdfState = { kind: 'rendering' } | { kind: 'rendered'; pdf: RenderedPdf } | { kind: 'native' };

// A PDF is rendered to an image once (pdf-render.ts) and shared by the frame and the full-screen view. When rendering
// fails, the browser's own PDF preview in an iframe is the fallback.
function usePreviewSource(material: Material | undefined): Source {
  const url = material?.previewUrl;
  const isPdf = material !== undefined && material.mediaType !== 'image';
  const [pdf, setPdf] = useState<{ src: string; state: PdfState } | null>(null);
  useEffect(() => {
    if (!url || !isPdf) return;
    const controller = new AbortController();
    let rendered: string | null = null;
    renderPdf(url, controller.signal).then(
      (result) => {
        rendered = result.url;
        if (controller.signal.aborted) revokeUrl(result.url);
        else setPdf({ src: url, state: { kind: 'rendered', pdf: result } });
      },
      () => {
        if (!controller.signal.aborted) setPdf({ src: url, state: { kind: 'native' } });
      },
    );
    return () => {
      controller.abort();
      if (rendered) revokeUrl(rendered);
    };
  }, [url, isPdf]);
  if (!url) return { kind: 'none' };
  if (!isPdf) return { kind: 'image', url };
  const state = pdf?.src === url ? pdf.state : { kind: 'rendering' as const };
  if (state.kind === 'rendered') return { kind: 'pdf', pdf: state.pdf };
  if (state.kind === 'native') return { kind: 'native', url };
  return { kind: 'rendering' };
}

function PageNote({ pdf }: { pdf: RenderedPdf }) {
  return pdf.shownPages < pdf.pageCount ? <p className="app-caption">共 {pdf.pageCount} 页，这里显示前 {pdf.shownPages} 页；其余页请打开原件查看。</p> : null;
}

function FramePreview({
  material,
  source,
  alt,
  rotation,
  onOpen,
  onError,
}: {
  material: Material | undefined;
  source: Source;
  alt: string;
  rotation: Rotation;
  onOpen: () => void;
  onError?: () => void;
}) {
  const shape = material?.shape ?? 'portrait';
  const errorProps = onError ? { onError } : {};
  switch (source.kind) {
    case 'image':
      return <DocImage key={source.url} src={source.url} alt={alt} rotation={rotation} fit="page" onOpen={onOpen} {...errorProps} />;
    case 'pdf':
      // 竖版 A4 整页塞进框高太小，看不清：PDF 铺满框宽、在框内竖向滚动。
      return (
        <>
          <DocImage key={source.pdf.url} src={source.pdf.url} alt={alt} rotation={rotation} fit="width" onOpen={onOpen} {...errorProps} />
          <PageNote pdf={source.pdf} />
        </>
      );
    case 'native':
      return (
        <div className={`app-doc-preview is-boxed is-${shape}`}>
          <iframe src={source.url} title={alt} data-testid="preview" onError={onError} />
        </div>
      );
    case 'rendering':
      return (
        <div className={`app-doc-preview is-boxed is-placeholder is-${shape}`} data-testid="preview">
          <InlineLoading description="正在打开 PDF…" />
        </div>
      );
    default:
      return (
        <div className={`app-doc-preview is-boxed is-placeholder is-${shape}`} data-testid="preview">
          <span className="app-caption">没有可用的预览</span>
        </div>
      );
  }
}

// The full-screen view only opens from an image or a rendered PDF; switching lodging folios there can land on any
// source, so each still has a way to show.
function StagePreview({ source, alt, rotation, onError }: { source: Source; alt: string; rotation: Rotation; onError?: () => void }) {
  const errorProps = onError ? { onError } : {};
  switch (source.kind) {
    case 'image':
      return <DocImage key={source.url} src={source.url} alt={`${alt}（全屏）`} rotation={rotation} fit="stage" {...errorProps} />;
    case 'pdf':
      return (
        <>
          <DocImage key={source.pdf.url} src={source.pdf.url} alt={`${alt}（全屏）`} rotation={rotation} fit="stage" {...errorProps} />
          <PageNote pdf={source.pdf} />
        </>
      );
    case 'native':
      return <iframe className="app-fullscreen-pdf" src={source.url} title={`${alt}（全屏）`} />;
    case 'rendering':
      return <InlineLoading description="正在打开 PDF…" />;
    default:
      return <p className="app-caption">没有可用的预览</p>;
  }
}
