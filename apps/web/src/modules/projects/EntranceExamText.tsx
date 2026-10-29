import { useMemo } from 'react';

/** 历史富文本在惰性模板中提取文字；不执行脚本、不装载外部图片或渲染任意HTML。 */
export function EntranceExamText({
  value,
  empty = '未填写',
}: {
  value: string | null;
  empty?: string;
}) {
  const text = useMemo(() => {
    if (!value) return empty;
    const template = document.createElement('template');
    template.innerHTML = value
      .replace(/<br\s*\/?\s*>/gi, '\n')
      .replace(/<\/(?:p|div|li|h[1-6])\s*>/gi, '\n');
    template.content.querySelectorAll('script,style,template').forEach((node) => node.remove());
    return template.content.textContent?.trim() || empty;
  }, [value, empty]);
  return <div className="whitespace-pre-wrap break-words text-[13px] leading-6">{text}</div>;
}
