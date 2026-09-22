import type { FieldCandidate, Material, TaskSnapshot } from './snapshot';

export type LodgingValue = { value: string; materialId: string; source: string; evidence: FieldCandidate['evidence'] };
export type LodgingEvidence = {
  invoice: Material | null;
  bills: Material[];
  unlinkedBills: Material[];
  defaultMaterial: Material | null;
  previews: { material: Material; status: 'available' | 'unavailable' }[];
  state: 'associated' | 'missing' | 'unlinked' | 'preview_failure';
  fields: { location: LodgingValue | null; hotelName: LodgingValue | null; checkIn: LodgingValue | null; checkOut: LodgingValue | null; amount: LodgingValue | null };
};

type FieldSource = { value: string; materialId: string; source: string; evidence: FieldCandidate['evidence'] };

function supportedFieldSources(materials: readonly Material[], key: string, fallback: LodgingValue | null = null): FieldSource[] {
  const sources = materials.flatMap((material) => material.fields
    .filter((candidate) => candidate.key === key && candidate.value.trim() && (candidate.evidence === 'explicit' || candidate.evidence === 'derived'))
    .map((candidate) => ({ value: candidate.value, materialId: material.materialId, source: candidate.source, evidence: candidate.evidence })));
  return fallback ? [...sources, fallback] : sources;
}

function resolveSources(sources: readonly FieldSource[]): LodgingValue | null {
  if (sources.length === 0 || new Set(sources.map((source) => source.value.trim())).size !== 1) return null;
  return sources[0]!;
}

function resolvedField(materials: readonly Material[], key: string, fallback: LodgingValue | null = null): LodgingValue | null {
  return resolveSources(supportedFieldSources(materials, key, fallback));
}

function hasRecordedFolioAssociation(snapshot: Pick<TaskSnapshot, 'materials' | 'lines'>, folio: Material): boolean {
  return snapshot.materials.some((material) => material.kind === 'vat_invoice' && (material.linkedMaterialIds.includes(folio.materialId) || folio.linkedMaterialIds.includes(material.materialId)))
    || snapshot.lines.some((line) => line.referenceMaterialIds.includes(folio.materialId));
}

// Reads recorded associations only. Preview failures never classify or associate a material.
export function lodgingEvidence(snapshot: Pick<TaskSnapshot, 'materials' | 'lines'>, materialId: string, failedPreviewIds: readonly string[] = []): LodgingEvidence | null {
  const selected = snapshot.materials.find((material) => material.materialId === materialId);
  if (!selected) return null;
  const relatedInvoices = snapshot.materials.filter((material) => material.kind === 'vat_invoice' && (
    material.materialId === selected.materialId
    || material.linkedMaterialIds.includes(selected.materialId)
    || selected.linkedMaterialIds.includes(material.materialId)
    || snapshot.lines.some((line) => line.voucherMaterialId === material.materialId && line.referenceMaterialIds.includes(selected.materialId))
  ));
  const invoice = selected.kind === 'vat_invoice' ? selected : relatedInvoices.length === 1 ? relatedInvoices[0]! : null;
  const line = snapshot.lines.find((candidate) => candidate.voucherMaterialId === invoice?.materialId || candidate.referenceMaterialIds.includes(selected.materialId));
  const linked = snapshot.materials.filter((material) => selected.linkedMaterialIds.includes(material.materialId) || material.linkedMaterialIds.includes(selected.materialId));
  if (selected.kind !== 'hotel_folio' && selected.categoryLabel !== '住宿' && line?.category.code !== 'accommodation' && !linked.some((material) => material.kind === 'hotel_folio')) return null;
  const bills = snapshot.materials.filter((material) => material.kind === 'hotel_folio' && material.role !== 'excluded' && invoice !== null && (
    material.linkedMaterialIds.includes(invoice.materialId)
    || invoice.linkedMaterialIds.includes(material.materialId)
    || snapshot.lines.some((candidate) => candidate.voucherMaterialId === invoice.materialId && candidate.referenceMaterialIds.includes(material.materialId))
  ));
  const unlinkedBills = snapshot.materials.filter((material) => material.kind === 'hotel_folio' && material.role !== 'excluded' && !hasRecordedFolioAssociation(snapshot, material));
  const defaultMaterial = bills[0] ?? invoice ?? selected;
  const previews = [...bills, ...(invoice ? [invoice] : [])].map((material) => ({ material, status: !material.previewUrl || failedPreviewIds.includes(material.materialId) ? 'unavailable' as const : 'available' as const }));
  return {
    invoice, bills, unlinkedBills, defaultMaterial, previews,
    state: !bills.length ? (unlinkedBills.length ? 'unlinked' : 'missing') : (!defaultMaterial.previewUrl || failedPreviewIds.includes(defaultMaterial.materialId) ? 'preview_failure' : 'associated'),
    fields: {
      location: resolvedField([...bills, ...(invoice ? [invoice] : [])], 'city', line?.city ? { value: line.city, materialId: line.voucherMaterialId, source: 'recorded_line', evidence: 'derived' } : null),
      hotelName: resolvedField(bills, 'hotelName'),
      checkIn: resolvedField(bills, 'checkIn'),
      checkOut: resolvedField(bills, 'checkOut'),
      amount: resolveSources([
        ...supportedFieldSources(invoice ? [invoice] : [], 'totalAmount'),
        ...supportedFieldSources(bills, 'folioTotal'),
      ]),
    },
  };
}
