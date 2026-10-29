/** 提供可保持业务原有视觉的通用文本输入框。 */
import { cn } from '@/lib/utils';
import { inputSizeClassNames, type InputSize } from './input-size';

export type { InputSize };

/** 公共输入框的视觉模式。 */
type InputVariant = 'default' | 'muted' | 'unstyled';

/** `Input` 属性，在原生输入框能力上增加可选的公共视觉模式。 */
export interface InputProps extends Omit<React.ComponentProps<'input'>, 'size'> {
  /** `default` 使用公共基础视觉；`unstyled` 完整保留调用方传入的业务样式。 */
  variant?: InputVariant;
  /** 控制输入框高度、水平间距与字体大小，默认使用中等尺寸。 */
  size?: InputSize;
}

/**
 * 全站通用文本输入框，保留全部原生输入能力和 ref 透传。
 * 日期和日期时间输入点击主体即可打开原生日历。
 * 迁移已有页面时可使用 `unstyled`，避免公共默认样式改变原页面视觉。
 */
export function Input({
  className,
  variant = 'default',
  size = 'md',
  type = 'text',
  onClick,
  ...props
}: InputProps) {
  const inputClassName =
    variant === 'unstyled'
      ? className
      : cn(
          'w-full min-w-0 rounded-xl border border-input text-foreground shadow-xs outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60',
          'aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/20',
          variant === 'muted' ? 'bg-[var(--color-surface-muted)]' : 'bg-transparent',
          inputSizeClassNames[size],
          className,
        );

  return (
    <input
      data-slot="input"
      data-size={size}
      type={type}
      className={inputClassName}
      {...props}
      onClick={(event) => {
        onClick?.(event);
        const input = event.currentTarget;
        if (
          event.defaultPrevented ||
          (type !== 'date' && type !== 'datetime-local') ||
          input.readOnly ||
          input.matches(':disabled')
        )
          return;
        try {
          input.showPicker?.();
        } catch {
          // 浏览器拒绝打开时保留原生输入和日历图标操作。
        }
      }}
    />
  );
}
