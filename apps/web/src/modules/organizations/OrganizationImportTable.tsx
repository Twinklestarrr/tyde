import { useId, useState, type ClipboardEvent } from 'react';
import type { OrganizationImportRowError } from '@tyde/shared';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import {
  emptyRow,
  isPhoneDraft,
  MEMBER_IMPORT_MAX_ROWS,
  normalizeMemberCell,
  parseClipboard,
  type MemberImportRow,
} from './member-import-table';

const columns = [
  { label: '姓名', field: 'realName', placeholder: '填写姓名' },
  { label: '手机号', field: 'phone', placeholder: '11 位手机号' },
  { label: '人员属性', field: 'employmentType', placeholder: '全职 / 兼职' },
  { label: '组织角色', field: 'position', placeholder: '默认成员' },
  { label: '入组日期', field: 'joinedAt', placeholder: 'YYYY-MM-DD' },
] as const;

/** 五列草稿复用公共输入、下拉与日期选择，手动编辑和粘贴共用字段约束。 */
export function OrganizationImportTable({
  rows,
  onChange,
  onError,
  rowErrors,
  disabled,
}: {
  rows: MemberImportRow[];
  onChange: (rows: MemberImportRow[]) => void;
  onError: (message: string) => void;
  rowErrors: OrganizationImportRowError[];
  disabled: boolean;
}) {
  const id = useId();
  const [menuContainer, setMenuContainer] = useState<HTMLElement | null>(null);
  const filledRows = rows.filter((row) => row.some((cell) => cell.trim())).length;
  // 服务端行号按非空成员计数，不能直接使用包含空行的界面下标。
  let populatedIndex = 0;
  const rowNumbers = rows.map((row) => (row.some((cell) => cell.trim()) ? ++populatedIndex : 0));

  function changeCell(rowIndex: number, columnIndex: number, value: string) {
    if (columnIndex === 1 && !isPhoneDraft(value)) {
      onError('手机号只能填写最多 11 位数字');
      return;
    }
    try {
      const normalized = normalizeMemberCell(columnIndex, value);
      onChange(
        rows.map((row, index) =>
          index === rowIndex
            ? (row.map((cell, column) =>
                column === columnIndex ? (columnIndex === 0 ? value : normalized) : cell,
              ) as MemberImportRow)
            : row,
        ),
      );
    } catch (error) {
      onError(error instanceof Error ? error.message : '请检查填写内容。');
    }
  }

  function paste(event: ClipboardEvent<HTMLElement>, rowIndex: number, columnIndex: number) {
    if (disabled) return;
    const text = event.clipboardData.getData('text/plain');
    if (!/[\t\r\n,，]/.test(text)) {
      if (columnIndex < 2 && event.currentTarget instanceof HTMLInputElement) {
        // 必须在浏览器 maxlength 截断前校验，避免把长号码悄悄变成另一号码。
        event.preventDefault();
        const input = event.currentTarget;
        const next =
          input.value.slice(0, input.selectionStart ?? 0) +
          text.trim() +
          input.value.slice(input.selectionEnd ?? input.value.length);
        changeCell(rowIndex, columnIndex, next);
      } else {
        event.preventDefault();
        changeCell(rowIndex, columnIndex, text.trim());
      }
      return;
    }
    event.preventDefault();
    try {
      const pasted = parseClipboard(text);
      if (!pasted.length) return;
      if (pasted.some((row) => row.length + columnIndex > columns.length))
        throw new Error('粘贴内容超出表格列数，请从姓名列粘贴完整成员信息。');
      if (rowIndex + pasted.length > MEMBER_IMPORT_MAX_ROWS)
        throw new Error('表格最多填写 500 位成员，请分批导入。');
      const next = rows.map((row) => [...row] as MemberImportRow);
      while (next.length < rowIndex + pasted.length) next.push(emptyRow());
      pasted.forEach((row, offset) => {
        row.forEach((value, column) => {
          try {
            next[rowIndex + offset]![columnIndex + column] = normalizeMemberCell(
              columnIndex + column,
              value,
            );
          } catch (error) {
            throw new Error(
              `第 ${rowIndex + offset + 1} 行${error instanceof Error ? error.message : '内容格式不正确'}`,
              { cause: error },
            );
          }
        });
      });
      onChange(next);
    } catch (error) {
      onError(error instanceof Error ? error.message : '无法读取粘贴内容，请检查表格格式。');
    }
  }

  return (
    <section ref={setMenuContainer} className="min-w-0 space-y-[10px]" aria-label="成员清单">
      <div className="flex flex-wrap items-center justify-between gap-[8px]">
        <p className="font-medium">
          成员清单{' '}
          <span className="ml-[8px] font-normal text-muted-foreground">{filledRows} / 500 人</span>
        </p>
        <Button
          variant="ghost"
          size="mobileTouch"
          disabled={disabled || (!filledRows && rows.length === 1)}
          onClick={() => onChange([emptyRow()])}
        >
          清空表格
        </Button>
      </div>
      <p id={`${id}-help`} className="text-[12px] leading-[20px] text-muted-foreground">
        从 Excel / WPS 复制多行，点击单元格粘贴。姓名最多 64 字，手机号 11
        位；请选择人员属性和组织角色，日期留空为今天。
      </p>
      <div
        role="region"
        aria-label="成员表格编辑区"
        aria-describedby={`${id}-help`}
        tabIndex={0}
        className="max-h-[320px] overflow-auto rounded-[10px] border border-border focus-visible:outline-2 focus-visible:outline-ring"
      >
        <table className="w-full min-w-[790px] table-fixed border-collapse text-left text-[13px]">
          <colgroup>
            <col className="w-[40px]" />
            <col className="w-[140px]" />
            <col className="w-[164px]" />
            <col className="w-[140px]" />
            <col className="w-[126px]" />
            <col className="w-[136px]" />
            <col className="w-[44px]" />
          </colgroup>
          <thead className="sticky top-0 z-10 bg-[var(--color-surface-muted)] text-muted-foreground">
            <tr>
              <th scope="col" className="p-[10px] text-center font-medium">
                #
              </th>
              {columns.map((column, index) => (
                <th scope="col" key={column.field} className="px-[12px] py-[10px] font-medium">
                  {column.label}
                  {index < 3 && <span className="ml-[4px] text-destructive">*</span>}
                </th>
              ))}
              <th scope="col">
                <span className="sr-only">操作</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => {
              const errors = rowNumbers[rowIndex]
                ? rowErrors.filter((error) => error.rowNo === rowNumbers[rowIndex])
                : [];
              return (
                <tr
                  key={rowIndex}
                  className={cn(
                    'border-t border-border',
                    errors.length > 0 && 'bg-[var(--color-danger-soft)]',
                  )}
                >
                  <th scope="row" className="text-center font-normal text-muted-foreground">
                    {rowIndex + 1}
                  </th>
                  {columns.map((column, columnIndex) => {
                    const messages = errors.filter((error) => error.field === column.field);
                    const errorId = `${id}-${rowIndex}-${column.field}-error`;
                    const accessibility = {
                      'aria-label': `第 ${rowIndex + 1} 行 ${column.label}`,
                      'aria-required': columnIndex < 3 || undefined,
                      'aria-invalid': messages.length > 0 || undefined,
                      'aria-describedby': messages.length ? errorId : undefined,
                    };
                    return (
                      <td key={column.field} className="border-l border-border align-top">
                        {columnIndex === 2 || columnIndex === 3 ? (
                          <Select
                            value={row[columnIndex] || (columnIndex === 3 ? '成员' : '')}
                            disabled={disabled}
                            onValueChange={(value) => changeCell(rowIndex, columnIndex, value)}
                          >
                            <SelectTrigger
                              {...accessibility}
                              size="profile"
                              className="rounded-none border-0 shadow-none focus:ring-inset aria-invalid:bg-[var(--color-danger-soft)]"
                              onPaste={(event) => paste(event, rowIndex, columnIndex)}
                            >
                              <SelectValue placeholder="请选择" />
                            </SelectTrigger>
                            <SelectContent container={menuContainer}>
                              {(columnIndex === 2 ? ['全职', '兼职'] : ['成员', '管理员']).map(
                                (value) => (
                                  <SelectItem key={value} value={value} className="text-[13px]">
                                    {value}
                                  </SelectItem>
                                ),
                              )}
                            </SelectContent>
                          </Select>
                        ) : (
                          <Input
                            {...accessibility}
                            type={columnIndex === 4 ? 'date' : 'text'}
                            max={columnIndex === 4 ? '9999-12-31' : undefined}
                            size="profile"
                            className="rounded-none border-0 bg-transparent shadow-none focus-visible:ring-inset"
                            value={row[columnIndex]}
                            placeholder={column.placeholder}
                            autoComplete="off"
                            inputMode={columnIndex === 1 ? 'numeric' : undefined}
                            maxLength={columnIndex === 1 ? 11 : undefined}
                            disabled={disabled}
                            onPaste={(event) => paste(event, rowIndex, columnIndex)}
                            onChange={(event) =>
                              changeCell(rowIndex, columnIndex, event.target.value)
                            }
                          />
                        )}
                        {messages.length > 0 && (
                          <p
                            id={errorId}
                            className="px-[10px] pb-[8px] text-[12px] text-destructive"
                          >
                            {messages.map((message) => message.message).join('；')}
                          </p>
                        )}
                      </td>
                    );
                  })}
                  <td className="border-l border-border text-center align-top">
                    <Button
                      variant="ghost"
                      size="iconMobileTouch"
                      aria-label={`删除第 ${rowIndex + 1} 行`}
                      disabled={disabled}
                      onClick={() =>
                        onChange(
                          rows.length === 1
                            ? [emptyRow()]
                            : rows.filter((_, index) => index !== rowIndex),
                        )
                      }
                    >
                      <Trash2 className="size-[15px]" aria-hidden />
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <Button
        variant="primaryGhost"
        size="mobileTouch"
        disabled={disabled || rows.length >= MEMBER_IMPORT_MAX_ROWS}
        onClick={() => onChange([...rows, emptyRow()])}
      >
        <Plus className="size-[16px]" aria-hidden />
        添加成员
      </Button>
    </section>
  );
}
