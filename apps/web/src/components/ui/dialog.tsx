import { useEffect, useId, useRef, type ComponentProps, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from './button';

const widths = {
  sm: 'max-w-[480px]',
  md: 'max-w-[680px]',
  lg: 'max-w-[960px]',
  xl: 'max-w-[1100px]',
};
let openDialogs = 0;
let previousOverflow = '';

/** 原生模态框统一焦点、关闭规则及固定头尾，表单仍由业务模块控制。 */
export function Dialog({
  title,
  description,
  children,
  footer,
  onClose,
  busy = false,
  size = 'md',
  closeLabel = '关闭弹窗',
  closeOnBackdrop = false,
  className,
  contentClassName,
  contentProps,
  ...props
}: Omit<ComponentProps<'dialog'>, 'title' | 'children' | 'onClose'> & {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  busy?: boolean;
  size?: keyof typeof widths;
  closeLabel?: string;
  closeOnBackdrop?: boolean;
  contentClassName?: string;
  contentProps?: ComponentProps<'div'>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const outside = useRef(false);
  const titleId = useId();
  const descriptionId = useId();
  useEffect(() => {
    const node = ref.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    node?.showModal();
    if (openDialogs++ === 0) previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      node?.close();
      if (--openDialogs === 0) document.body.style.overflow = previousOverflow;
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);
  return (
    <dialog
      {...props}
      ref={ref}
      data-slot="dialog"
      aria-labelledby={props['aria-labelledby'] ?? (props['aria-label'] ? undefined : titleId)}
      aria-describedby={props['aria-describedby'] ?? (description ? descriptionId : undefined)}
      aria-busy={busy || undefined}
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        props.onCancel?.(event);
        if (!busy) onClose();
      }}
      onPointerDown={(event) => {
        props.onPointerDown?.(event);
        const box = event.currentTarget.getBoundingClientRect();
        outside.current =
          event.target === event.currentTarget &&
          (event.clientX < box.left ||
            event.clientX > box.right ||
            event.clientY < box.top ||
            event.clientY > box.bottom);
      }}
      onClick={(event) => {
        props.onClick?.(event);
        if (closeOnBackdrop && !busy && outside.current && event.target === event.currentTarget)
          onClose();
      }}
      className={cn(
        'fixed inset-0 m-auto max-h-[calc(100dvh-32px)] w-[calc(100%-32px)] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden rounded-xl border bg-card p-0 text-foreground shadow-xl backdrop:bg-black/40 open:grid',
        widths[size],
        className,
      )}
    >
      <header
        data-slot="dialog-header"
        className="flex min-w-0 items-start justify-between gap-4 border-b p-5"
      >
        <div className="min-w-0 self-center">
          <h2 id={titleId} className="m-0 break-words text-[18px] leading-[26px] font-semibold">
            {title}
          </h2>
          {description && (
            <div id={descriptionId} className="mt-1 text-[13px] leading-5 text-muted-foreground">
              {description}
            </div>
          )}
        </div>
        <Button
          variant="ghost"
          size="iconTouch"
          className="-my-[9px] -mr-2 shrink-0"
          aria-label={closeLabel}
          disabled={busy}
          onClick={onClose}
        >
          <X className="size-[18px]" aria-hidden />
        </Button>
      </header>
      <div
        {...contentProps}
        data-slot="dialog-content"
        className={cn(
          'min-h-0 min-w-0 space-y-5 overflow-y-auto overscroll-contain p-5 sm:p-6',
          contentClassName,
          contentProps?.className,
        )}
      >
        {children}
      </div>
      {footer != null && (
        <footer
          data-slot="dialog-footer"
          className="flex flex-wrap items-center justify-end gap-3 border-t p-4 sm:px-6"
        >
          {footer}
        </footer>
      )}
    </dialog>
  );
}
