import { useEffect, useRef, useState } from 'react';
import { ChevronDown, X } from 'lucide-react';
import type { ProjectCategory } from '@tyde/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/** 三级类型使用可搜索多选下拉，沿用独立级别字典和数字 ID。 */
export function ProjectCategoryMultiSelect({
  id,
  value,
  options,
  onChange,
  onBlur,
  controlRef,
  invalid,
  describedBy,
}: {
  id: string;
  value: number[];
  options: ProjectCategory[];
  onChange: (value: number[]) => void;
  onBlur: () => void;
  controlRef: (node: HTMLButtonElement | null) => void;
  invalid: boolean;
  describedBy?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const candidates = options.filter((option) => option.categoryLevel === 3);
  const visible = candidates.filter((option) =>
    option.categoryName.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
  );

  function close() {
    setOpen(false);
    setSearch('');
  }

  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    function outside(event: PointerEvent) {
      if (event.target instanceof Node && !container.current?.contains(event.target)) close();
    }
    function escape(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      close();
      trigger.current?.focus();
    }
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  return (
    <div
      ref={container}
      className="min-w-0"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          close();
          onBlur();
        }
      }}
    >
      <div className="relative">
        <div
          className={cn(
            'flex min-h-[40px] min-w-0 flex-wrap items-center gap-[6px] rounded-xl border border-input px-[8px] py-[4px] shadow-sm focus-within:ring-1 focus-within:ring-ring',
            invalid && 'border-destructive',
          )}
        >
          {value.map((categoryId) => {
            const label =
              candidates.find((option) => option.id === categoryId)?.categoryName ??
              String(categoryId);
            return (
              <span
                key={categoryId}
                className="inline-flex max-w-full items-center rounded-md bg-accent pl-[8px] text-[12px] text-accent-foreground"
              >
                <span className="truncate">{label}</span>
                <Button
                  variant="ghost"
                  size="iconCompactMobileTouch"
                  aria-label={`移除 ${label}`}
                  onClick={() => onChange(value.filter((item) => item !== categoryId))}
                >
                  <X className="size-[14px]" aria-hidden />
                </Button>
              </span>
            );
          })}
          <Button
            id={id}
            ref={(node) => {
              trigger.current = node;
              controlRef(node);
            }}
            variant="unstyled"
            className="flex min-h-[32px] min-w-[140px] flex-1 items-center justify-between gap-[8px] px-[4px] text-left text-[13px] text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring max-[640px]:min-h-[36px]"
            role="combobox"
            aria-label="三级项目类型"
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-controls={open ? `${id}-options` : undefined}
            aria-required
            aria-invalid={invalid || undefined}
            aria-describedby={describedBy}
            onClick={() => (open ? close() : setOpen(true))}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setOpen(true);
              }
            }}
          >
            {value.length ? '继续搜索或选择' : '搜索或选择三级项目类型'}
            <ChevronDown className="size-[16px] shrink-0" aria-hidden />
          </Button>
        </div>
        {open && (
          <div
            id={`${id}-options`}
            role="dialog"
            aria-label="选择三级项目类型"
            className="absolute top-full left-0 z-50 mt-[4px] w-full min-w-0 rounded-xl border bg-popover p-[8px] text-popover-foreground shadow-lg"
          >
            <Input
              ref={input}
              size="profile"
              aria-label="搜索三级项目类型"
              placeholder="搜索三级项目类型"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.preventDefault();
                if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  container.current
                    ?.querySelector<HTMLInputElement>('input[type="checkbox"]:not(:disabled)')
                    ?.focus();
                }
              }}
            />
            <div
              role="group"
              aria-label="三级项目类型候选"
              className="mt-[6px] max-h-[224px] overflow-y-auto overscroll-contain"
            >
              {visible.map((option) => (
                <label
                  key={option.id}
                  className="flex min-h-[44px] cursor-pointer items-center gap-[10px] rounded-md px-[8px] text-[13px] hover:bg-accent has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50"
                >
                  <input
                    type="checkbox"
                    checked={value.includes(option.id)}
                    disabled={!value.includes(option.id) && value.length >= 20}
                    onChange={(event) =>
                      onChange(
                        event.target.checked
                          ? [...value, option.id]
                          : value.filter((item) => item !== option.id),
                      )
                    }
                    className="size-[16px] shrink-0 accent-primary"
                  />
                  <span className="min-w-0 break-words">{option.categoryName}</span>
                </label>
              ))}
              {!visible.length && (
                <p role="status" className="px-[8px] py-[16px] text-[13px] text-muted-foreground">
                  {candidates.length ? '没有匹配的项目类型' : '暂无可选项目类型'}
                </p>
              )}
            </div>
          </div>
        )}
      </div>
      <div className="flex min-h-[36px] items-center justify-between text-[12px] text-muted-foreground">
        <span>已选 {value.length} / 20 项</span>
        {value.length > 0 && (
          <Button variant="link" size="mobileTouch" onClick={() => onChange([])}>
            清空
          </Button>
        )}
      </div>
    </div>
  );
}
