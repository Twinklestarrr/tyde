import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from './button';

/** 所有列表使用相同的计数、翻页反馈和移动端触控尺寸。 */
export function Pagination({
  current,
  size = 20,
  total,
  pages = Math.ceil(total / size),
  onPageChange,
  loading = false,
  'aria-label': ariaLabel = '分页',
}: {
  current: number;
  size?: number;
  total: number;
  pages?: number;
  onPageChange: (page: number) => void;
  loading?: boolean;
  'aria-label'?: string;
}) {
  const pageCount = Math.max(1, pages);
  return (
    <nav
      data-slot="pagination"
      aria-label={ariaLabel}
      aria-busy={loading || undefined}
      className="flex flex-wrap items-center justify-between gap-3 border-t pt-4 text-[12px] leading-5 text-[var(--color-neutral-strong)]"
    >
      <span>共 {total} 条记录</span>
      <div className="flex items-center gap-2">
        <span className="mr-1 tabular-nums">
          第 {current} / {pageCount} 页
        </span>
        <Button
          variant="outline"
          size="mobileTouch"
          disabled={loading || current <= 1}
          onClick={() => onPageChange(current - 1)}
        >
          <ChevronLeft className="size-[14px]" aria-hidden />
          上一页
        </Button>
        <Button
          variant="outline"
          size="mobileTouch"
          disabled={loading || current >= pageCount}
          onClick={() => onPageChange(current + 1)}
        >
          下一页
          <ChevronRight className="size-[14px]" aria-hidden />
        </Button>
      </div>
    </nav>
  );
}
