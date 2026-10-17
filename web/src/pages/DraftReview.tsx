import { useState } from 'react';
import { Button, InlineNotification } from '@carbon/react';
import { Copy, Launch } from '@carbon/icons-react';
import { DRAFT_UNVERIFIED_NOTICE, type ErpReview } from '@baox/contract';
import { ActionGroup } from '../shell/ActionGroup';

const HINT = '在新标签页打开报销系统，用你自己的账号登录后，到「我的费用报销」里按内码找到这张暂存单。';
const COPIED = '内码已复制，可以粘贴到报销系统里查找这张暂存单。';
const COPY_BY_HAND = '没能复制，请选中上面的内码手动复制。';

// The deployed app is served over plain http (docs/deployment/intranet-phase-1.md), which is no secure context: there
// `navigator.clipboard` is undefined. The older selection copy still works there; false when neither does.
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Refused (no permission, say): try the selection copy.
  }
  return copyBySelection(text);
}

function copyBySelection(text: string): boolean {
  if (typeof document.execCommand !== 'function') return false;
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  try {
    area.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

// 去报销系统查看 (spec #406): the 暂存单's 内码 with a copy button, and a button that opens the 报销系统 in a new tab. Both
// come from the snapshot's `erp.review`; the page never works out the address. The employee signs in there themselves.
// When copying fails the caption asks them to select the 内码, which one click selects whole.
export function DraftReview({ review }: { review: ErpReview }) {
  const [copied, setCopied] = useState<boolean | null>(null);
  const copy = async () => setCopied(await copyText(review.draftId));
  return (
    <div data-testid="erp-review">
      <p>
        暂存单内码 <span className="app-code app-select-all" data-testid="erp-review-draft-id">{review.draftId}</span>
      </p>
      <ActionGroup caption={copied === null ? HINT : copied ? COPIED : COPY_BY_HAND}>
        <Button kind="secondary" size="md" renderIcon={Copy} onClick={() => void copy()}>
          复制内码
        </Button>
        <Button size="md" renderIcon={Launch} href={review.url} target="_blank" rel="noopener noreferrer">
          去报销系统查看
        </Button>
      </ActionGroup>
    </div>
  );
}

// 写入结果不确定 with a known 暂存单 (ticket #408): the draft exists but its check failed, so it needs the employee's
// eyes more than a clean 暂存. Rendered under the existing reason, which stays as it is.
export function UnverifiedDraftReview({ review }: { review: ErpReview }) {
  return (
    <>
      <InlineNotification kind="warning" role="status" lowContrast hideCloseButton statusIconDescription="注意">
        <span data-testid="erp-review-notice">{DRAFT_UNVERIFIED_NOTICE}</span>
      </InlineNotification>
      <DraftReview review={review} />
    </>
  );
}
