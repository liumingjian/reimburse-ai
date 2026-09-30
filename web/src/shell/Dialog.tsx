import type { ReactNode } from 'react';
import { Button, ComposedModal, ModalBody, ModalFooter, ModalHeader } from '@carbon/react';

// 页内二次确认弹层（Carbon ComposedModal），不用 window.confirm。Esc、点遮罩、关闭按钮与「取消」都关闭；
// 打开时焦点落到取消按钮（表单弹层传 focusCancel={false}，由带 data-modal-primary-focus 的输入框接住焦点）。
export const DIALOG_CLOSE_LABEL = '关闭';

// Carbon's defaults, plus the full-screen 原件 view (DocFullscreen): it opens over a dialog (住宿材料 on the project
// page) from a portal, so the dialog's focus trap must let focus into it.
const FLOATING_MENUS = ['.cds--overflow-menu-options', '.cds--tooltip', '.flatpickr-calendar', '.app-doc-fullscreen'];

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
  danger = false,
}: {
  focusCancel?: boolean;
  // 危险变体：破坏性、不可撤销的确认（作废任务、完全重置）。Carbon danger modal，确认按钮用红色 danger 按钮。
  danger?: boolean;
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
  const primaryFocus = focusCancel ? { 'data-modal-primary-focus': true } : {};
  return (
    <ComposedModal
      open
      danger={danger}
      size={wide ? 'lg' : 'sm'}
      aria-label={title}
      preventCloseOnClickOutside={false}
      selectorsFloatingMenus={FLOATING_MENUS}
      onClose={() => onCancel()}
    >
      <ModalHeader title={title} iconDescription={DIALOG_CLOSE_LABEL} />
      <ModalBody>
        {children}
        {error ? (
          <p className="app-dialog-error" role="alert">
            {error}
          </p>
        ) : null}
      </ModalBody>
      <ModalFooter>
        {single ? (
          <Button kind="secondary" disabled={busy} onClick={onConfirm} {...primaryFocus}>
            {confirmLabel}
          </Button>
        ) : (
          <>
            <Button kind="secondary" disabled={busy} onClick={onCancel} {...primaryFocus}>
              {cancelLabel}
            </Button>
            {extraLabel && onExtra ? (
              <Button kind="secondary" disabled={busy} onClick={onExtra}>
                {extraLabel}
              </Button>
            ) : null}
            <Button kind={danger ? 'danger' : 'primary'} disabled={busy} onClick={onConfirm}>
              {confirmLabel}
            </Button>
          </>
        )}
      </ModalFooter>
    </ComposedModal>
  );
}

// 「追加材料」的二次确认：文案在两个入口（整单明细确认页、上传页）共用。
export const REOPEN_DIALOG = {
  title: '追加材料会形成新的盘点版本',
  body: '追加材料将使整单明细确认失效：已有的盘点结果和待确认项答复要重新形成，已生成的打印稿作废。继续后回到上传页追加新批次。',
  confirm: '继续追加',
} as const;
