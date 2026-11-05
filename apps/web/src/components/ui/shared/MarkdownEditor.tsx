/** 提供项目长文本字段复用的按需所见即所得 Markdown 编辑器与安全只读渲染。 */
import {
  forwardRef,
  lazy,
  Suspense,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type FocusEventHandler,
  type ReactNode,
} from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils';
import type { MarkdownRichEditorProps } from './MarkdownRichEditor';

const MarkdownRichEditor = lazy(() => import('./MarkdownRichEditor'));

/** 公共 Markdown 正文渲染器属性。 */
interface MarkdownPreviewProps {
  /** 待渲染的 Markdown 原文。 */
  value: string;
  /** 正文为空时展示的中性提示。 */
  emptyText?: string;
  /** 预览容器的附加样式。 */
  className?: string;
}

/** 所见即所得 Markdown 编辑器属性。 */
interface MarkdownEditorProps extends MarkdownRichEditorProps {
  /** 编辑器及其可访问关联使用的稳定 ID。 */
  id: string;
  /** 关联的字段说明或错误元素 ID。 */
  ariaDescribedBy?: string;
  /** 是否为必填字段。 */
  ariaRequired?: boolean;
  /** 是否处于校验失败状态。 */
  ariaInvalid?: boolean;
  /** 焦点离开整个编辑器时触发。 */
  onBlur?: FocusEventHandler<HTMLDivElement>;
  /** 编辑器最外层容器的附加样式。 */
  className?: string;
  /** 编辑器占位提示。 */
  placeholder?: ReactNode;
}

/** Markdown 正文的统一排版，原始 HTML 不启用解析，因此不会注入到页面。 */
export function MarkdownPreview({
  value,
  emptyText = '暂无内容。',
  className,
}: MarkdownPreviewProps) {
  if (!value.trim()) {
    return (
      <p className={cn('text-[12px] text-muted-foreground', className)} data-slot="markdown-empty">
        {emptyText}
      </p>
    );
  }

  return (
    <div
      data-slot="markdown-preview-content"
      tabIndex={0}
      className={cn(
        'max-h-[clamp(240px,48dvh,420px)] overflow-y-auto [scrollbar-gutter:stable] min-w-0 break-words text-[13px] leading-[1.75] text-foreground',
        '[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2',
        '[&_blockquote]:my-3 [&_blockquote]:border-l-4 [&_blockquote]:border-primary/35 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground',
        '[&_code]:rounded [&_code]:bg-[var(--code-bg)] [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.92em]',
        '[&_h1]:mt-5 [&_h1]:mb-2 [&_h1]:text-[20px] [&_h1]:font-bold [&_h1]:leading-tight',
        '[&_h2]:mt-4 [&_h2]:mb-2 [&_h2]:text-[17px] [&_h2]:font-bold [&_h2]:leading-tight',
        '[&_h3]:mt-3 [&_h3]:mb-1.5 [&_h3]:text-[15px] [&_h3]:font-semibold',
        '[&_hr]:my-4 [&_hr]:border-border [&_img]:max-w-full',
        '[&_li]:my-1 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-6 [&_p]:my-2',
        '[&_pre]:my-3 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-[var(--code-bg)] [&_pre]:p-3',
        '[&_pre_code]:bg-transparent [&_pre_code]:p-0',
        '[&_table]:my-3 [&_table]:w-full [&_table]:border-collapse [&_table]:text-left',
        '[&_td]:border [&_td]:border-border [&_td]:px-2.5 [&_td]:py-2',
        '[&_th]:border [&_th]:border-border [&_th]:bg-muted [&_th]:px-2.5 [&_th]:py-2 [&_th]:font-semibold',
        '[&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-6',
        '[&_ul.contains-task-list]:list-none [&_ul.contains-task-list]:pl-1',
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a: ({ children, ...props }) => (
            <a {...props} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
        }}
      >
        {value}
      </ReactMarkdown>
    </div>
  );
}

/**
 * 在同一个内容区内编辑并渲染 Markdown；富文本内核按需加载，
 * 加载期间使用只读 Markdown 渲染，避免原文被错误显示或编辑。
 */
export const MarkdownEditor = forwardRef<HTMLDivElement, MarkdownEditorProps>(
  (
    {
      id,
      ariaLabel,
      ariaDescribedBy,
      ariaRequired = false,
      ariaInvalid = false,
      value,
      onValueChange,
      onBlur,
      placeholder,
      disabled = false,
      className,
      contentClassName,
    },
    forwardedRef,
  ) => {
    const containerRef = useRef<HTMLDivElement>(null);

    /** 让表单库能够把无效字段聚焦到真正的富文本输入区域。 */
    useImperativeHandle(forwardedRef, () => {
      if (!containerRef.current) throw new Error('MarkdownEditor 容器尚未挂载');
      return containerRef.current;
    }, []);

    /** 为异步加载的 contenteditable 补齐当前表单的错误、必填和描述语义。 */
    useLayoutEffect(() => {
      const container = containerRef.current;
      if (!container) return;
      const applyAccessibility = () => {
        const editable = container.querySelector<HTMLElement>('[contenteditable], textarea');
        if (!editable) return;
        editable.id = id;
        editable.setAttribute('aria-multiline', 'true');
        editable.setAttribute('aria-required', String(ariaRequired));
        editable.setAttribute('aria-invalid', String(ariaInvalid));
        if (ariaDescribedBy) editable.setAttribute('aria-describedby', ariaDescribedBy);
        else editable.removeAttribute('aria-describedby');
      };
      applyAccessibility();
      const observer = new MutationObserver(applyAccessibility);
      observer.observe(container, { childList: true, subtree: true });
      return () => observer.disconnect();
    }, [ariaDescribedBy, ariaInvalid, ariaRequired, id]);

    /** 根节点被表单错误聚焦时，把光标转交给实际输入区域。 */
    const handleFocus: FocusEventHandler<HTMLDivElement> = (event) => {
      if (event.target !== event.currentTarget) return;
      containerRef.current?.querySelector<HTMLElement>('[contenteditable], textarea')?.focus();
    };

    return (
      <div
        ref={containerRef}
        data-slot="markdown-editor"
        tabIndex={-1}
        onFocus={handleFocus}
        onBlur={onBlur}
        className={cn(
          'overflow-hidden rounded-xl border border-input bg-background shadow-xs outline-none [&_.mdxeditor-contenteditable-wrapper]:min-w-0 [&_.mdxeditor-contenteditable-wrapper]:overflow-x-auto [&_.mdxeditor-contenteditable-wrapper]:bg-muted',
          'focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50',
          ariaInvalid && 'border-destructive ring-destructive/20',
          disabled && 'cursor-not-allowed opacity-60',
          className,
        )}
      >
        <Suspense
          fallback={
            <div
              aria-label={`${ariaLabel}加载中`}
              className={cn('min-h-[120px] bg-muted px-3 py-2', contentClassName)}
            >
              <MarkdownPreview
                value={value}
                emptyText={typeof placeholder === 'string' ? placeholder : '编辑器加载中...'}
              />
            </div>
          }
        >
          <MarkdownRichEditor
            ariaLabel={ariaLabel}
            value={value}
            onValueChange={onValueChange}
            placeholder={placeholder}
            disabled={disabled}
            contentClassName={contentClassName}
          />
        </Suspense>
      </div>
    );
  },
);
MarkdownEditor.displayName = 'MarkdownEditor';
