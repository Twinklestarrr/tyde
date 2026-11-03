/** 提供全站统一的按钮视觉变体、组合渲染与加载状态。 */
import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { LoaderCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * `Button` 的公共视觉配置：
 * - `default`：主要操作按钮；
 * - `dark`：深色强调操作按钮；
 * - `primaryOutline`：主色描边次级按钮；
 * - `primaryGhost`：主色无边框弱操作按钮；
 * - `outline`：白底描边次级按钮；
 * - `soft`：浅灰底弱操作按钮；
 * - `destructive`：驳回、删除等明确负向操作按钮；
 * - `destructiveOutline`：打开危险操作流程的描边按钮；
 * - `dangerGhost`：危险文字或图标按钮；
 * - `warningOutline`：需要关注但非破坏性的描边按钮；
 * - `success`：完成、接单等明确正向操作按钮；
 * - `successOutline`：成功、通过等正向描边按钮；
 * - `ghost`：弱化背景的次级按钮；
 * - `link`：链接式按钮；
 * - `unstyled`：除全站统一的控件圆角外，不注入或合并其他视觉类。
 * 尺寸统一使用 `xs`、`sm`、`default`、`lg`、`mobileTouch`、`settings`、`account`、`formControl` 和图标尺寸变体。
 * `settings` 对齐个人中心表单，`account` 用于始终保留 44px 点击区域的账户菜单。
 * `formControl` 用于与表单输入框并排的操作，桌面端保持相同高度，移动端保留触控区域。
 * `formCompact` 统一 32px 表单操作，其他密集操作直接复用基础尺寸。
 * `formCompactMobileTouch` 用于桌面 32px、680px 以下移动布局 44px 的紧凑表单操作。
 * `authInline` 用于登录输入框内固定 24px 高度的验证码操作。
 * 一次性的复合控件尺寸保留在调用处，不扩充公共 `size`。
 * `iconCompactMobileTouch` 用于桌面紧凑、移动端仍保留最小触控区域的图标或数字按钮。
 */
const buttonVariants = cva(
  'relative inline-flex items-center justify-center gap-2 whitespace-nowrap text-[12px] font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]',
  {
    variants: {
      variant: {
        default:
          'border-0 bg-[var(--color-primary)] text-white hover:bg-[var(--color-primary-hover)]',
        dark: 'border-0 bg-[var(--color-primary-dark)] text-white shadow-sm hover:bg-[var(--color-primary-dark-hover)]',
        primaryOutline:
          'border border-[var(--color-primary-border)] bg-white text-[var(--color-primary-strong)] hover:bg-[var(--color-primary-soft)] hover:text-[var(--color-primary-strong)]',
        primaryGhost:
          'border-0 bg-transparent text-[var(--color-primary)] hover:bg-[var(--color-primary-soft)] hover:text-[var(--color-primary-strong)]',
        outline:
          'border border-[var(--color-border)] bg-white text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-muted-hover)] hover:text-[var(--color-text-secondary)]',
        soft: 'border-0 bg-[var(--color-surface-muted)] text-[var(--color-text)] hover:bg-[var(--color-surface-muted-hover)] hover:text-[var(--color-text)]',
        destructive:
          'border-0 bg-[var(--color-danger)] text-white shadow-sm hover:bg-[var(--color-danger-hover)]',
        destructiveOutline:
          'border border-[var(--color-danger-border)] bg-transparent text-[var(--color-danger)] hover:bg-[var(--color-danger-soft)] hover:text-[var(--color-danger-strong)]',
        dangerGhost:
          'border-0 bg-transparent text-[var(--color-danger)] hover:bg-[var(--color-danger-soft)] hover:text-[var(--color-danger-strong)]',
        warningOutline:
          'border border-[var(--color-warning-border)] bg-[var(--color-warning-soft)] text-[var(--color-warning)] hover:bg-[var(--color-warning-border)] hover:text-[var(--color-warning-hover)]',
        success:
          'border-0 bg-[var(--color-success)] text-white shadow-sm hover:bg-[var(--color-success-hover)]',
        successOutline:
          'border border-[var(--color-success-border)] bg-[var(--color-success-soft)] text-[var(--color-success)] hover:bg-[var(--color-success-border)] hover:text-[var(--color-success-hover)]',
        ghost:
          'border-0 bg-transparent text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-muted)]',
        link: 'border-0 bg-transparent text-[var(--color-primary)] hover:bg-transparent hover:underline',
        unstyled: '',
      },
      size: {
        // 表格内文字操作与同列正文对齐，不额外引入水平缩进。
        inline: 'h-6 px-0 text-[12px]',
        xs: 'h-7 px-2.5 text-[11px]',
        default: 'h-9 px-4 py-2',
        sm: 'h-8 px-3 text-[12px]',
        lg: 'h-10 px-4 text-[12px]',
        formCompact: 'h-[32px] px-3 text-[12px]',
        formCompactMobileTouch: 'h-[32px] px-3 text-[12px] max-[680px]:h-11',
        authInline: 'h-6 px-1 text-[12px]',
        authSubmit: 'h-[52px] px-4',
        mobileTouch: 'h-[44px] px-4 text-[12px] sm:h-[36px]',
        settings: 'h-[40px] px-[16px] text-[13px] max-[640px]:h-[44px]',
        account: 'h-[44px] px-[12px] text-[13px]',
        formControl: 'h-11 px-5 text-[12px] sm:h-[38px]',
        compactMobileTouch: 'h-11 px-3.5 text-[12px] sm:h-7 sm:px-2.5 sm:text-[11px]',
        iconSm: 'size-8 p-0',
        iconTouch: 'size-11 p-0',
        iconCompactMobileTouch: 'size-11 p-0 sm:size-7',
        iconMobileTouch: 'size-11 p-0 sm:size-9',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

/** `Button` 属性，在原生 button 属性上增加视觉、组合和加载能力。 */
export interface ButtonProps
  extends React.ComponentProps<'button'>, VariantProps<typeof buttonVariants> {
  /** 将行为和样式合并到唯一子元素，适用于链接或其他可交互元素。 */
  asChild?: boolean;
  /** 展示加载图标并阻止重复点击，同时设置 `aria-busy`。 */
  loading?: boolean;
}

/**
 * 全站通用操作按钮，统一基础尺寸、视觉变体、禁用态和提交中的加载反馈。
 * `asChild` 用于把按钮样式安全地应用到链接等单一子元素。
 * `unstyled` 仅保留全站统一圆角，供已有完整业务样式的按钮接入公共 API。
 */
export function Button({
  className,
  variant,
  size,
  asChild = false,
  loading = false,
  disabled,
  children,
  ...props
}: ButtonProps) {
  const buttonClassName =
    variant === 'unstyled'
      ? cn('rounded-lg', className)
      : cn(buttonVariants({ variant, size }), 'rounded-lg', className);

  if (asChild) {
    return (
      <Slot
        data-slot="button"
        className={buttonClassName}
        aria-disabled={disabled || loading ? true : undefined}
        {...props}
      >
        {children}
      </Slot>
    );
  }

  return (
    <button
      {...props}
      data-slot="button"
      type={props.type ?? 'button'}
      className={buttonClassName}
      aria-busy={loading || undefined}
      disabled={disabled || loading}
    >
      {loading && <LoaderCircle className="h-[1em] w-[1em] shrink-0 animate-spin" aria-hidden />}
      {children}
    </button>
  );
}
