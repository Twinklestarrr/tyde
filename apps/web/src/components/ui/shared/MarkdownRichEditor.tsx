/** 按需加载的 MDXEditor 内核，仅在项目长文本字段实际渲染时进入页面资源。 */
import {
  headingsPlugin,
  linkDialogPlugin,
  linkPlugin,
  listsPlugin,
  markdownShortcutPlugin,
  MDXEditor,
  type MDXEditorMethods,
  quotePlugin,
  tablePlugin,
  thematicBreakPlugin,
} from '@mdxeditor/editor';
import '@mdxeditor/editor/style.css';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

/** 按需编辑器内核的最小受控属性。 */
export interface MarkdownRichEditorProps {
  /** 编辑器的可访问名称。 */
  ariaLabel: string;
  /** 受控 Markdown 原文。 */
  value: string;
  /** 用户编辑后同步最新 Markdown 原文。 */
  onValueChange: (value: string) => void;
  /** 编辑器占位提示。 */
  placeholder?: ReactNode;
  /** 是否禁止编辑。 */
  disabled?: boolean;
  /** 内容区的附加样式。 */
  contentClassName?: string;
}

/** 构造不带工具栏的 Markdown 编辑能力，保留快捷输入与现有格式解析。 */
function createEditorPlugins() {
  return [
    headingsPlugin(),
    listsPlugin(),
    quotePlugin(),
    thematicBreakPlugin(),
    linkPlugin(),
    linkDialogPlugin(),
    tablePlugin(),
    markdownShortcutPlugin(),
  ];
}

/** 渲染单框所见即所得编辑内核，并将内容持续序列化为 Markdown。 */
export default function MarkdownRichEditor({
  ariaLabel,
  value,
  onValueChange,
  placeholder,
  disabled = false,
  contentClassName,
}: MarkdownRichEditorProps) {
  const editorRef = useRef<MDXEditorMethods>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const lastMarkdownRef = useRef(value);
  const [sourceMode, setSourceMode] = useState(false);
  const plugins = useMemo(() => createEditorPlugins(), []);

  /** 接收取消编辑、Agent 回填等外部快照，同时忽略刚由本编辑器发出的受控回声。 */
  useEffect(() => {
    if (value === lastMarkdownRef.current) return;
    lastMarkdownRef.current = value;
    editorRef.current?.setMarkdown(value);
  }, [value]);

  /** 将连续输入转换回 Markdown 字符串交给现有表单状态。 */
  const handleChange = (markdown: string) => {
    lastMarkdownRef.current = markdown;
    onValueChange(markdown);
  };

  /** 在 Lexical 处理前解析整段粘贴的 Markdown，避免链接语法以原文落入画布。 */
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const handlePaste = (event: ClipboardEvent) => {
      if (disabled || !editorRef.current) return;
      const markdown = event.clipboardData?.getData('text/plain') ?? '';
      const containsMarkdownSyntax =
        /\[[^\]\n]+\]\([^)\n]+\)/.test(markdown) || /^ {0,3}#{1,6}[\t ]+\S.*$/m.test(markdown);
      if (!containsMarkdownSyntax) return;
      event.preventDefault();
      event.stopPropagation();
      editorRef.current?.insertMarkdown(markdown);
    };
    container.addEventListener('paste', handlePaste, { capture: true });
    return () => container.removeEventListener('paste', handlePaste, { capture: true });
  }, [disabled]);

  /** 以当前字段标签命名实际输入区，其他内核文案沿用默认值。 */
  const handleTranslation = (key: string, defaultValue: string) => {
    if (key === 'contentArea.editableMarkdown') return ariaLabel;
    return defaultValue;
  };

  return (
    <div ref={containerRef} className="contents">
      {sourceMode ? (
        <Textarea
          aria-label={ariaLabel}
          value={value}
          disabled={disabled}
          placeholder={typeof placeholder === 'string' ? placeholder : undefined}
          onChange={(event) => handleChange(event.target.value)}
          className={cn('min-h-[120px] w-full rounded-none border-0 shadow-none', contentClassName)}
        />
      ) : (
        <MDXEditor
          ref={editorRef}
          markdown={value}
          onChange={handleChange}
          // 无法导入的历史正文会使内核停止同步编辑；保留完整原文，切换到真实受控输入。
          onError={() => queueMicrotask(() => setSourceMode(true))}
          readOnly={disabled}
          placeholder={placeholder}
          suppressHtmlProcessing
          translation={handleTranslation}
          plugins={plugins}
          className="tyde-markdown-editor"
          contentEditableClassName={cn(
            'tyde-markdown-editor-content max-h-[clamp(240px,48dvh,420px)] overflow-y-auto [scrollbar-gutter:stable] min-h-[120px] max-w-none px-3 py-2 text-[12px] leading-[1.7] text-foreground outline-none [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2 [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto',
            contentClassName,
          )}
        />
      )}
    </div>
  );
}
