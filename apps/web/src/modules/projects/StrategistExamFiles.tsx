import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Download, FileText, Upload, X } from 'lucide-react';
import {
  PROJECT_ATTACHMENT_ACCEPT,
  PROJECT_ATTACHMENT_EXTENSIONS,
  PROJECT_ATTACHMENT_MAX_BYTES,
  type AuthUser,
} from '@tyde/shared';
import { ErrorNotice } from '@/components/ErrorNotice';
import { Button } from '@/components/ui/button';
import { FileUploadField } from '@/components/ui/shared/FileUploadField';
import { SESSION_KEY } from '@/hooks/useSession';
import { api } from '@/services/api';
import { examDraftKey, type ExamDraftFile } from './entrance-exam-form';
import { saveExamBlob } from './EntranceExamFiles';

/** 每个附件区维护自己的上传失败；凭证只留在当前考试表单，不自动重放。 */
export function StrategistExamFiles({
  label,
  files,
  limit,
  disabled,
  user,
  onChange,
}: {
  label: string;
  files: ExamDraftFile[];
  limit: number;
  disabled: boolean;
  user: AuthUser;
  onChange: (update: (current: ExamDraftFile[]) => ExamDraftFile[]) => void;
}) {
  const cache = useQueryClient();
  const mounted = useRef(false);
  const [error, setError] = useState<unknown>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  const pending = files.some((file) => file.status === 'uploading');
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  function current() {
    const session = cache.getQueryData<AuthUser | null>(SESSION_KEY);
    return (
      mounted.current && session?.id === user.id && (session.selectedRole ?? session.role) === 'PM'
    );
  }
  async function upload(item: ExamDraftFile) {
    if (!item.file || disabled) return;
    onChange((previous) =>
      previous.map((file) =>
        file.key === item.key ? { ...file, status: 'uploading', error: undefined } : file,
      ),
    );
    try {
      const result = await api.uploadEntranceExamAttachment(item.file);
      if (current())
        onChange((previous) =>
          previous.map((file) =>
            file.key === item.key
              ? {
                  ...file,
                  status: 'ready',
                  reference: { objectKey: result.objectKey, uploadToken: result.uploadToken },
                }
              : file,
          ),
        );
    } catch (failure) {
      if (current())
        onChange((previous) =>
          previous.map((file) =>
            file.key === item.key
              ? {
                  ...file,
                  status: 'failed',
                  error: failure instanceof Error ? failure.message : '附件上传失败',
                }
              : file,
          ),
        );
    }
  }
  async function choose(selected: File[]) {
    if (disabled || pending || !current()) return;
    if (files.length + selected.length > limit) {
      setError(new Error(`本区附件最多${limit}个，请减少后重新选择。`));
      return;
    }
    if (
      selected.some(
        (file) =>
          file.size <= 0 ||
          file.size > PROJECT_ATTACHMENT_MAX_BYTES ||
          !(PROJECT_ATTACHMENT_EXTENSIONS as readonly string[]).includes(
            file.name.split('.').at(-1)?.toLowerCase() ?? '',
          ),
      )
    ) {
      setError(new Error('请选择支持格式的非空附件，单个文件不超过50 MiB。'));
      return;
    }
    setError(null);
    const additions = selected.map((file) => ({
      key: examDraftKey(),
      name: file.name,
      size: file.size,
      file,
      status: 'uploading' as const,
    }));
    onChange((previous) => [...previous, ...additions]);
    for (const file of additions) {
      if (!current()) return;
      await upload(file);
    }
  }
  async function download(item: ExamDraftFile) {
    if (!item.reference?.objectKey || downloading) return;
    setDownloading(item.key);
    setError(null);
    try {
      const blob = await api.readEntranceExamAttachment(item.reference.objectKey);
      if (!current()) return;
      saveExamBlob(blob, item.name);
    } catch (failure) {
      if (current()) setError(failure);
    } finally {
      if (mounted.current) setDownloading(null);
    }
  }
  return (
    <div className="space-y-[10px]" role="group" aria-label={label}>
      <p className="text-[13px] font-medium">
        {label} <span className="font-normal text-muted-foreground">（选填，最多{limit}个）</span>
      </p>
      <FileUploadField
        aria-label={`上传${label}`}
        accept={PROJECT_ATTACHMENT_ACCEPT}
        multiple
        disabled={disabled || pending || files.length >= limit}
        onFilesSelected={(selected) => void choose(selected)}
        contentClassName="min-h-[44px] items-center justify-center gap-[8px] rounded-[10px] border border-dashed p-[10px] text-[13px] text-muted-foreground"
      >
        <Upload className="size-4" aria-hidden />
        选择或拖入附件
      </FileUploadField>
      {files.map((file) => (
        <div
          key={file.key}
          className="flex min-w-0 flex-wrap items-center gap-[8px] rounded-[10px] border px-[12px] py-[8px] text-[13px]"
        >
          <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 flex-1 break-all">
            {file.name}
            <span className="ml-[6px] text-muted-foreground">
              {(file.size / 1024).toLocaleString('zh-CN', { maximumFractionDigits: 1 })} KB
            </span>
          </span>
          {file.status === 'uploading' && <span role="status">上传中…</span>}
          {file.status === 'failed' && (
            <>
              <span role="alert" className="text-destructive">
                {file.error || '上传失败'}
              </span>
              <Button
                variant="outline"
                size="mobileTouch"
                disabled={disabled || pending}
                onClick={() => void upload(file)}
              >
                重试上传
              </Button>
            </>
          )}
          {file.status === 'ready' && (
            <Button
              variant="ghost"
              size="iconTouch"
              aria-label={`下载${file.name}`}
              loading={downloading === file.key}
              disabled={downloading !== null}
              onClick={() => void download(file)}
            >
              <Download className="size-4" aria-hidden />
            </Button>
          )}
          <Button
            variant="dangerGhost"
            size="iconTouch"
            aria-label={`移除${file.name}`}
            disabled={disabled || file.status === 'uploading'}
            onClick={() => onChange((previous) => previous.filter((item) => item.key !== file.key))}
          >
            <X className="size-4" aria-hidden />
          </Button>
        </div>
      ))}
      <ErrorNotice error={error} />
    </div>
  );
}
