import { afterEach, describe, expect, it } from 'vitest';
import { sample } from '../test/api';
import { workerExecutor, type ParseExecutor } from './executor';

// Parser job memory (#186): the OCR models load only when the parse worker meets its first image, and go away with the
// worker once it has been idle, i.e. when the job has ended.

let executor: ParseExecutor | null = null;
afterEach(async () => {
  await executor?.close();
  executor = null;
});

const input = (prefix: string, materialId: string) => {
  const file = sample(prefix);
  return { materialId, fileName: file.name, mime: file.name.endsWith('.pdf') ? 'application/pdf' : 'image/jpeg', bytes: new Uint8Array(file.bytes) };
};

async function until(condition: () => boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('OCR in the parse worker', () => {
  it('is not loaded before the first image and is released after the job', async () => {
    const worker = workerExecutor({ idleMs: 200 });
    executor = worker;
    expect(worker.state()).toEqual({ running: false, ocrLoaded: false });

    expect(await worker.parse(input('m01', 'm1'))).toMatchObject({ outcome: 'recognised' });
    expect(worker.state()).toEqual({ running: true, ocrLoaded: false });

    expect(await worker.parse(input('m09', 'm2'))).toMatchObject({ outcome: 'recognised', kind: 'taxi_receipt', layout: 'machine_printed' });
    expect(worker.state()).toEqual({ running: true, ocrLoaded: true });

    await until(() => !worker.state().running);
    expect(worker.state()).toEqual({ running: false, ocrLoaded: false });
  }, 120_000);
});

describe('the parse worker released after idling', () => {
  // A worker released after its idle time exits a moment later. Work posted to the next worker in between (a new
  // inventory run started right as the last one went idle) is that worker's: the old one's exit must not fail it.
  it('does not fail work posted to the next worker when it exits', async () => {
    const worker = workerExecutor({ idleMs: 50 });
    executor = worker;
    expect(await worker.parse(input('m01', 'm1'))).toMatchObject({ outcome: 'recognised' });
    while (worker.state().running) await new Promise((resolve) => setImmediate(resolve));

    expect(await worker.parse(input('m02', 'm2'))).toMatchObject({ outcome: 'recognised', kind: 'hotel_folio' });
  }, 120_000);
});

