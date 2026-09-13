import { useEffect, useId, useRef, type ReactNode } from 'react';

// 页内二次确认弹层：遮罩用 overlay token，不用 window.confirm。Esc、点遮罩、「取消」都关闭；打开时焦点落到取消按钮。

export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  cancelLabel = '取消',
  busy = false,
  error = null,
  extraLabel,
  onExtra,
  onConfirm,
  onCancel,
  focusCancel = true,
  wide = false,
  single = false,
}: {
  focusCancel?: boolean;
  // 宽弹层：放整块面板（如项目归属页就地新增项目的项目簿面板）。
  wide?: boolean;
  // 只留一个关闭按钮（confirmLabel，次要样式，点它走 onConfirm）：弹层里的面板自带主按钮，不再放第二个主按钮。
  single?: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  busy?: boolean;
  error?: string | null;
  // 可选的第三个选项（如项目归属冲突的「只处理未归属」），排在取消与确认之间。
  extraLabel?: string;
  onExtra?: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);

  // 只在打开时落一次焦点（onCancel 变化不再抢焦点）；表单弹层传 focusCancel={false}，由输入框自己 autoFocus。
  useEffect(() => {
    if (focusCancel) cancelRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div className="modal-scrim" onClick={onCancel} data-testid="modal-scrim">
      <div className={wide ? 'modal modal-wide' : 'modal'} role="dialog" aria-modal="true" aria-labelledby={titleId} onClick={(event) => event.stopPropagation()}>
        <h2 id={titleId}>{title}</h2>
        <div className="modal-body">{children}</div>
        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="btn-row">
          {single ? (
            <button ref={cancelRef} className="btn btn-secondary" type="button" disabled={busy} onClick={onConfirm}>
              {confirmLabel}
            </button>
          ) : (
            <>
              <button ref={cancelRef} className="btn btn-secondary" type="button" disabled={busy} onClick={onCancel}>
                {cancelLabel}
              </button>
              {extraLabel && onExtra ? (
                <button className="btn btn-secondary" type="button" disabled={busy} onClick={onExtra}>
                  {extraLabel}
                </button>
              ) : null}
              <button className="btn btn-primary" type="button" disabled={busy} onClick={onConfirm}>
                {confirmLabel}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// 「追加材料」的二次确认：文案在两个入口（整单明细确认页、上传页）共用。
export const REOPEN_DIALOG = {
  title: '追加材料会形成新的盘点版本',
  body: '追加材料将使整单明细确认失效：已有的盘点结果和待确认项答复要重新形成，已生成的打印稿作废。继续后回到上传页追加新批次。',
  confirm: '继续追加',
} as const;
