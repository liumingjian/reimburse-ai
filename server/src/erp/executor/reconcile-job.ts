// The read-only 对账 (reconcile) job of the v1 in-process executor (ADR-0016): Chromium ready -> login probe ->
// one read of the open expense form -> `readback` (stage `reconcile`) -> `result` `read`.
// It only evaluates: no click, key, scroll, navigation, upload or attempt. Origin: 50931a3:kernel/src/erpreconcile.mjs
// readReconciliation (collection half); the judgement is the server's (server/src/erp/reconcile.ts).
// The lazily rendered detail grid is not opened: opening it is a page side effect, and reconcile changes nothing.

import { ReconcilePlanSchema, type ExecutorChannel, type ResultEvent, type ResultStatus } from '../protocol';
import { evalIn, type CdpSession } from './cdp';
import type { ChromiumPage } from './chromium';
import type { BrowserPort } from './job';
import { DEFAULT_PACE, type Pace } from './pace';
import { probeIdentity, sameOrigin } from './probe';
import { protocolReadings, readForm } from './reader';

export type ReconcilePorts = { browser: BrowserPort; channel: ExecutorChannel; pace?: Pace; probeWaitMs?: number };

export async function runReconcileJob(rawPlan: unknown, ports: ReconcilePorts): Promise<ResultEvent> {
  const plan = ReconcilePlanSchema.parse(rawPlan);
  const { browser, channel } = ports;
  const pace = ports.pace ?? DEFAULT_PACE;
  const attached = new Map<string, ChromiumPage & { session: CdpSession }>();
  let currentStep: 'chromium' | 'login' | 'readback' | null = null;

  const step = async (name: 'chromium' | 'login' | 'readback', status: 'running' | 'done' | 'failed') => {
    currentStep = status === 'running' ? name : null;
    await channel.emit({ type: 'step', step: name, status });
  };
  const finish = async (status: ResultStatus, code: string | null, message: string | null, billNo: string | null = null) => {
    if (currentStep && status !== 'read') await step(currentStep, 'failed');
    // Nothing was written, so there is no ERP error to capture: a failed reconcile is simply retried.
    const event: ResultEvent = { type: 'result', status, code, message, billNo, capture: null };
    await channel.emit(event);
    return event;
  };
  const attach = async (page: ChromiumPage) => {
    const key = String(page.cdpTargetId ?? page.url);
    if (!attached.has(key)) attached.set(key, await browser.attach(page));
    return attached.get(key)!;
  };

  try {
    await step('chromium', 'running');
    const pages = (await browser.listPages()).filter((page) => sameOrigin(page.url, plan.erpOrigin));
    await step('chromium', 'done');

    await step('login', 'running');
    const probe = await probeIdentity({
      origin: plan.erpOrigin, waitMs: ports.probeWaitMs ?? 30_000, pollMs: pace.pollMs, transport: 'chromium-cdp',
      listTabs: async () => pages,
      evaluate: async (page, expression) => evalIn((await attach(page as ChromiumPage)).session, expression, { timeout: 10_000 }),
    });
    if (probe.status === 'not_logged_in' || probe.status === 'no_tab') {
      await step('login', 'done');
      await channel.emit({ type: 'waiting_login', hint: probe.hint ?? '' });
      return await finish('waiting_login', 'erp_login', probe.hint ?? null);
    }
    if (probe.status !== 'matched' || !probe.page) return await finish('aborted', `erp_login_${probe.status}`, probe.hint ?? null);
    const { session } = await attach(probe.page as ChromiumPage);
    await step('login', 'done');

    await step('readback', 'running');
    const form = await readForm(session);
    const readings = protocolReadings(form);
    // Which form was read: the server compares the form-instance UUID and the CDP target with the fill's attempt.
    const target = { formInstanceId: form.formInstanceId, targetId: probe.page.cdpTargetId === undefined ? null : String(probe.page.cdpTargetId) };
    await channel.emit({ type: 'readback', stage: 'reconcile', readings, form: target });
    await step('readback', 'done');
    return await finish('read', null, null, readings.billNo.value);
  } catch (error: any) {
    return await finish('aborted', error?.code ?? 'executor_error', error?.message ?? String(error));
  } finally {
    for (const page of attached.values()) { try { page.session.close(); } catch { /* already closed */ } }
  }
}
