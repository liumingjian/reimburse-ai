// The recording session: a `CdpSession` that forwards to the live page and, just before every mouse press, marks the
// element the press will land on and captures the whole page. A flow drives it exactly as the executor drives ERP
// (it IS executor code, `steps.ts` and friends), so the pages recorded are the pages the executor really passes
// through, and each carries the element that moved it on.
//
// Child frames (the 发票无忧助手 (invoice assistant) is a cross-origin iframe, its own CDP target) are captured with
// every page, and a press sent into one is marked and guarded in that frame, the same way as a press on the page.
//
// It is also the consumption guard. Recording must never save, submit or import anything in ERP (ADR-0025 puts the
// boundary at 发票导入单据), so a press whose target reads as one of those commands is refused BEFORE it is sent,
// and so are the inputs a flow did not declare it needs: keys, file uploads, text insertion.

import { evalIn, type CdpSession } from '../cdp';
import { ExecutorError } from '../page';
import { CAPTURE_SNIPPET, markClickTarget, UNMARK_SNIPPET, type CapturedPage, type ClickTarget } from './capture';

/** Where the click that left a page landed: on the page itself, or inside its child frame. */
export type RecordedClick = ClickTarget & { frame?: 'child' };

/** A page, and the child frame attached to it when there is one (the assistant). */
export type RecordedStep = { name: string; page: CapturedPage; child?: CapturedPage; click?: RecordedClick };

/**
 * Captions and control ids of the commands that change what ERP holds: 保存 (save), 暂存 (hold), 提交 (submit),
 * 审核 (approve), 导入 (import, 发票导入单据 included), 删除 (delete), 作废 (void). Matched against the pressed
 * element and its nearest control.
 */
export const CONSUMPTION_BOUNDARY = /保存|暂存|提交|审核|导入|删除|作废|tbSave|tbSubmit|tbAudit|tbImport|tbDelete|tbCancel/i;

/** Why a press at this target would cross the consumption boundary, or null when it does not. */
export function crossesBoundary(target: ClickTarget | null): string | null {
  if (!target) return null;
  // The nearest control's text is only trusted when it is a caption; a container with an id reads as all its items.
  const texts = [target.text, target.controlText.length <= 20 ? target.controlText : ''];
  const hit = [...texts, target.id, target.controlId].find((value) => value && CONSUMPTION_BOUNDARY.test(value));
  return hit ? `${target.tag}「${target.text || target.controlText}」(${target.controlId || target.id || 'no id'})` : null;
}

export type RecordingSession = CdpSession & {
  readonly steps: RecordedStep[];
  /** Capture the page as it is now, as a named step (the page a flow ends on). */
  snapshot(name: string): Promise<void>;
  /**
   * Stop capturing: what the flow does afterwards (closing the assistant it opened) is not part of the recording.
   * The guard stays on.
   */
  stop(): void;
};

export function recordingSession(live: CdpSession, { allowKeys = false }: { allowKeys?: boolean } = {}): RecordingSession {
  const steps: RecordedStep[] = [];
  let recording = true;
  // Child targets by session id, as auto-attach announces them. Only a flow's own `autoAttach` turns that on.
  const children = new Set<string>();
  live.on?.('Target.attachedToTarget', (params) => { children.add(String(params['sessionId'])); });
  live.on?.('Target.detachedFromTarget', (params) => { children.delete(String(params['sessionId'])); });
  const inChild = (sessionId: string): CdpSession => ({
    send: (method, params = {}, options = {}) => live.send(method, params, { ...options, sessionId }),
    close: () => {},
  });
  const read = async (session: CdpSession) => JSON.parse(await evalIn<string>(session, CAPTURE_SNIPPET, { timeout: 60_000 })) as CapturedPage;
  /** The page and its one live child frame. More than one would be a page this recorder was not built for. */
  const capture = async (): Promise<Pick<RecordedStep, 'page' | 'child'>> => {
    const page = await read(live);
    const frames: CapturedPage[] = [];
    for (const sessionId of children) {
      const frame = await read(inChild(sessionId)).catch(() => null);
      if (frame) frames.push(frame);
    }
    if (frames.length > 1) throw new Error(`${frames.length} child frames are attached; a recorded page holds one`);
    return frames[0] ? { page, child: frames[0] } : { page };
  };
  const refuse = (what: string): never => {
    throw new ExecutorError('RECORDING_REFUSED', `录制不会${what}：这一步越过了录制允许的范围，已停下，ERP 没有被改动。`);
  };

  return {
    steps,
    async snapshot(name) {
      steps.push({ name, ...(await capture()) });
    },
    stop() {
      recording = false;
    },
    async send(method, params = {}, options = {}) {
      if (method === 'DOM.setFileInputFiles' || method === 'Input.insertText') refuse('上传文件或插入文本');
      if (method === 'Input.dispatchKeyEvent' && !allowKeys) refuse('按键');
      if (method === 'Input.dispatchMouseEvent' && params['type'] === 'mousePressed') {
        const where = options.sessionId ? inChild(options.sessionId) : live;
        const target = JSON.parse(await evalIn<string>(where, markClickTarget(Number(params['x']), Number(params['y'])))) as ClickTarget | null;
        try {
          const crossing = crossesBoundary(target);
          if (crossing) refuse(`点击 ${crossing}`);
          if (recording) {
            const click = target ? { click: { ...target, ...(options.sessionId ? { frame: 'child' as const } : {}) } } : {};
            steps.push({ name: `page-${steps.length + 1}`, ...(await capture()), ...click });
          }
        } finally {
          await evalIn(where, UNMARK_SNIPPET).catch(() => undefined);
        }
      }
      return live.send(method, params, options);
    },
    ...(live.on ? { on: live.on.bind(live) } : {}),
    close: () => live.close(),
  };
}
