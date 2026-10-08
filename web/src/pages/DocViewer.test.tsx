import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { Material } from '@baox/contract';
import { t1Snapshot } from '../mock/fixtures/tasks';
import { DocViewer } from './DocViewer';
import { renderPdf } from './pdf-render';

vi.mock('./pdf-render', () => ({ MAX_PAGES: 6, renderPdf: vi.fn() }));

const rendered = vi.mocked(renderPdf);

function pdfMaterial(): Material {
  const material = t1Snapshot('project').materials.find((candidate) => candidate.mediaType === 'pdf' && candidate.previewUrl);
  if (!material) throw new Error('fixture is missing a PDF material');
  return material;
}

afterEach(() => rendered.mockReset());

// QA 2026-09-30: a PDF in the browser's own viewer opened small with thumbnails and was slow to paint.
describe('DocViewer with a PDF original', () => {
  test('shows the PDF rendered to an image, and opens the same image full screen', async () => {
    rendered.mockResolvedValue({ url: 'blob:rendered', pageCount: 1, shownPages: 1 });
    const material = pdfMaterial();
    render(<DocViewer material={material} />);

    const image = await screen.findByRole('img', { name: `${material.fileName} 原件` });
    expect(image.getAttribute('src')).toBe('blob:rendered');
    // Fitted to the frame's width, not squeezed whole into its height.
    expect(screen.getByTestId('doc-frame').style.inlineSize).toBe('100%');
    expect(screen.queryByTitle(`${material.fileName} 原件`)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '全屏查看' }));
    expect(screen.getByRole('img', { name: `${material.fileName} 原件（全屏）` }).getAttribute('src')).toBe('blob:rendered');
    // Rendered once, shared by the frame and the full-screen view.
    expect(rendered).toHaveBeenCalledTimes(1);
    expect(rendered).toHaveBeenCalledWith(material.previewUrl, expect.any(AbortSignal));
  });

  test('says how many pages are left out of a long PDF', async () => {
    rendered.mockResolvedValue({ url: 'blob:rendered', pageCount: 9, shownPages: 6 });
    render(<DocViewer material={pdfMaterial()} />);
    expect(await screen.findByText('共 9 页，这里显示前 6 页；其余页请打开原件查看。')).toBeTruthy();
  });

  test('falls back to the browser PDF preview when rendering fails', async () => {
    rendered.mockRejectedValue(new Error('no canvas'));
    const material = pdfMaterial();
    render(<DocViewer material={material} />);

    const frame = await screen.findByTitle(`${material.fileName} 原件`);
    expect(frame.tagName).toBe('IFRAME');
    expect(frame.getAttribute('src')).toBe(material.previewUrl);
  });
});
