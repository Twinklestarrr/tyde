import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, Navigate, useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Building2, Check, FileImage, Plus, X } from 'lucide-react';
import {
  AVATAR_ACCEPT,
  AVATAR_EXTENSIONS,
  AVATAR_MAX_BYTES,
  type AuthUser,
  type BusinessLicenseUploadResult,
  type OrganizationCreateInput,
  type OrganizationDetail,
} from '@tyde/shared';
import { ErrorNotice } from '@/components/ErrorNotice';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { FormField } from '@/components/ui/shared/FormField';
import { FileUploadField } from '@/components/ui/shared/FileUploadField';
import { SESSION_KEY } from '@/hooks/useSession';
import { api } from '@/services/api';
import { OrganizationPageHeader } from './OrganizationPageHeader';
import { OrganizationLogoField, useOrganizationLogo } from './OrganizationLogoField';

interface CreateValues {
  name: string;
  unifiedCreditCode: string;
  description: string;
  expertiseTags: string;
}

function tagsFrom(value: string) {
  return value
    .split(/[,，\n]/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

/** 无组织时独立创建，Logo 和证照在创建时上传并关联。 */
export function OrganizationCreatePage({ user }: { user: AuthUser }) {
  if (typeof user.organization?.id === 'string') return <Navigate to="/organization" replace />;
  return <OrganizationCreateForm user={user} />;
}

function OrganizationCreateForm({ user }: { user: AuthUser }) {
  const cache = useQueryClient();
  const navigate = useNavigate();
  const form = useForm<CreateValues>({
    defaultValues: {
      name: '',
      unifiedCreditCode: '',
      description: '',
      expertiseTags: '',
    },
    mode: 'onBlur',
  });
  const inFlight = useRef(false);
  const mounted = useRef(false);
  const uploaded = useRef<{ file: File; result: BusinessLicenseUploadResult } | null>(null);
  const [license, setLicense] = useState<File | null>(null);
  const [fileError, setFileError] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [refreshError, setRefreshError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<OrganizationDetail | null>(null);
  const logo = useOrganizationLogo('', 512, () => setError(null));
  const currentRole = user.selectedRole ?? user.role;
  const canCreate = currentRole === 'EXPERT';

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  function chooseFile(file: File | undefined) {
    if (!file) return;
    const extension = file.name.split('.').at(-1)?.toLowerCase() ?? '';
    if (!(AVATAR_EXTENSIONS as readonly string[]).includes(extension) || !file.size) {
      setFileError('请选择 JPG、PNG、GIF、BMP 或 WebP 图片');
      return;
    }
    if (file.size > AVATAR_MAX_BYTES) {
      setFileError('营业执照图片最大 10 MiB');
      return;
    }
    uploaded.current = null;
    setLicense(file);
    setFileError('');
    setError(null);
  }

  async function openCreatedOrganization(organizationId: string) {
    if (mounted.current) setRefreshError(null);
    try {
      const current = await api.getCurrentUser();
      if (current.id !== user.id) throw new Error('登录账户已变化，请重新登录后查看组织');
      if (current.organization?.id !== organizationId)
        throw new Error('组织已创建，但账户资料尚未更新，请重试读取');
      await cache.cancelQueries({ queryKey: SESSION_KEY });
      cache.setQueryData(SESSION_KEY, current);
      await cache.invalidateQueries({ queryKey: ['profile-organization'] });
      if (mounted.current) await navigate({ to: '/organization', replace: true });
    } catch (failure) {
      if (mounted.current) setRefreshError(failure);
    }
  }

  async function create(values: CreateValues) {
    if (inFlight.current || !canCreate || fileError) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const input: OrganizationCreateInput = { name: values.name.trim() };
    const credit = values.unifiedCreditCode.trim();
    const description = values.description.trim();
    const expertiseTags = tagsFrom(values.expertiseTags);
    if (credit) input.unifiedCreditCode = credit;
    if (description) input.description = description;
    if (expertiseTags.length) input.expertiseTags = expertiseTags;
    try {
      Object.assign(input, await logo.prepare());
      if (license) {
        const result =
          uploaded.current?.file === license
            ? uploaded.current.result
            : await api.uploadBusinessLicense(license);
        uploaded.current = { file: license, result };
        input.businessLicense = { objectKey: result.objectKey, uploadToken: result.uploadToken };
      }
      if (!mounted.current) return;
      const result = await api.createOrganization(input);
      if (mounted.current) setCreated(result);
      await openCreatedOrganization(result.id);
    } catch (failure) {
      if (mounted.current) setError(failure);
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-[1040px] space-y-[16px]">
      <OrganizationPageHeader
        title="创建组织"
        description="先填写组织名称，其余资料按需补充。创建成功后，你会成为组织主管。"
        backToOrganization
      />

      {created ? (
        <section className="rounded-[12px] border bg-card p-[24px] sm:p-[32px]">
          <div className="mb-[16px] grid size-[48px] place-items-center rounded-full bg-[var(--color-primary-soft)] text-[var(--color-primary-strong)]">
            <Check className="size-[24px]" aria-hidden />
          </div>
          <h2 className="m-0 text-[20px] font-semibold">组织已创建</h2>
          <p className="mt-[8px] text-[14px] leading-[22px] text-[var(--color-neutral-strong)]">
            {created.name} 已创建成功。读取最新账户资料后即可进入组织管理。
          </p>
          <ErrorNotice error={refreshError} />
          <Button
            size="account"
            className="mt-[20px]"
            onClick={() => void openCreatedOrganization(created.id)}
          >
            进入组织管理
          </Button>
        </section>
      ) : (
        <div className="grid min-w-0 gap-[16px] lg:grid-cols-[minmax(0,1fr)_240px]">
          <form
            className="min-w-0 rounded-[12px] border bg-card p-[20px] sm:p-[28px] [&_[data-slot=field-description]]:text-[13px] [&_[data-slot=field-label]]:text-[14px] [&_[data-slot=input]]:text-[14px]"
            onSubmit={form.handleSubmit(create)}
            noValidate
          >
            <div className="mb-[24px] flex items-start gap-[12px] border-b pb-[20px]">
              <div className="grid size-[40px] shrink-0 place-items-center rounded-[10px] bg-[var(--color-primary-soft)] text-[var(--color-primary-strong)]">
                <Building2 className="size-[20px]" aria-hidden />
              </div>
              <div>
                <h2 className="m-0 text-[18px] font-semibold">组织资料</h2>
                <p className="mt-[4px] text-[13px] leading-[20px] text-[var(--color-neutral-strong)]">
                  名称必填，其他资料可根据实际情况填写。
                </p>
              </div>
            </div>

            <fieldset disabled={busy} className="space-y-[22px]">
              <FormField
                controlId="create-org-name"
                label="组织名称"
                required
                error={form.formState.errors.name?.message}
                description="组织名称创建后暂不能在此修改，请确认填写准确。"
              >
                {({ invalid, describedBy }) => (
                  <Input
                    id="create-org-name"
                    size="profile"
                    autoComplete="organization"
                    maxLength={128}
                    placeholder="例如：潮汐标注团队"
                    aria-invalid={invalid || undefined}
                    aria-describedby={describedBy}
                    {...form.register('name', {
                      validate: (value) =>
                        (value.trim().length > 0 && value.trim().length <= 128) ||
                        '请填写 1–128 字的组织名称',
                    })}
                  />
                )}
              </FormField>
              <FormField
                controlId="create-org-credit"
                label="统一社会信用代码（选填）"
                error={form.formState.errors.unifiedCreditCode?.message}
              >
                {({ invalid, describedBy }) => (
                  <Input
                    id="create-org-credit"
                    size="profile"
                    maxLength={32}
                    placeholder="有则填写"
                    aria-invalid={invalid || undefined}
                    aria-describedby={describedBy}
                    {...form.register('unifiedCreditCode', {
                      validate: (value) => value.trim().length <= 32 || '最多 32 字符',
                    })}
                  />
                )}
              </FormField>
              <FormField
                controlId="create-org-description"
                label="组织简介（选填）"
                error={form.formState.errors.description?.message}
                description="介绍团队擅长的工作与合作方式，最多 1024 字。"
              >
                {({ invalid, describedBy }) => (
                  <Textarea
                    id="create-org-description"
                    rows={4}
                    maxLength={1024}
                    aria-invalid={invalid || undefined}
                    aria-describedby={describedBy}
                    {...form.register('description', {
                      validate: (value) => value.trim().length <= 1024 || '最多 1024 字',
                    })}
                  />
                )}
              </FormField>

              <div className="border-t pt-[22px]">
                <h3 className="text-[15px] font-semibold">补充资料</h3>
                <p className="mt-[4px] text-[13px] leading-[20px] text-[var(--color-neutral-strong)]">
                  以下信息均可跳过，不影响创建组织。
                </p>
              </div>
              <FormField
                controlId="create-org-tags"
                label="擅长领域（选填）"
                error={form.formState.errors.expertiseTags?.message}
                description="多个领域用逗号分隔，每项最多 128 字。"
              >
                {({ invalid, describedBy }) => (
                  <Input
                    id="create-org-tags"
                    size="profile"
                    maxLength={1024}
                    placeholder="例如：图像标注，质量检查"
                    aria-invalid={invalid || undefined}
                    aria-describedby={describedBy}
                    {...form.register('expertiseTags', {
                      validate: (value) =>
                        tagsFrom(value).every((tag) => tag.length <= 128) || '每个领域最多 128 字',
                    })}
                  />
                )}
              </FormField>
              <OrganizationLogoField logo={logo} disabled={busy} />
              <FormField
                controlId="create-org-license"
                label="营业执照（选填）"
                error={fileError}
                description="支持 JPG、PNG、GIF、BMP、WebP，最大 10 MiB。创建时上传并关联，仅有权限的组织主管或管理员可读取。"
              >
                {({ invalid, describedBy }) => (
                  <div className="flex min-w-0 flex-wrap items-center gap-[10px]">
                    <FileUploadField
                      id="create-org-license"
                      accept={AVATAR_ACCEPT}
                      disabled={busy}
                      aria-invalid={invalid || undefined}
                      aria-describedby={describedBy}
                      contentClassName="rounded-[8px]"
                      onFilesSelected={(files) => chooseFile(files[0])}
                    >
                      <Button asChild variant="outline" size="account" disabled={busy}>
                        <span>
                          <FileImage className="size-[16px]" aria-hidden />
                          选择营业执照
                        </span>
                      </Button>
                    </FileUploadField>
                    {(license || fileError) && (
                      <span className="flex max-w-full min-w-0 items-center rounded-[8px] border bg-muted pl-[10px]">
                        <span
                          className="min-w-0 max-w-[180px] truncate text-[12px] text-[var(--color-neutral-strong)]"
                          title={license?.name}
                        >
                          {license?.name ?? '未选择有效文件'}
                        </span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="iconTouch"
                          disabled={busy}
                          aria-label="清除营业执照选择"
                          onClick={() => {
                            setLicense(null);
                            uploaded.current = null;
                            setFileError('');
                          }}
                        >
                          <X className="size-[16px]" aria-hidden />
                        </Button>
                      </span>
                    )}
                  </div>
                )}
              </FormField>
            </fieldset>

            <ErrorNotice error={error} />
            <div className="mt-[28px] flex flex-wrap justify-end gap-[10px] border-t pt-[20px]">
              <Button asChild variant="outline" size="account" disabled={busy}>
                <Link to="/organization" onClick={(event) => busy && event.preventDefault()}>
                  取消
                </Link>
              </Button>
              <Button
                type="submit"
                size="account"
                loading={busy}
                disabled={!canCreate || !!fileError}
              >
                <Plus className="size-[16px]" aria-hidden />
                创建组织
              </Button>
            </div>
          </form>

          <aside className="h-fit rounded-[12px] border bg-card p-[20px] text-[13px] leading-[21px] text-[var(--color-neutral-strong)]">
            <h2 className="m-0 text-[15px] font-semibold text-foreground">创建后可以做什么</h2>
            <ul className="mt-[12px] list-inside list-disc space-y-[8px]">
              <li>作为组织主管查看组织资料</li>
              <li>导入和管理团队成员</li>
              <li>处理成员退出审批</li>
            </ul>
            <p className="mt-[16px] border-t pt-[14px]">创建不会自动加入项目或授予其他业务权限。</p>
          </aside>
        </div>
      )}
    </div>
  );
}
