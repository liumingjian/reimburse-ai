import type { Layout } from '../layout';
import { amapItinerary } from './amap-itinerary';
import { einvoice } from './einvoice';
import { rail12306 } from './rail12306';

// The 版式 (layout) registry. Adding a layout: one module under `layouts/` exporting a `Layout`, plus one line here.
// Order carries no meaning: dispatch needs exactly one match (ADR-0017), so a new layout whose anchors also hit an
// existing layout's materials shows up as an ambiguity pending item, never as a silent first-match win.
export const LAYOUTS: readonly Layout[] = [
  einvoice,
  rail12306,
  amapItinerary,
  // hotel_folio/quanji (#185)
  // taxi_receipt/machine_printed (#186)
];
