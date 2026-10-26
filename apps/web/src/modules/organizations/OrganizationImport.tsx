/** 真实组织成员导入及模板下载，草稿与幂等键仅保留在当前页面内存。 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  OrganizationImportError,
  type AuthUser,
  type OrganizationImportInput,
  type OrganizationImportResult,
  type OrganizationImportRowError,
} from '@tyde/shared';
import { Download, FileSpreadsheet, Upload, UsersRound } from 'lucide-react';
import { ErrorNotice } from '@/components/ErrorNotice';
import { Button } from '@/components/ui/button';
import { FileUploadField } from '@/components/ui/shared/FileUploadField';
import { FormField } from '@/components/ui/shared/FormField';
import { SegmentedControl } from '@/components/ui/shared/SegmentedControl';
import { api } from '@/services/api';
import { OrganizationImportTable } from './OrganizationImportTable';
import {
  emptyRow,
  serializeRows,
  validateMemberRows,
  type MemberImportRow,
} from './member-import-table';
import {
  OrganizationDialog,
  employmentLabels,
  joinStatusLabels,
  organizationTime,
  positionLabels,
} from './common';

interface OrganizationImportProps {
  orgId: string;
  user: AuthUser;
  onSuccess: () => Promise<void>;
}

/** 切换账号或组织时丢弃旧成员清单、回执与幂等键。 */
export function OrganizationImport(props: OrganizationImportProps) {
  return <ImportDialog key={`${props.user.id}:${props.orgId}`} {...props} />;
}

/** 文件不经页面解析或上传台账，直接按既有 multipart 导入接口提交。 */
function ImportDialog({ orgId, onSuccess }: OrganizationImportProps) {
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState<'text' | 'file'>('text');
  const [rows, setRows] = useState<MemberImportRow[]>([emptyRow()]);
  const [file, setFile] = useState<File | null>(null);
  const [fieldError, setFieldError] = useState('');
  const [draftErrors, setDraftErrors] = useState<OrganizationImportRowError[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const [result, setResult] = useState<OrganizationImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const idempotencyKey = useRef(crypto.randomUUID());
  const submitted = useRef(false);
  const downloading = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const importMembers = useMutation({
    mutationFn: (input: OrganizationImportInput) =>
      api.importOrganizationMembers(input, idempotencyKey.current),
    retry: false,
  });
  const template = useMutation({
    mutationFn: (language: 'zh' | 'en') => api.downloadOrganizationMemberTemplate(language),
    retry: false,
  });

  /** 修改有效输入后生成新键；同一份失败草稿的手动重试保留原键。 */
  function changedDraft() {
    idempotencyKey.current = crypto.randomUUID();
    setFieldError('');
    setDraftErrors([]);
    setError(null);
    setNotice('');
    setResult(null);
  }

  /** 仅接收后端支持的非空表格；500 人上限与字段校验交给服务端原子执行。 */
  function chooseFile(nextFile: File | null) {
    changedDraft();
    if (
      nextFile &&
      (!/\.(csv|xlsx|xls)$/i.test(nextFile.name) ||
        nextFile.size === 0 ||
        nextFile.size > 50 * 1024 * 1024)
    ) {
      setFile(null);
      setFieldError('请选择非空 CSV、XLS 或 XLSX 文件，文件最大 50 MiB');
      return;
    }
    setFile(nextFile);
  }

  /** 下载响应直接保存为 XLSX，并在浏览器接收下载后释放临时对象地址。 */
  async function downloadTemplate(language: 'zh' | 'en') {
    if (downloading.current) return;
    downloading.current = true;
    setError(null);
    try {
      const response = await template.mutateAsync(language);
      if (!mounted.current) return;
      const url = URL.createObjectURL(response.blob);
      const link = document.createElement('a');
      link.href = url;
      link.download =
        response.fileName.replace(/[\\/\p{Cc}]/gu, '_').trim() || 'organization-members.xlsx';
      document.body.append(link);
      try {
        link.click();
      } finally {
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 0);
      }
    } catch (failure) {
      if (mounted.current) setError(failure);
    } finally {
      downloading.current = false;
    }
  }

  /** 整批失败保留输入和行级错误；成功后清空草稿，刷新失败也不重发导入。 */
  async function submitImport(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitted.current) return;
    let text = '';
    try {
      if (source === 'text') text = serializeRows(rows);
    } catch (failure) {
      setFieldError(failure instanceof Error ? failure.message : '请检查成员表格内容');
      return;
    }
    if ((source === 'text' && !text) || (source === 'file' && !file)) {
      setFieldError(source === 'text' ? '请填写至少一位成员的信息' : '请选择成员表格');
      return;
    }
    if (source === 'text') {
      const errors = validateMemberRows(rows);
      setDraftErrors(errors);
      if (errors.length) {
        setError(null);
        setResult(null);
        setFieldError('请修正表格中的标记项后再导入');
        return;
      }
    }
    submitted.current = true;
    setBusy(true);
    setFieldError('');
    setError(null);
    setNotice('');
    setResult(null);
    try {
      const imported = await importMembers.mutateAsync({
        orgId,
        ...(source === 'file' && file ? { file } : { memberText: text }),
      });
      if (mounted.current) {
        setResult(imported);
        setRows([emptyRow()]);
        setFile(null);
        idempotencyKey.current = crypto.randomUUID();
        setNotice(
          `已成功导入 ${imported.createdCount} 位成员。新建账号首次成功登录后激活，不生成默认密码。`,
        );
      }
      try {
        await onSuccess();
      } catch {
        if (mounted.current)
          setNotice(
            `已成功导入 ${imported.createdCount} 位成员，但列表刷新失败，请手动刷新成员列表。`,
          );
      }
    } catch (failure) {
      if (!mounted.current) return;
      setError(failure);
      if (failure instanceof OrganizationImportError) setResult(failure.result);
    } finally {
      submitted.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <>
      <Button size="mobileTouch" variant="dark" onClick={() => setOpen(true)}>
        <UsersRound className="size-[16px]" aria-hidden />
        批量导入成员
      </Button>
      {open && (
        <OrganizationDialog
          title="批量导入成员"
          wide
          busy={busy || template.isPending}
          onClose={() => setOpen(false)}
        >
          <form className="space-y-[16px]" onSubmit={(event) => void submitImport(event)}>
            <p className="text-[13px] leading-[22px] text-[var(--color-text-secondary)]">
              可直接粘贴成员名单，或按模板上传表格。每批最多 500 人，校验通过后整批导入。
            </p>
            <div className="flex flex-wrap gap-[8px]">
              <Button
                size="mobileTouch"
                variant="outline"
                disabled={busy || template.isPending}
                onClick={() => void downloadTemplate('zh')}
              >
                <Download className="size-[16px]" aria-hidden />
                下载中文模板
              </Button>
              <Button
                size="mobileTouch"
                variant="outline"
                disabled={busy || template.isPending}
                onClick={() => void downloadTemplate('en')}
              >
                <Download className="size-[16px]" aria-hidden />
                下载英文模板
              </Button>
            </div>
            {template.isPending && <p role="status">正在下载成员模板…</p>}
            <SegmentedControl
              variant="soft"
              name="organization-import-source"
              ariaLabel="成员导入方式"
              value={source}
              disabled={busy}
              options={[
                { value: 'text', label: '粘贴或填写' },
                { value: 'file', label: '上传表格' },
              ]}
              onValueChange={(value) => {
                changedDraft();
                setSource(value);
              }}
            />
            {source === 'text' ? (
              <div className="space-y-[8px]">
                <OrganizationImportTable
                  rows={rows}
                  disabled={busy}
                  rowErrors={draftErrors.length ? draftErrors : (result?.rowErrors ?? [])}
                  onError={setFieldError}
                  onChange={(next) => {
                    changedDraft();
                    setRows(next);
                  }}
                />
                {fieldError && (
                  <p role="alert" className="text-[12px] text-destructive">
                    {fieldError}
                  </p>
                )}
              </div>
            ) : (
              <FormField
                controlId="organization-import-file"
                label="成员表格"
                required
                error={fieldError}
                description="请使用上方模板填写成员信息；支持 CSV、XLS、XLSX，单个文件最大 50 MiB。"
              >
                {({ invalid, describedBy }) =>
                  file ? (
                    <div className="flex flex-wrap items-center gap-[12px] rounded-[12px] border border-border bg-[var(--color-surface-muted)] p-[16px]">
                      <FileSpreadsheet className="size-[32px] shrink-0 text-primary" aria-hidden />
                      <div className="min-w-0 flex-1 basis-[140px]">
                        <p className="break-all text-[13px] font-medium">{file.name}</p>
                        <p className="mt-[3px] text-[12px] text-muted-foreground">
                          {file.size < 1024 * 1024
                            ? `${Math.max(1, Math.ceil(file.size / 1024))} KiB`
                            : `${(file.size / (1024 * 1024)).toFixed(1)} MiB`}{' '}
                          · 待导入
                        </p>
                      </div>
                      <div className="flex items-center gap-[8px]">
                        <FileUploadField
                          id="organization-import-file"
                          accept=".csv,.xls,.xlsx"
                          disabled={busy}
                          aria-invalid={invalid || undefined}
                          aria-describedby={describedBy}
                          onFilesSelected={(files) => chooseFile(files[0] ?? null)}
                          contentClassName="rounded-[12px]"
                        >
                          <Button asChild size="mobileTouch" variant="outline">
                            <span>更换表格</span>
                          </Button>
                        </FileUploadField>
                        <Button
                          size="mobileTouch"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => chooseFile(null)}
                        >
                          移除表格
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <FileUploadField
                      id="organization-import-file"
                      accept=".csv,.xls,.xlsx"
                      disabled={busy}
                      aria-invalid={invalid || undefined}
                      aria-describedby={describedBy}
                      onFilesSelected={(files) => chooseFile(files[0] ?? null)}
                      contentClassName="min-h-[180px] flex-col items-center justify-center gap-[12px] rounded-[12px] border-2 border-dashed border-[var(--color-border)] bg-[var(--color-surface-muted)] px-[20px] py-[28px] text-center transition-colors hover:border-[var(--color-primary)] hover:bg-[var(--color-primary-soft)]"
                    >
                      <span className="flex size-[48px] items-center justify-center rounded-[12px] bg-card text-primary">
                        <Upload className="size-[24px]" aria-hidden />
                      </span>
                      <span className="text-[14px] font-medium">点击选择表格，或拖拽到这里</span>
                      <span className="text-[12px] text-muted-foreground">
                        CSV / XLS / XLSX · 最大 50 MiB
                      </span>
                    </FileUploadField>
                  )
                }
              </FormField>
            )}
            {notice && (
              <p role="status" className="rounded-[8px] bg-[var(--color-primary-soft)] p-[12px]">
                {notice}
              </p>
            )}
            {error != null && <ErrorNotice error={error} />}
            {result && <ImportResult result={result} />}
            <p className="text-[12px] text-muted-foreground">
              新账号首次成功登录后激活，无需设置默认密码。
            </p>
            <div className="flex flex-wrap justify-end gap-[8px] border-t pt-[16px]">
              <Button
                size="mobileTouch"
                variant="ghost"
                disabled={busy || template.isPending}
                onClick={() => setOpen(false)}
              >
                关闭
              </Button>
              <Button size="mobileTouch" type="submit" loading={busy} disabled={template.isPending}>
                <Upload className="size-[16px]" aria-hidden />
                确认导入
              </Button>
            </div>
          </form>
        </OrganizationDialog>
      )}
    </>
  );
}

/** 完整展示服务器返回的批次统计、字段错误及成功成员，不生成前端成功记录。 */
function ImportResult({ result }: { result: OrganizationImportResult }) {
  const fieldLabels: Record<string, string> = {
    realName: '姓名',
    phone: '手机号',
    employmentType: '人员属性',
    position: '组织角色',
    joinedAt: '入组日期',
    row: '成员信息',
    members: '成员清单',
    file: '表格文件',
    memberText: '成员清单',
  };
  return (
    <section
      className="space-y-[12px] rounded-[12px] border border-[var(--color-border)] p-[14px]"
      aria-label="成员导入结果"
    >
      <h3 className="font-semibold">导入结果</h3>
      <p>
        总数 {result.totalCount} · 有效 {result.validCount} · 无效 {result.invalidCount} · 已导入{' '}
        {result.createdCount}
      </p>
      <p className="text-[var(--color-text-secondary)]">
        来源：
        {result.sourceType === 'EXCEL'
          ? 'Excel 表格'
          : result.sourceType === 'CSV'
            ? 'CSV 表格'
            : '成员清单'}
        {result.createdAt ? ` · 完成时间：${organizationTime(result.createdAt)}` : ''}
      </p>
      {result.rowErrors.length > 0 && (
        <div
          tabIndex={0}
          role="region"
          aria-label="逐行导入错误"
          className="max-h-[240px] space-y-[8px] overflow-auto rounded-[8px] border border-[var(--color-danger-border)] p-[10px] focus-visible:outline-2 focus-visible:outline-ring"
        >
          {result.rowErrors.map((row, index) => (
            <p
              key={`${row.rowNo}:${row.field}:${index}`}
              className="break-words text-[var(--color-danger)]"
            >
              {row.rowNo ? `第 ${row.rowNo} 行` : '整批'} · {fieldLabels[row.field] ?? '成员信息'}：
              {row.message}
              {row.value !== null && row.value !== '' ? `（${row.value}）` : ''}
            </p>
          ))}
        </div>
      )}
      {result.members.length > 0 && (
        <div
          tabIndex={0}
          role="region"
          aria-label="已导入成员"
          className="max-h-[240px] space-y-[8px] overflow-auto focus-visible:outline-2 focus-visible:outline-ring"
        >
          {result.members.map((member) => (
            <article
              key={member.memberId}
              className="rounded-[8px] bg-[var(--color-surface-muted)] p-[10px]"
            >
              <p className="font-semibold">{member.realName}</p>
              <p className="break-all">用户 ID：{member.userId}</p>
              <p>
                {member.phoneMasked || '—'} · {positionLabels[member.position]} ·{' '}
                {member.employmentType ? employmentLabels[member.employmentType] : '未设置'} ·{' '}
                {joinStatusLabels[member.joinStatus]}
              </p>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
