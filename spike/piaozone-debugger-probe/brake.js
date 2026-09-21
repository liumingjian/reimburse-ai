// The brake. ADR-0025 puts the invoice-consumption boundary at the 发票导入单据 (import invoices into the bill)
// click: everything before it is free and repeatable, that one click is irreversible. A 排练 (rehearsal) must be
// structurally incapable of crossing it, not merely instructed not to.
//
// "Structurally" here means four independent barriers, each of which alone would stop the click:
//
//   1. No code path in this spike names the button. The caption only ever appears in FORBIDDEN_CAPTIONS, and
//      `assertCommandAllowed` refuses any command whose parameters mention it — including a `Runtime.evaluate`
//      expression that would locate it by text and call `.click()`.
//   2. Every synthetic mouse event is hit-tested first, and `assertClickTargetAllowed` refuses the point when
//      `document.elementFromPoint` answers with anything whose text reads as the import control.
//   3. After the upload the run enters phase `readonly`, where every `Input.*` command and every scripted click
//      is refused outright. The last act of the spike is a read.
//   4. The spike never ticks a recognised row. The assistant imports the ticked rows, so even a click that got
//      past 1-3 would have an empty selection. This costs nothing: reading the rows back is what #250 asks for,
//      and ticking them is not.
//
// `selfTest` exercises 1-3 in the panel at load time, so the maintainer sees the brake hold before the run
// starts rather than taking this comment's word for it.

/** The import control, and the near-misses that share its stem. Nothing else in this spike spells them. */
export const FORBIDDEN_CAPTIONS = ['发票导入单据', '导入单据', '数据导入中'];

/** Expression shapes that would synthesise a click from inside the page, bypassing barrier 2. */
const SCRIPTED_CLICK = /\.click\s*\(|dispatchEvent\s*\(\s*new\s+(Mouse|Pointer)Event|\.submit\s*\(/;

export class BrakeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BrakeError';
  }
}

const mentionsForbidden = (text) => FORBIDDEN_CAPTIONS.find((caption) => text.includes(caption)) ?? null;

/**
 * May this CDP command be sent? `phase` is `'drive'` up to and including the upload, `'readonly'` afterwards.
 * Throws `BrakeError` rather than returning a verdict: a brake that can be ignored by not reading its answer is
 * not a brake.
 */
export function assertCommandAllowed(method, params, phase) {
  const payload = JSON.stringify(params ?? {});

  const named = mentionsForbidden(payload);
  if (named) throw new BrakeError(`拒绝发送 ${method}：参数里出现了「${named}」，排练不得触碰导入控件。`);

  // The local-path upload route is not what #250 is measuring, and it is the one route that could reach the
  // assistant's file input without exercising the DataTransfer mechanism under test.
  if (method === 'DOM.setFileInputFiles') {
    throw new BrakeError('拒绝发送 DOM.setFileInputFiles：本次探针只验证 DataTransfer 路径。');
  }

  if (method === 'Runtime.evaluate' && SCRIPTED_CLICK.test(String(params?.expression ?? ''))) {
    throw new BrakeError(`拒绝在页面内合成点击：${method} 表达式包含 click/submit 调用，点击必须经过落点检查。`);
  }

  if (phase === 'readonly') {
    if (method.startsWith('Input.')) {
      throw new BrakeError(`拒绝发送 ${method}：上传完成后探针进入只读阶段，不再产生任何输入事件。`);
    }
    if (method === 'Runtime.callFunctionOn' || method === 'DOM.dispatchEvent') {
      throw new BrakeError(`拒绝发送 ${method}：上传完成后探针进入只读阶段。`);
    }
  }
}

/**
 * May a mouse event be delivered to this point? `hit` is what `document.elementFromPoint` answered there, read in
 * the same session immediately before the click — never a snapshot taken earlier.
 */
export function assertClickTargetAllowed(hit, label) {
  const text = String(hit?.text ?? '');
  const named = mentionsForbidden(text);
  if (named) {
    throw new BrakeError(`拒绝点击${label ? `「${label}」` : ''}：落点上是「${named}」，排练到此为止，没有导入任何发票。`);
  }
}

/** The brake, proved rather than asserted. Returns one row per case for the panel to print. */
export function selfTest() {
  const cases = [
    {
      name: '参数里出现导入控件的名字 -> 拒绝',
      run: () => assertCommandAllowed('Runtime.evaluate', { expression: 'document.title' + FORBIDDEN_CAPTIONS[0] }, 'drive'),
      expect: 'reject',
    },
    {
      name: '页面内合成点击 -> 拒绝',
      run: () => assertCommandAllowed('Runtime.evaluate', { expression: 'document.querySelector("a").click()' }, 'drive'),
      expect: 'reject',
    },
    {
      name: 'DOM.setFileInputFiles（本地路径上传）-> 拒绝',
      run: () => assertCommandAllowed('DOM.setFileInputFiles', { nodeId: 1, files: ['/tmp/a.pdf'] }, 'drive'),
      expect: 'reject',
    },
    {
      name: '只读阶段的鼠标事件 -> 拒绝',
      run: () => assertCommandAllowed('Input.dispatchMouseEvent', { type: 'mousePressed', x: 1, y: 1 }, 'readonly'),
      expect: 'reject',
    },
    {
      name: '落点上是导入控件 -> 拒绝',
      run: () => assertClickTargetAllowed({ text: FORBIDDEN_CAPTIONS[0] }, '测试落点'),
      expect: 'reject',
    },
    {
      name: '正常的只读求值 -> 放行',
      run: () => assertCommandAllowed('Runtime.evaluate', { expression: 'location.href' }, 'readonly'),
      expect: 'allow',
    },
    {
      name: '驱动阶段的落点检查通过 -> 放行',
      run: () => assertClickTargetAllowed({ text: '电脑端选取' }, '电脑端选取'),
      expect: 'allow',
    },
  ];

  return cases.map(({ name, run, expect }) => {
    let outcome = 'allow';
    let detail = '';
    try {
      run();
    } catch (error) {
      outcome = error instanceof BrakeError ? 'reject' : 'error';
      detail = String(error?.message ?? error);
    }
    return { name, expect, outcome, detail, pass: outcome === expect };
  });
}
