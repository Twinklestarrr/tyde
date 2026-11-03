/** 提供与 shadcn 一致 API 的原生多行文本输入组件。 */
import * as React from 'react';

import { cn } from '@/lib/utils';

interface TextareaProps extends React.ComponentProps<'textarea'> {
  /** 使用默认透明底或统一的弱化表单底色。 */
  variant?: 'default' | 'muted';
}

/** 渲染带统一主题、焦点、错误与禁用状态的多行文本输入框。 */
const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, variant = 'default', ...props }, ref) => {
    return (
      <textarea
        data-slot="textarea"
        className={cn(
          'flex min-h-[80px] w-full rounded-lg border border-input px-3 py-2 text-[13px] leading-5 text-foreground shadow-none outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 aria-invalid:border-destructive aria-invalid:ring-destructive/20 disabled:cursor-not-allowed disabled:opacity-50',
          variant === 'muted' ? 'bg-[var(--color-surface-muted)]' : 'bg-transparent',
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Textarea.displayName = 'Textarea';

export { Textarea };
