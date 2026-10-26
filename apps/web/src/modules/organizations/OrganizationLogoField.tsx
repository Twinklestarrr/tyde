import { useEffect, useId, useRef, useState } from 'react';
import { Building2, ChevronDown, ImagePlus } from 'lucide-react';
import {
  ORG_LOGO_ACCEPT,
  ORG_LOGO_MAX_BYTES,
  type OrganizationLogoUploadResult,
} from '@tyde/shared';
import { api } from '@/services/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FormField } from '@/components/ui/shared/FormField';
import { FileUploadField } from '@/components/ui/shared/FileUploadField';

function validImageUrl(value: string) {
  if (!value) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** 创建和编辑组织共用草稿；上传凭证只在当前表单内存中保留。 */
export function useOrganizationLogo(initialUrl = '', maxLength = 500, onChange?: () => void) {
  const [url, setUrl] = useState(initialUrl);
  const [draft, setDraft] = useState<{ file: File; url: string } | null>(null);
  const [error, setError] = useState('');
  const uploaded = useRef<{ file: File; result: OrganizationLogoUploadResult } | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(
    () => () => {
      if (draft) URL.revokeObjectURL(draft.url);
    },
    [draft],
  );

  function changeUrl(value: string) {
    onChange?.();
    setDraft(null);
    uploaded.current = null;
    setUrl(value);
    setError('');
  }

  function choose(file: File | undefined) {
    if (!file) return;
    onChange?.();
    const extension = '.' + (file.name.split('.').at(-1)?.toLowerCase() ?? '');
    if (!ORG_LOGO_ACCEPT.split(',').includes(extension) || !file.size) {
      setError('请选择非空的 JPG、PNG、GIF、BMP 或 WebP 图片');
      return;
    }
    if (file.size > ORG_LOGO_MAX_BYTES) {
      setError('Logo 图片最大 10 MiB');
      return;
    }
    uploaded.current = null;
    setDraft({ file, url: URL.createObjectURL(file) });
    setError('');
  }

  async function prepare(): Promise<{ logoUrl?: string; logoUploadToken?: string }> {
    if (error) throw new Error(error);
    if (draft) {
      if (uploaded.current?.file !== draft.file)
        uploaded.current = {
          file: draft.file,
          result: await api.uploadOrganizationLogo(draft.file),
        };
      if (!mounted.current) throw new Error('页面已关闭，请重新选择图片');
      return {
        logoUrl: uploaded.current.result.objectKey,
        logoUploadToken: uploaded.current.result.uploadToken,
      };
    }
    const trimmed = url.trim();
    if (trimmed === initialUrl) return {};
    if (trimmed.length > maxLength || !validImageUrl(trimmed)) {
      const message = `请输入不含用户名和密码的 HTTPS 图片地址（最多 ${maxLength} 字符）`;
      setError(message);
      throw new Error(message);
    }
    return { logoUrl: trimmed };
  }

  return {
    url,
    draft,
    error,
    maxLength,
    changeUrl,
    choose,
    prepare,
    previewUrl: draft?.url ?? (validImageUrl(url.trim()) ? url.trim() : ''),
  };
}

export function OrganizationLogoField({
  logo,
  disabled = false,
}: {
  logo: ReturnType<typeof useOrganizationLogo>;
  disabled?: boolean;
}) {
  const id = useId();
  const [linkOpen, setLinkOpen] = useState(false);
  const [failedUrl, setFailedUrl] = useState('');
  return (
    <section aria-label="组织 Logo" className="min-w-0 space-y-[10px]">
      <FormField
        controlId={id + '-file'}
        label="组织 Logo"
        error={logo.error}
        description="支持 JPG、PNG、GIF、BMP、WebP，最大 10 MiB。选图后点击保存生效。"
      >
        {({ invalid, describedBy }) => (
          <div className="flex min-w-0 items-center gap-[16px]">
            <div className="flex size-[80px] shrink-0 items-center justify-center overflow-hidden rounded-[12px] border bg-muted text-[var(--color-neutral-strong)]">
              {logo.previewUrl && failedUrl !== logo.previewUrl ? (
                <img
                  src={logo.previewUrl}
                  alt="组织 Logo 预览"
                  className="size-full object-contain"
                  referrerPolicy="no-referrer"
                  onError={() => setFailedUrl(logo.previewUrl)}
                />
              ) : (
                <Building2 className="size-[28px]" aria-hidden />
              )}
            </div>
            <div className="min-w-0 space-y-[8px]">
              <div className="flex flex-wrap gap-[8px]">
                <FileUploadField
                  id={id + '-file'}
                  accept={ORG_LOGO_ACCEPT}
                  disabled={disabled}
                  aria-label="选择组织 Logo 图片"
                  aria-invalid={invalid || undefined}
                  aria-describedby={describedBy}
                  contentClassName="rounded-[8px]"
                  onFilesSelected={(files) => logo.choose(files[0])}
                >
                  <Button asChild variant="outline" size="settings" disabled={disabled}>
                    <span>
                      <ImagePlus className="size-[16px]" aria-hidden />
                      {logo.previewUrl ? '更换图片' : '上传图片'}
                    </span>
                  </Button>
                </FileUploadField>
                {(logo.url || logo.draft || logo.error) && (
                  <Button
                    variant="ghost"
                    size="settings"
                    disabled={disabled}
                    onClick={() => logo.changeUrl('')}
                  >
                    清除图片
                  </Button>
                )}
              </div>
              {logo.draft && (
                <p className="break-all text-[12px] text-[var(--color-neutral-strong)]">
                  待保存：{logo.draft.file.name}
                </p>
              )}
            </div>
          </div>
        )}
      </FormField>
      <Button
        variant="ghost"
        size="mobileTouch"
        className="px-0 text-[12px]"
        disabled={disabled}
        aria-expanded={linkOpen}
        aria-controls={id + '-link'}
        onClick={() => setLinkOpen((open) => !open)}
      >
        使用图片链接
        <ChevronDown className={`size-[14px] ${linkOpen ? 'rotate-180' : ''}`} aria-hidden />
      </Button>
      <div id={id + '-link'} hidden={!linkOpen}>
        <FormField
          controlId={id + '-url'}
          label="Logo 地址"
          description="也可以填写 HTTPS 图片地址。"
        >
          <Input
            id={id + '-url'}
            size="profile"
            maxLength={logo.maxLength}
            value={logo.url}
            disabled={disabled}
            placeholder="https://example.com/logo.png"
            onChange={(event) => logo.changeUrl(event.target.value)}
          />
        </FormField>
      </div>
    </section>
  );
}
