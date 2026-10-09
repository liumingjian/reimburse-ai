import type { Layout } from '../layout';
import { amapItinerary } from './amap-itinerary';
import { einvoice } from './einvoice';
import { diningReceipt } from './dining-receipt';
import { labelled } from './labelled';
import { paymentScreenshot } from './payment-screenshot';
import { rail12306 } from './rail12306';
import { machinePrinted } from './taxi';

// The 版式 (layout) registry. Adding a layout: one module under `layouts/` exporting a `Layout`, plus one line here.
// Order carries no meaning: dispatch needs exactly one match (ADR-0017), so a new layout whose anchors also hit an
// existing layout's materials shows up as an ambiguity pending item, never as a silent first-match win.
export const LAYOUTS: readonly Layout[] = [
  einvoice,
  rail12306,
  amapItinerary,
  labelled,
  machinePrinted,
  paymentScreenshot,
  diningReceipt,
];
