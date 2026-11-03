import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** 页头统一标题层级、说明和响应式操作区；业务特有导航由 children 承接。 */
export function PageHeader({
  title,
  description,
  icon,
  actions,
  children,
  className,
  ...props
}: Omit<ComponentProps<'header'>, 'title'> & {
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header data-slot="page-header" className={cn('space-y-4 py-1', className)} {...props}>
      {children}
      <div className="flex flex-col items-start gap-4 min-[900px]:flex-row min-[900px]:items-center">
        <div className="min-w-0 flex-1">
          <h1 className="m-0 flex items-center gap-[10px] text-[24px] leading-[34px] font-semibold tracking-tight">
            {icon && (
              <span
                className="shrink-0 text-[var(--color-primary-strong)] [&_svg]:size-[22px]"
                aria-hidden
              >
                {icon}
              </span>
            )}
            {title}
          </h1>
          {description && (
            <p className="mt-1 max-w-[680px] text-[13px] leading-[21px] text-[var(--color-neutral-strong)]">
              {description}
            </p>
          )}
        </div>
        {actions && (
          <div className="flex w-full flex-wrap gap-2 min-[900px]:ml-auto min-[900px]:w-auto">
            {actions}
          </div>
        )}
      </div>
    </header>
  );
}
