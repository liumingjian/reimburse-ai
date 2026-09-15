import type { Layout } from '../layout';
import { einvoice } from './einvoice';

// The 版式 (layout) registry. Adding a layout: one module under `layouts/` exporting a `Layout`, plus one line here.
// Order carries no meaning: dispatch needs exactly one match (ADR-0017), so a new layout whose anchors also hit an
// existing layout's materials shows up as an ambiguity pending item, never as a silent first-match win.
export const LAYOUTS: readonly Layout[] = [
  einvoice,
  // rail_ticket/12306 (#184)
  // ride_itinerary/amap (#184)
  // hotel_folio/quanji (#185)
  // taxi_receipt/machine_printed (#186)
];
