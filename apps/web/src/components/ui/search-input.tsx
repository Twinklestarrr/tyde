import { Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from './button';
import { Input, type InputProps } from './input';

interface SearchInputProps extends Omit<InputProps, 'id' | 'type' | 'size'> {
  id: string;
  label: string;
  submitLabel?: string;
  loading?: boolean;
  containerClassName?: string;
}

/** 搜索图标与提交操作共用输入框内的固定前缀区域。 */
export function SearchInput({
  id,
  label,
  submitLabel,
  loading = false,
  containerClassName,
  className,
  disabled,
  ...props
}: SearchInputProps) {
  return (
    <div className={cn('relative min-w-0 w-full sm:max-w-[360px]', containerClassName)}>
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <Input
        {...props}
        id={id}
        type="search"
        size="profile"
        disabled={disabled}
        className={cn('pl-[44px]', className)}
      />
      {submitLabel ? (
        <Button
          type="submit"
          variant="ghost"
          size="iconTouch"
          className="absolute inset-y-0 left-0 h-full w-[44px] rounded-r-none px-0"
          aria-label={submitLabel}
          title={submitLabel}
          loading={loading}
          disabled={disabled}
        >
          {!loading && <Search className="size-[16px]" aria-hidden />}
        </Button>
      ) : (
        <Search
          className="pointer-events-none absolute left-[14px] top-1/2 size-[16px] -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
      )}
    </div>
  );
}
