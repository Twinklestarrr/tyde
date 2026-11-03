import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Download, ExternalLink } from 'lucide-react';
import type { AuthUser, ProjectStandardMaterials } from '@tyde/shared';
import { ErrorNotice } from '@/components/ErrorNotice';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { SESSION_KEY } from '@/hooks/useSession';
import { api } from '@/services/api';
import { saveExamBlob } from './EntranceExamFiles';
import { EntranceExamText } from './EntranceExamText';
import { standardMaterialLink } from './standard-training-form';

/** 共用只读材料展示；附件始终经鉴权代理读取，不拼接公开下载地址。 */
export function StandardMaterialsContent({
  user,
  materials,
}: {
  user: AuthUser;
  materials: ProjectStandardMaterials;
}) {
  const cache = useQueryClient();
  const mounted = useRef(false);
  const [downloading, setDownloading] = useState<number | null>(null);
  const [error, setError] = useState<unknown>(null);
  const role = user.selectedRole ?? user.role;
  const link = standardMaterialLink(materials.standardLink);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  function sameSession() {
    const current = cache.getQueryData<AuthUser | null>(SESSION_KEY);
    return (
      mounted.current && current?.id === user.id && (current.selectedRole ?? current.role) === role
    );
  }

  async function download(id: number) {
    const file = materials.attachments.find((item) => item.id === id);
    if (!file || downloading !== null || !sameSession()) return;
    setDownloading(id);
    setError(null);
    try {
      const blob = await api.readProjectAttachment(file.objectKey);
      if (sameSession()) saveExamBlob(blob, file.fileName);
    } catch (failure) {
      if (sameSession()) setError(failure);
    } finally {
      if (mounted.current) setDownloading(null);
    }
  }

  return (
    <div className="min-w-0 space-y-4">
      <Card className="bg-muted/30 p-5">
        <CardTitle asChild className="mb-3">
          <h3>标准正文</h3>
        </CardTitle>
        <EntranceExamText value={materials.standardContent} empty="暂无标准正文。" />
      </Card>
      <div className="min-w-0 space-y-2 text-[13px]">
        <h3 className="font-semibold">标准链接</h3>
        {link ? (
          <a
            href={link}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex max-w-full items-center gap-2 break-all text-primary underline"
          >
            <ExternalLink className="size-4 shrink-0" aria-hidden />
            {materials.standardLink}
          </a>
        ) : (
          <p className="break-all text-muted-foreground">
            {materials.standardLink || '暂无标准链接。'}
          </p>
        )}
      </div>
      <div className="space-y-2 text-[13px]" aria-label="标准附件">
        <h3 className="font-semibold">标准附件（{materials.attachments.length}）</h3>
        {materials.attachments.length === 0 && (
          <p className="text-muted-foreground">暂无标准附件。</p>
        )}
        {materials.attachments.map((file) => (
          <Button
            key={file.id}
            variant="outline"
            size="mobileTouch"
            className="flex h-auto max-w-full justify-start whitespace-normal break-all text-left"
            loading={downloading === file.id}
            aria-label={`下载${file.fileName}`}
            disabled={downloading !== null}
            onClick={() => void download(file.id)}
          >
            <Download className="size-4 shrink-0" aria-hidden />
            {file.fileName}
          </Button>
        ))}
      </div>
      <ErrorNotice error={error} />
    </div>
  );
}
