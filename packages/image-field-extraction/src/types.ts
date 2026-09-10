export type ImageMaterialType =
  | "vat_invoice"
  | "rail_ticket"
  | "road_passenger_ticket"
  | "ride_itinerary"
  | "hotel_folio"
  | "payment_slip"
  | "other_voucher";

export interface Money {
  currency: "CNY";
  cents: number;
}

interface CandidateValue<T> {
  raw: string;
  normalized: T;
  sourceRefs: readonly string[];
  recognitionScore: number;
}

export type FieldCandidate<T> =
  | ({ evidenceState: "explicit" } & CandidateValue<T>)
  | ({ evidenceState: "derived"; rule: string } & CandidateValue<T>)
  | {
      evidenceState: "ambiguous";
      alternatives: readonly CandidateValue<T>[];
      sourceRefs: readonly string[];
    }
  | { evidenceState: "missing"; sourceRefs: readonly [] };

export interface VatInvoiceDocument {
  type: "vat_invoice";
  fields: {
    invoiceNumber: FieldCandidate<string>;
    issueDate: FieldCandidate<string>;
    netAmount: FieldCandidate<Money>;
    taxAmount: FieldCandidate<Money>;
    totalAmount: FieldCandidate<Money>;
    sellerName: FieldCandidate<string>;
    buyerName: FieldCandidate<string>;
    itemName: FieldCandidate<string>;
  };
}

export interface RailTicketDocument {
  type: "rail_ticket";
  fields: {
    invoiceNumber: FieldCandidate<string>;
    travelDate: FieldCandidate<string>;
    travelTime: FieldCandidate<string>;
    traveler: FieldCandidate<string>;
    origin: FieldCandidate<string>;
    destination: FieldCandidate<string>;
    trainNumber: FieldCandidate<string>;
    seat: FieldCandidate<string>;
    amount: FieldCandidate<Money>;
  };
}

export interface RoadPassengerTicketDocument {
  type: "road_passenger_ticket";
  fields: {
    ticketNumber: FieldCandidate<string>;
    travelDate: FieldCandidate<string>;
    travelTime: FieldCandidate<string>;
    traveler: FieldCandidate<string>;
    origin: FieldCandidate<string>;
    destination: FieldCandidate<string>;
    amount: FieldCandidate<Money>;
  };
}

export interface RideSegment {
  travelDate: FieldCandidate<string>;
  travelTime: FieldCandidate<string>;
  city: FieldCandidate<string>;
  origin: FieldCandidate<string>;
  destination: FieldCandidate<string>;
  amount: FieldCandidate<Money>;
}

export interface RideItineraryDocument {
  type: "ride_itinerary";
  fields: {
    traveler: FieldCandidate<string>;
    totalAmount: FieldCandidate<Money>;
    segments: readonly RideSegment[];
  };
}

export interface HotelFolioDocument {
  type: "hotel_folio";
  fields: {
    hotelName: FieldCandidate<string>;
    guestName: FieldCandidate<string>;
    city: FieldCandidate<string>;
    checkInDate: FieldCandidate<string>;
    checkOutDate: FieldCandidate<string>;
    totalAmount: FieldCandidate<Money>;
  };
}

export interface PaymentSlipDocument {
  type: "payment_slip";
  fields: {
    payer: FieldCandidate<string>;
    payee: FieldCandidate<string>;
    paidAt: FieldCandidate<string>;
    transactionNumber: FieldCandidate<string>;
    amount: FieldCandidate<Money>;
  };
}

export interface OtherVoucherDocument {
  type: "other_voucher";
  fields: {
    title: FieldCandidate<string>;
    merchant: FieldCandidate<string>;
    date: FieldCandidate<string>;
    amount: FieldCandidate<Money>;
  };
}

export type ExtractedDocument =
  | VatInvoiceDocument
  | RailTicketDocument
  | RoadPassengerTicketDocument
  | RideItineraryDocument
  | HotelFolioDocument
  | PaymentSlipDocument
  | OtherVoucherDocument;

export interface ImageFieldExtractionRequest {
  contractVersion: 1;
  images: readonly {
    materialId: string;
    contentHash: string;
    absPath: string;
  }[];
}

export interface ExtractionProvenance {
  adapter: string;
  engineVersion: string;
  model: string;
  durationMs: number;
}

export interface ExtractedImageFields {
  status: "extracted";
  materialId: string;
  contentHash: string;
  document: ExtractedDocument;
  evidence: readonly TextObservation[];
  provenance: ExtractionProvenance;
}

export interface NeedsModelVision {
  status: "needs_model_vision";
  materialId: string;
  contentHash: string;
  reason: "runtime_unavailable" | "unsupported_document" | "insufficient_evidence" | "ocr_failed";
  evidence: readonly TextObservation[];
  provenance?: ExtractionProvenance;
}

export type ImageExtractionFailureCode =
  | "content_changed"
  | "unsupported_format"
  | "image_unavailable"
  | "multiple_documents"
  | "candidate_validation_failed"
  | "worker_protocol_error";

export interface ImageExtractionFailure {
  status: "failed";
  materialId: string;
  contentHash: string;
  error: {
    code: ImageExtractionFailureCode;
    retryable: boolean;
    message: string;
  };
}

export interface ImageFieldExtractionBatch {
  contractVersion: 1;
  items: readonly (ExtractedImageFields | NeedsModelVision | ImageExtractionFailure)[];
  metrics: {
    durationMs: number;
    peakRssBytes: number | null;
  };
}

export interface TextObservation {
  id: string;
  text: string;
  polygon: readonly (readonly [number, number])[];
  score: number;
}

export interface WorkerImageResult {
  materialId: string;
  observations: readonly TextObservation[];
  durationMs: number;
  error?: string;
}
