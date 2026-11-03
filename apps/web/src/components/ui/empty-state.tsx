import type { ReactNode } from 'react';
import { LoaderCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

/** 列表与面板共享空状态，不把缺少数据伪装成加载中。 */
export function EmptyState({
  title,
  description,
  icon,
  action,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-slot="empty-state"
      className={cn('flex min-w-0 flex-col items-center px-5 py-10 text-center', className)}
    >
      {icon && (
        <div className="mb-3 text-muted-foreground [&_svg]:size-8" aria-hidden>
          {icon}
        </div>
      )}
      <p className="text-[13px] leading-5 font-medium text-[var(--color-neutral-strong)]">
        {title}
      </p>
      {description && (
        <p className="mt-2 max-w-[480px] text-[12px] leading-5 text-muted-foreground">
          {description}
        </p>
      )}
      {action && <div className="mt-4 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}

export function LoadingState({
  children = '正在加载…',
  className,
}: {
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-slot="loading-state"
      role="status"
      className={cn(
        'flex items-center justify-center gap-2 px-5 py-8 text-[13px] leading-5 text-muted-foreground',
        className,
      )}
    >
      <LoaderCircle className="size-4 shrink-0 animate-spin" aria-hidden />
      {children}
    </div>
  );
}
