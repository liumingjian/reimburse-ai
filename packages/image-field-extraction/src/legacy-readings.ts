import type {
  ExtractedDocument,
  FieldCandidate,
  ImageFieldExtractionBatch,
  Money,
} from "./types.js";

export interface LegacyReadingSubmission {
  version: 1;
  readings: readonly Record<string, unknown>[];
}

export function toLegacyReadings(batch: ImageFieldExtractionBatch): LegacyReadingSubmission {
  return {
    version: 1,
    readings: batch.items
      .filter((item) => item.status === "extracted")
      .map((item) => legacyReading(item.materialId, item.contentHash, item.document)),
  };
}

function legacyReading(materialId: string, contentHash: string, document: ExtractedDocument): Record<string, unknown> {
  return {
    materialId,
    contentHash,
    source: "ocr",
    docType: legacyType(document),
    fields: legacyFields(document),
    ...(document.type === "ride_itinerary" ? { segments: document.fields.segments.map((segment) =>
      values(segment)) } : {}),
    unreadable: missingFields(document),
    clarity: {},
  };
}

function legacyType(document: ExtractedDocument): string {
  if (document.type === "vat_invoice") return "invoice";
  if (document.type === "rail_ticket") return "rail_ticket";
  if (document.type === "road_passenger_ticket") return "road_passenger_ticket";
  if (document.type === "ride_itinerary") return "ride_itinerary";
  if (document.type === "hotel_folio") return "hotel_folio";
  if (document.type === "payment_slip") return "payment_slip";
  return "other";
}

function legacyFields(document: ExtractedDocument): Record<string, string> {
  switch (document.type) {
    case "vat_invoice":
      return values(document.fields);
    case "rail_ticket":
      return values(document.fields, { amount: "totalAmount" });
    case "road_passenger_ticket":
      return values(document.fields, { ticketNumber: "invoiceNumber", amount: "totalAmount" });
    case "ride_itinerary": {
      return values({ traveler: document.fields.traveler, totalAmount: document.fields.totalAmount });
    }
    case "hotel_folio":
      return values(document.fields, {
        checkInDate: "checkIn",
        checkOutDate: "checkOut",
        totalAmount: "folioTotal",
      });
    case "payment_slip":
      return values(document.fields, { amount: "totalAmount" });
    case "other_voucher":
      return values(document.fields, { date: "issueDate", amount: "totalAmount" });
  }
}

function values<T extends object>(
  fields: T,
  rename: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, candidate] of Object.entries(fields) as [string, FieldCandidate<unknown>][]) {
    if (candidate.evidenceState !== "explicit" && candidate.evidenceState !== "derived") continue;
    result[rename[key] ?? key] = printable(candidate.normalized);
  }
  return result;
}

function printable(value: unknown): string {
  if (isMoney(value)) return (value.cents / 100).toFixed(2);
  return String(value);
}

function isMoney(value: unknown): value is Money {
  return typeof value === "object" && value !== null && "currency" in value && "cents" in value;
}

function missingFields(document: ExtractedDocument): string[] {
  if (document.type === "vat_invoice") {
    return isMissing(document.fields.totalAmount) ? ["totalAmount"] : [];
  }
  if (document.type === "ride_itinerary") {
    return Object.entries(document.fields)
      .filter(([key, value]) => key !== "segments" && isMissing(value))
      .map(([key]) => key);
  }
  const rename = document.type === "hotel_folio"
    ? { checkInDate: "checkIn", checkOutDate: "checkOut", totalAmount: "folioTotal" }
    : document.type === "rail_ticket"
      ? { amount: "totalAmount" }
      : document.type === "road_passenger_ticket"
        ? { ticketNumber: "invoiceNumber", amount: "totalAmount" }
        : document.type === "payment_slip"
          ? { amount: "totalAmount" }
          : document.type === "other_voucher"
            ? { date: "issueDate", amount: "totalAmount" }
            : {};
  return Object.entries(document.fields).filter(([, value]) => isMissing(value))
    .map(([key]) => rename[key as keyof typeof rename] ?? key);
}

function isMissing(value: unknown): boolean {
  return typeof value === "object" && value !== null && "evidenceState" in value
    && value.evidenceState === "missing";
}
