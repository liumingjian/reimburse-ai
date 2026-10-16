import { useState } from 'react';
import { Button, InlineNotification } from '@carbon/react';
import { Copy, Launch } from '@carbon/icons-react';
import { DRAFT_UNVERIFIED_NOTICE, type ErpReview as ErpReviewEntry } from '@baox/contract';
import { ActionGroup } from '../shell/ActionGroup';

// 去报销系统查看 (spec #406): the 暂存单's 内码 with a copy button, and a button that opens the 报销系统 in a new tab. Both
// come from the snapshot's `erp.review`; the page never works out the address. The employee signs in there themselves.
export function ErpReview({ review }: { review: ErpReviewEntry }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(review.draftId);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div data-testid="erp-review">
      <p>
        暂存单内码 <span className="app-code" data-testid="erp-review-draft-id">{review.draftId}</span>
      </p>
      <ActionGroup caption={copied ? '内码已复制，可以粘贴到报销系统里查找这张暂存单。' : '在新标签页打开报销系统，用你自己的账号登录后，按内码找到这张暂存单。'}>
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
export function UnverifiedDraftReview({ review }: { review: ErpReviewEntry }) {
  return (
    <>
      <InlineNotification kind="warning" role="status" lowContrast hideCloseButton statusIconDescription="注意">
        <span data-testid="erp-review-notice">{DRAFT_UNVERIFIED_NOTICE}</span>
      </InlineNotification>
      <ErpReview review={review} />
    </>
  );
}
