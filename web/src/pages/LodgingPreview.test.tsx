import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { projectLodgingEvidence } from '@baox/contract';
import { t1Snapshot } from '../mock/fixtures/tasks';
import { LodgingPreview } from './LodgingPreview';

afterEach(() => vi.unstubAllGlobals());

describe('LodgingPreview', () => {
  test('shows an unlinked selected folio from the server projection with preview and original access', () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 200 })));
    const base = t1Snapshot('project');
    const folio = base.materials.find((material) => material.kind === 'hotel_folio');
    if (!folio) throw new Error('fixture is missing a hotel folio');
    const materials = base.materials.map((material) => ({ ...material, linkedMaterialIds: [] }));
    const snapshot = {
      ...base,
      materials,
      lines: [],
      lodgingEvidence: projectLodgingEvidence({ materials, lines: [] }),
    };

    render(<LodgingPreview snapshot={snapshot} materialId={folio.materialId} />);

    expect(screen.getByRole('tab', { name: `结账单：${folio.fileName}` })).toBeTruthy();
    const original = screen.getByRole('link', { name: '预览空白或打不开？打开原件' });
    expect(original.getAttribute('href')).toBe(folio.originalUrl);
    expect(screen.getByTestId('doc-viewer')).toBeTruthy();
  });
});
