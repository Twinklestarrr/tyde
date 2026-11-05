import { useEffect, useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import type { AuthUser, EntranceExamFileSnapshot } from '@tyde/shared';
import { SESSION_KEY } from '@/hooks/useSession';
import { api } from '@/services/api';
import { Button } from '@/components/ui/button';
import { ErrorNotice } from '@/components/ErrorNotice';

export function saveExamBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name.replace(/[\\/\p{Cc}]/gu, '_').trim() || 'exam-attachment';
  document.body.append(link);
  try {
    link.click();
  } finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/** 历史异常快照明确提示；不把敏感对象键拼成可公开访问的 URL。 */
export function entranceExamFiles(value: unknown): EntranceExamFileSnapshot[] | null {
  if (value == null) return [];
  if (
    !Array.isArray(value) ||
    !value.every(
      (item) =>
        item &&
        typeof item === 'object' &&
        typeof item.objectKey === 'string' &&
        typeof item.fileName === 'string',
    )
  )
    return null;
  return value;
}

export function EntranceExamFiles({ value, label }: { value: unknown; label: string }) {
  const cache = useQueryClient();
  const origin = useRef(cache.getQueryData<AuthUser | null>(SESSION_KEY));
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  function requireIdentity() {
    const current = cache.getQueryData<AuthUser | null>(SESSION_KEY);
    if (
      !mounted.current ||
      !origin.current ||
      !current ||
      current.id !== origin.current.id ||
      (current.selectedRole ?? current.role) !==
        (origin.current.selectedRole ?? origin.current.role)
    )
      throw new Error('当前账号或角色已变化，请重新打开附件。');
  }
  const files = entranceExamFiles(value);
  const download = useMutation({
    mutationFn: async (file: EntranceExamFileSnapshot) => {
      requireIdentity();
      const blob = await api.readEntranceExamAttachment(file.objectKey);
      requireIdentity();
      saveExamBlob(blob, file.fileName);
    },
    retry: false,
  });
  return (
    <div aria-label={label} className="space-y-2">
      {files === null ? (
        <p className="text-xs text-muted-foreground">历史附件格式异常，无法列出。</p>
      ) : (
        files.map((file, index) => (
          <Button
            key={`${file.objectKey}:${index}`}
            variant="ghost"
            size="mobileTouch"
            className="h-auto max-w-full justify-start whitespace-normal break-all text-left"
            loading={download.isPending && download.variables === file}
            disabled={download.isPending}
            onClick={() => void download.mutateAsync(file).catch(() => {})}
          >
            <Download className="size-4 shrink-0" aria-hidden />
            {file.fileName}
          </Button>
        ))
      )}
      <ErrorNotice error={download.error} />
    </div>
  );
}
