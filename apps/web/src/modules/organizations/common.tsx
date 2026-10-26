import { useEffect, useId, useRef, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export const orgControlClass =
  'h-[40px] w-full min-w-0 rounded-[8px] border border-input bg-card px-[12px] text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 max-[640px]:h-[44px]';
export const positionLabels = { OWNER: '主管', ADMIN: '管理员', MEMBER: '成员' };
export const employmentLabels = { FULL_TIME: '全职', PART_TIME: '兼职' };
export const joinStatusLabels = {
  PENDING: '待审核',
  PENDING_ACTIVATION: '待激活',
  ACTIVE: '在组',
  EXIT_APPROVING: '退出审批中',
  PENDING_LEAVE: '待离职',
  LEFT: '已离组',
  REMOVED: '已移除',
};

/** 原生模态框负责焦点约束、Esc 和关闭后的焦点恢复。 */
export function OrganizationDialog({
  title,
  onClose,
  busy = false,
  wide = false,
  children,
}: {
  title: string;
  onClose: () => void;
  busy?: boolean;
  wide?: boolean;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => node?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
      className={cn(
        'fixed inset-0 m-auto max-h-[calc(100svh-32px)] w-[calc(100%-32px)] overflow-y-auto rounded-[12px] border bg-card p-[20px] text-foreground shadow-xl backdrop:bg-black/40 sm:p-[24px]',
        wide ? 'max-w-[960px]' : 'max-w-[680px]',
      )}
    >
      <header className="mb-[20px] flex items-center justify-between gap-[16px]">
        <h2 id={titleId} className="m-0 text-[18px] leading-[26px] font-semibold">
          {title}
        </h2>
        <Button
          size="iconTouch"
          variant="ghost"
          aria-label="关闭弹窗"
          disabled={busy}
          onClick={onClose}
        >
          <X className="size-[18px]" aria-hidden />
        </Button>
      </header>
      {children}
    </dialog>
  );
}

export function OrganizationPagination({
  current,
  size,
  total,
  onPageChange,
  loading = false,
}: {
  current: number;
  size: number;
  total: number;
  onPageChange: (page: number) => void;
  loading?: boolean;
}) {
  const pages = Math.max(1, Math.ceil(total / size));
  return (
    <nav
      aria-label="分页"
      className="flex flex-wrap items-center justify-between gap-[12px] border-t pt-[14px] text-[12px] text-[var(--color-neutral-strong)]"
    >
      <span>共 {total} 条记录</span>
      <div className="flex items-center gap-[8px]">
        <span className="mr-[4px] tabular-nums">
          第 {current} / {pages} 页
        </span>
        <Button
          variant="outline"
          size="mobileTouch"
          disabled={loading || current <= 1}
          onClick={() => onPageChange(current - 1)}
        >
          <ChevronLeft className="size-[14px]" aria-hidden />
          上一页
        </Button>
        <Button
          variant="outline"
          size="mobileTouch"
          disabled={loading || current >= pages}
          onClick={() => onPageChange(current + 1)}
        >
          下一页
          <ChevronRight className="size-[14px]" aria-hidden />
        </Button>
      </div>
    </nav>
  );
}

/** 响应时间以上海时间展示，与后端入离组日期语义一致。 */
export function organizationTime(value: string | null | undefined) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(date);
}

export function shanghaiToday() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  return ['year', 'month', 'day']
    .map((type) => parts.find((part) => part.type === type)?.value)
    .join('-');
}
