import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';

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
  const ref = useRef<HTMLDialogElement>(null);
  const outside = useRef(false);
  useEffect(() => {
    const node = ref.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    node?.showModal();
    document.body.style.overflow = 'hidden';
    return () => {
      node?.close();
      document.body.style.overflow = overflow;
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);
  return (
    <dialog
      ref={ref}
      aria-label={label}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
      onPointerDown={(event) => {
        const box = event.currentTarget.getBoundingClientRect();
        outside.current =
          event.target === event.currentTarget &&
          (event.clientX < box.left ||
            event.clientX > box.right ||
            event.clientY < box.top ||
            event.clientY > box.bottom);
      }}
      onClick={(event) => {
        if (!busy && outside.current && event.target === event.currentTarget) onClose();
      }}
      className="fixed inset-0 m-auto max-h-[calc(100dvh-32px)] w-[calc(100%-32px)] max-w-[1100px] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden rounded-[16px] border bg-card p-0 text-foreground shadow-xl backdrop:bg-black/40 open:grid"
    >
      <header className="flex min-w-0 items-center justify-between gap-4 border-b p-5">
        <h2 className="min-w-0 break-words text-lg font-semibold">{title}</h2>
        <Button
          variant="ghost"
          size="iconTouch"
          aria-label={`关闭${label}`}
          disabled={busy}
          onClick={onClose}
        >
          <X className="size-4" aria-hidden />
        </Button>
      </header>
      <div className="min-h-0 min-w-0 space-y-5 overflow-y-auto overscroll-contain p-4 sm:p-6">
        {children}
      </div>
      <footer className="flex flex-wrap items-center justify-end gap-3 border-t p-4">
        {footer ?? (
          <Button variant="outline" size="account" disabled={busy} onClick={onClose}>
            关闭
          </Button>
        )}
      </footer>
    </dialog>
  );
}
