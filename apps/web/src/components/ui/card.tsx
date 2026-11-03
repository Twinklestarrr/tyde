import type { ComponentProps } from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cn } from '@/lib/utils';

/** 业务面板共用边框、圆角和内容密度；asChild 保留 section/article 语义。 */
export function Card({
  className,
  asChild = false,
  ...props
}: ComponentProps<'div'> & { asChild?: boolean }) {
  const Component = asChild ? Slot : 'div';
  return (
    <Component
      data-slot="card"
      className={cn('min-w-0 rounded-xl border bg-card text-card-foreground', className)}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-header"
      className={cn('flex flex-col gap-2 border-b p-5', className)}
      {...props}
    />
  );
}

export function CardTitle({
  className,
  asChild = false,
  ...props
}: ComponentProps<'h2'> & { asChild?: boolean }) {
  const Component = asChild ? Slot : 'h2';
  return (
    <Component
      data-slot="card-title"
      className={cn('m-0 min-w-0 break-words text-[16px] leading-6 font-semibold', className)}
      {...props}
    />
  );
}

export function CardDescription({ className, ...props }: ComponentProps<'p'>) {
  return (
    <p
      data-slot="card-description"
      className={cn('text-[13px] leading-5 text-muted-foreground', className)}
      {...props}
    />
  );
}

export function CardContent({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="card-content" className={cn('min-w-0 p-5', className)} {...props} />;
}

export function CardFooter({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-footer"
      className={cn('flex flex-wrap items-center justify-end gap-3 border-t p-5', className)}
      {...props}
    />
  );
}
