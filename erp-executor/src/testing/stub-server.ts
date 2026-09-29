// The server's end of the job protocol, stubbed for executor tests: it records every event, acknowledges
// `attempt_started` as persisted, answers the `after_import` read-back with an approved preview, and approves every
// later read-back. Judging read-backs is the server's job (ADR-0016) and is tested there (server/src/erp); this
// stub keeps it out of the way, so an executor test sees only what the executor decides and what the page shows.

import type { ApprovedPreview, AttemptStartedEvent, ExecutorChannel, ExecutorEvent, ReadbackEvent, ReadbackVerdict } from '../protocol';
import { approvedPreview, freshGateOf } from './scenario';

export type StubServer = {
  channel: ExecutorChannel;
  /** Every event the executor emitted, in order. */
  events: ExecutorEvent[];
  /** The attempts the server acknowledged, in order. */
  attempts: AttemptStartedEvent[];
};

export function stubServer({ taskId, preview = approvedPreview(taskId), judge = () => ({ ok: true }) }: {
  taskId: string;
  preview?: ApprovedPreview;
  /** The verdict for read-backs after the import. */
  judge?: (event: ReadbackEvent) => ReadbackVerdict;
}): StubServer {
  const events: ExecutorEvent[] = [];
  const attempts: AttemptStartedEvent[] = [];
  const emit = async (event: ExecutorEvent) => {
    events.push(event);
    if (event.type === 'attempt_started') {
      attempts.push(event);
      return { persisted: true };
    }
    if (event.type === 'readback') {
      if (event.stage !== 'after_import') return judge(event);
      return { ok: true, preview, approval: { digest: preview.previewDigest!, preview: structuredClone(preview) }, freshGate: freshGateOf(preview) };
    }
    return undefined;
  };
  return { channel: { emit: emit as ExecutorChannel['emit'] }, events, attempts };
}
