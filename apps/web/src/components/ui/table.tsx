import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

/** 表格只管理视觉密度；滚动和业务列宽保留在调用处。 */
export function Table({ className, ...props }: ComponentProps<'table'>) {
  return (
    <table
      data-slot="table"
      className={cn('w-full border-collapse text-left text-[13px] leading-5', className)}
      {...props}
    />
  );
}
export function TableHeader({ className, ...props }: ComponentProps<'thead'>) {
  return <thead data-slot="table-header" className={cn('bg-muted', className)} {...props} />;
}
export function TableBody({ className, ...props }: ComponentProps<'tbody'>) {
  return (
    <tbody
      data-slot="table-body"
      className={cn('[&_tr:last-child]:border-0', className)}
      {...props}
    />
  );
}
export function TableRow({ className, ...props }: ComponentProps<'tr'>) {
  return (
    <tr
      data-slot="table-row"
      className={cn('border-b transition-colors hover:bg-muted/50', className)}
      {...props}
    />
  );
}
export function TableHead({ className, ...props }: ComponentProps<'th'>) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        'bg-muted px-4 py-3 text-[12px] leading-5 font-medium text-[var(--color-neutral-strong)]',
        className,
      )}
      {...props}
    />
  );
}
export function TableCell({ className, ...props }: ComponentProps<'td'>) {
  return (
    <td
      data-slot="table-cell"
      className={cn('px-4 py-[14px] align-middle text-[13px] leading-5', className)}
      {...props}
    />
  );
}
