import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';

export const ENTRANCE_EXAM_LEAVE_REQUEST = 'tyde:before-entrance-exam-leave';

/** 考试配置、名单与阅卷共用当前主题的弹框，保留背景项目及其草稿。 */
export function EntranceExamDialog({
  label,
  title,
  children,
  footer,
  onClose,
  busy = false,
}: {
  label: string;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  busy?: boolean;
}) {
  return (
    <Dialog
      title={title}
      aria-label={label}
      closeLabel={`关闭${label}`}
      size="xl"
      busy={busy}
      onClose={onClose}
      closeOnBackdrop
      contentClassName="space-y-[24px]"
      footer={
        footer ?? (
          <Button variant="outline" size="account" disabled={busy} onClick={onClose}>
            关闭
          </Button>
        )
      }
    >
      {children}
    </Dialog>
  );
}
