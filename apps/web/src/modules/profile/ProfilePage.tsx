import { useEffect, useRef, useState, type RefObject } from 'react';
import { useForm } from 'react-hook-form';
import { useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import {
  BadgeCheck,
  BookOpen,
  BriefcaseBusiness,
  Building2,
  CalendarCheck2,
  CalendarDays,
  Compass,
  ChevronDown,
  ImagePlus,
  Link as LinkIcon,
  Fingerprint,
  Pencil,
  Phone,
  ShieldCheck,
  Target,
  Trash2,
  UserRound,
} from 'lucide-react';
import {
  AVATAR_ACCEPT,
  AVATAR_EXTENSIONS,
  AVATAR_MAX_BYTES,
  passwordPattern,
  type AuthUser,
  type AvatarUploadResult,
  type UserProfileUpdateInput,
} from '@tyde/shared';
import { UserAvatar } from '@/components/UserAvatar';
import { ErrorNotice } from '@/components/ErrorNotice';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { FormField } from '@/components/ui/shared/FormField';
import { FileUploadField } from '@/components/ui/shared/FileUploadField';
import AuthPasswordInput from '@/components/ui/shared/AuthPasswordInput';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { SESSION_KEY } from '@/hooks/useSession';
import { api } from '@/services/api';
import { useAuthFlow } from '@/modules/auth/AuthFlow';
import { useWorkspaceView, workspaceViewOptions } from '@/layouts/WorkspaceView';
import { positionLabels } from '@/modules/organizations/common';
import { ProfileExpertContent } from './ProfileExpertContent';
import { ProfileOrganization } from './ProfileOrganization';

type ProfileValues = { avatarUrl: string; idCardNo: string; bio: string };
const profileTabs = [
  { value: 'overview', label: '概览', icon: BookOpen },
  { value: 'profile', label: '个人资料', icon: UserRound },
  { value: 'security', label: '账户安全', icon: ShieldCheck },
  { value: 'projects', label: '我的项目', icon: BriefcaseBusiness },
  { value: 'attendance', label: '排班考勤', icon: CalendarCheck2 },
  { value: 'organization', label: '组织与申请', icon: Building2 },
] as const;

/** 公共账户设置与当前会话角色联动，专家角色提供本人业务入口。 */
export function ProfilePage({ user }: { user: AuthUser }) {
  const { view } = useWorkspaceView();
  const viewLabel = workspaceViewOptions.find((option) => option.value === view)!.label;
  const ViewIcon = view === 'NAVIGATOR' ? Compass : view === 'PM' ? Target : BadgeCheck;
  const showExpert = view === 'EXPERT' && user.roles.includes('EXPERT');
  const showProjects =
    showExpert &&
    (user.organization
      ? ['ADMIN', 'MEMBER'].includes(String(user.organization.position))
      : user.accountType === 'INDIVIDUAL');
  const tabs = profileTabs.filter((tab) =>
    tab.value === 'profile' || tab.value === 'security'
      ? true
      : tab.value === 'projects'
        ? showProjects
        : showExpert,
  );
  const organizationName =
    typeof user.organization?.name === 'string' ? user.organization.name.trim() : '';
  const organizationPosition =
    typeof user.organization?.position === 'string'
      ? positionLabels[user.organization.position as keyof typeof positionLabels]
      : undefined;
  const name = user.nickname || user.realName;
  const [section, setSection] = useState('overview');
  const [editing, setEditing] = useState(false);
  const editButton = useRef<HTMLButtonElement>(null);
  const created = formatProfileDate(user.createdAt);
  const lastLogin = user.lastLoginAt ? formatProfileDate(user.lastLoginAt) : null;

  return (
    <div className="mx-auto max-w-[1200px]">
      <Tabs
        value={
          tabs.some((tab) => tab.value === section) ? section : showExpert ? 'overview' : 'profile'
        }
        onValueChange={(value) => {
          setSection(value);
          setEditing(false);
        }}
        className="grid min-w-0 items-start gap-[32px] lg:grid-cols-[280px_minmax(0,1fr)] lg:gap-[32px]"
      >
        <aside aria-label="个人资料摘要" className="min-w-0">
          <div className="flex min-w-0 items-center gap-[20px] lg:flex-col lg:items-start">
            <UserAvatar
              url={user.avatarUrl}
              name={name}
              className="size-[104px] rounded-full border border-border text-[42px] sm:size-[128px] lg:size-[280px] lg:text-[104px]"
            />
            <div className="min-w-0 flex-1">
              <h1 className="m-0 break-words text-[26px] leading-[34px] font-semibold tracking-normal">
                {name}
              </h1>
              {user.realName !== name && (
                <p className="mt-[4px] break-words text-[16px] leading-[24px] text-[var(--color-neutral-strong)]">
                  {user.realName}
                </p>
              )}
              <div className="mt-[12px] flex flex-wrap gap-[8px] text-[12px] leading-[20px]">
                <span className="rounded-[6px] border bg-card px-[8px] py-[2px] text-[var(--color-neutral-strong)]">
                  {user.accountType === 'ORGANIZATION' ? '组织账号' : '个人账号'}
                </span>
                <span
                  aria-label="当前角色"
                  className="inline-flex items-center gap-[4px] rounded-[6px] bg-accent px-[8px] py-[2px] text-[var(--color-primary-strong)]"
                >
                  <ViewIcon className="size-[14px]" aria-hidden />
                  当前角色 · {viewLabel}
                </span>
                {organizationName && (
                  <span
                    aria-label="组织身份"
                    className="max-w-full break-words rounded-[6px] border bg-card px-[8px] py-[2px] text-[var(--color-neutral-strong)]"
                  >
                    {organizationName} · {organizationPosition ?? '岗位待确认'}
                  </span>
                )}
              </div>
            </div>
          </div>
          <Button
            ref={editButton}
            variant="outline"
            size="settings"
            disabled={editing}
            className="mt-[20px] w-full text-foreground"
            onClick={() => {
              setSection('profile');
              setEditing(true);
            }}
          >
            <Pencil className="size-[16px]" aria-hidden />
            {editing ? '正在编辑' : '编辑资料'}
          </Button>
          {user.bio?.trim() && (
            <p className="mt-[20px] break-words whitespace-pre-wrap text-[14px] leading-[24px]">
              {user.bio}
            </p>
          )}
          <dl className="mt-[20px] flex flex-col gap-[12px] text-[13px] leading-[20px]">
            <div className="flex items-start gap-[8px]">
              <Phone
                className="mt-[2px] size-[16px] shrink-0 text-[var(--color-neutral-strong)]"
                aria-hidden
              />
              <dt className="sr-only">绑定手机</dt>
              <dd className="break-all font-mono">{user.phone}</dd>
            </div>
            <div className="flex items-start gap-[8px]">
              <Fingerprint
                className="mt-[2px] size-[16px] shrink-0 text-[var(--color-neutral-strong)]"
                aria-hidden
              />
              <dt className="sr-only">用户编号</dt>
              <dd className="break-all font-mono">{user.uid}</dd>
            </div>
            {user.idCardNo && (
              <div className="flex items-start gap-[8px]">
                <ShieldCheck
                  className="mt-[2px] size-[16px] shrink-0 text-[var(--color-neutral-strong)]"
                  aria-hidden
                />
                <dt className="sr-only">身份证号</dt>
                <dd className="break-all font-mono">{user.idCardNo}</dd>
              </div>
            )}
            {created && (
              <div className="flex items-start gap-[8px]">
                <CalendarDays
                  className="mt-[2px] size-[16px] shrink-0 text-[var(--color-neutral-strong)]"
                  aria-hidden
                />
                <dt className="sr-only">注册时间</dt>
                <dd>注册于 {created}</dd>
              </div>
            )}
            {lastLogin && (
              <div className="flex items-start gap-[8px]">
                <UserRound
                  className="mt-[2px] size-[16px] shrink-0 text-[var(--color-neutral-strong)]"
                  aria-hidden
                />
                <dt className="sr-only">最近登录</dt>
                <dd>最近登录 {lastLogin}</dd>
              </div>
            )}
          </dl>
          {showExpert && <ProfileOrganization organization={user.organization} />}
        </aside>
        <div className="min-w-0">
          <TabsList
            aria-label="个人中心设置"
            className="mb-[24px] flex h-auto w-full flex-wrap justify-start gap-x-[16px] gap-y-0 rounded-none border-b bg-transparent p-0"
          >
            {tabs.map(({ value, label, icon: Icon }) => (
              <TabsTrigger
                key={value}
                value={value}
                className="h-[48px] gap-[8px] rounded-none border-b-2 border-transparent px-[8px] text-[13px] text-[var(--color-neutral-strong)] data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none"
              >
                <Icon className="size-[17px]" aria-hidden />
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
          {showExpert && (
            <ProfileExpertContent
              user={user}
              showProjects={showProjects}
              onSectionChange={setSection}
            />
          )}
          <TabsContent value="profile" className="m-0 flex-col gap-[20px] data-[state=active]:flex">
            <div className="rounded-[8px] border bg-card p-[20px] sm:p-[24px]">
              <ProfileDetails
                user={user}
                editing={editing}
                setEditing={setEditing}
                editButton={editButton}
              />
            </div>
          </TabsContent>
          <TabsContent
            value="security"
            className="m-0 flex-col gap-[20px] data-[state=active]:flex"
          >
            <div className="rounded-[8px] border bg-card p-[20px] sm:p-[24px]">
              <PasswordSettings user={user} />
            </div>
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}

function formatProfileDate(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium' }).format(date)
    : null;
}

function ProfileDetails({
  user,
  editing,
  setEditing,
  editButton,
}: {
  user: AuthUser;
  editing: boolean;
  setEditing: (value: boolean) => void;
  editButton: RefObject<HTMLButtonElement | null>;
}) {
  const cache = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState<unknown>();
  const [previewAvatar, setPreviewAvatar] = useState(user.avatarUrl);
  const [avatarDraft, setAvatarDraft] = useState<{ file: File; url: string } | null>(null);
  const [avatarFileError, setAvatarFileError] = useState('');
  const [avatarLinkOpen, setAvatarLinkOpen] = useState(false);
  const uploadedAvatar = useRef<{ file: File; result: AvatarUploadResult } | null>(null);
  const inFlight = useRef(false);
  const form = useForm<ProfileValues>({
    defaultValues: { avatarUrl: user.avatarUrl ?? '', idCardNo: '', bio: user.bio ?? '' },
    mode: 'onSubmit',
    reValidateMode: 'onSubmit',
  });
  const wasEditing = useRef(false);
  useEffect(
    () => () => {
      if (avatarDraft) URL.revokeObjectURL(avatarDraft.url);
    },
    [avatarDraft],
  );

  function clearLocalAvatar() {
    setAvatarDraft(null);
    uploadedAvatar.current = null;
    setAvatarFileError('');
  }

  function chooseAvatarFile(file: File | undefined) {
    if (!file) return;
    const extension = file.name.includes('.')
      ? (file.name.split('.').at(-1)?.toLowerCase() ?? '')
      : '';
    if (
      !AVATAR_EXTENSIONS.some((allowed) => allowed === extension) ||
      !file.size ||
      file.size > AVATAR_MAX_BYTES
    ) {
      setAvatarFileError('请选择非空的 JPG、PNG、GIF、BMP 或 WebP 图片，最大 10 MiB');
      return;
    }
    clearLocalAvatar();
    form.clearErrors('avatarUrl');
    form.setValue('avatarUrl', user.avatarUrl ?? '');
    setAvatarDraft({ file, url: URL.createObjectURL(file) });
  }

  useEffect(() => {
    if (editing && !wasEditing.current) {
      form.reset({ avatarUrl: user.avatarUrl ?? '', idCardNo: '', bio: user.bio ?? '' });
      setPreviewAvatar(user.avatarUrl);
      setAvatarLinkOpen(false);
      setNotice('');
      setError(undefined);
      form.setFocus(user.idVerified === 1 ? 'bio' : 'idCardNo');
    }
    wasEditing.current = editing;
  }, [editing, form, user.avatarUrl, user.bio, user.idVerified]);

  function finishEditing() {
    setEditing(false);
    clearLocalAvatar();
    form.reset();
    requestAnimationFrame(() => editButton.current?.focus());
  }

  function validateAvatarUrl(value: string) {
    const url = value.trim();
    if (!url || url === (user.avatarUrl ?? '')) return true;
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'https:' && !parsed.username && !parsed.password) return true;
    } catch {
      // 无效地址由字段提示处理，不发起图片请求。
    }
    return '请输入不含用户名和密码的 HTTPS 图片地址';
  }

  async function save(values: ProfileValues) {
    if (inFlight.current || avatarFileError) return;
    const input: UserProfileUpdateInput = {};
    const avatarUrl = values.avatarUrl.trim();
    const bio = values.bio.trim();
    const idCardNo = (values.idCardNo ?? '').trim().toUpperCase();
    if (avatarUrl !== (user.avatarUrl ?? '')) input.avatarUrl = avatarUrl;
    if (bio !== (user.bio ?? '')) input.bio = bio;
    if (idCardNo && user.idVerified !== 1) input.idCardNo = idCardNo;
    if (!Object.keys(input).length && !avatarDraft) {
      finishEditing();
      setNotice('个人资料没有变化');
      return;
    }
    inFlight.current = true;
    setSaving(true);
    setError(undefined);
    try {
      if (avatarDraft) {
        if (uploadedAvatar.current?.file !== avatarDraft.file)
          uploadedAvatar.current = {
            file: avatarDraft.file,
            result: await api.uploadAvatar(avatarDraft.file),
          };
        input.avatarUrl = uploadedAvatar.current.result.objectKey;
        input.avatarUploadToken = uploadedAvatar.current.result.uploadToken;
      }
      await cache.cancelQueries({ queryKey: SESSION_KEY });
      if (cache.getQueryData<AuthUser | null>(SESSION_KEY)?.id !== user.id) return;
      const updated = await api.updateProfile(input);
      await cache.cancelQueries({ queryKey: SESSION_KEY });
      if (cache.getQueryData<AuthUser | null>(SESSION_KEY)?.id !== user.id) return;
      cache.setQueryData(SESSION_KEY, updated);
      finishEditing();
      setNotice('个人资料已保存');
    } catch (failure) {
      setError(failure);
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  return (
    <section aria-labelledby="profile-details-title" className="flex flex-col gap-[24px]">
      <div className="flex items-center justify-between gap-[16px] border-b border-[var(--color-divider)] pb-[20px]">
        <div>
          <h2 id="profile-details-title" className="m-0 text-[17px] leading-[26px] font-semibold">
            基本信息
          </h2>
          <p className="mt-[4px] text-[13px] leading-[22px] text-[var(--color-neutral-strong)]">
            查看和完善你的账户信息。
          </p>
        </div>
      </div>
      {notice && <Alert>{notice}</Alert>}
      {editing ? (
        <form
          noValidate
          className="flex flex-col gap-[24px]"
          onSubmit={form.handleSubmit(save, (errors) => {
            if (errors.avatarUrl) {
              setAvatarLinkOpen(true);
              requestAnimationFrame(() => form.setFocus('avatarUrl'));
            }
          })}
        >
          <fieldset disabled={saving} className="m-0 min-w-0 space-y-[24px] border-0 p-0">
            <section aria-label="头像设置" className="min-w-0 space-y-[12px]">
              <h3 className="text-[13px] leading-[20px] font-medium">头像</h3>
              <div className="flex min-w-0 items-start gap-[16px]">
                <UserAvatar
                  url={avatarDraft?.url ?? previewAvatar}
                  name={user.nickname || user.realName}
                  className="size-[72px] rounded-full border border-border text-[28px]"
                />
                <div className="min-w-0 flex-1 space-y-[8px]">
                  <div className="flex flex-wrap gap-[8px]">
                    <FileUploadField
                      id="profile-avatar-file"
                      accept={AVATAR_ACCEPT}
                      disabled={saving}
                      aria-label="上传本地头像"
                      aria-invalid={!!avatarFileError}
                      aria-describedby={`profile-avatar-help${avatarFileError ? ' profile-avatar-file-error' : ''}`}
                      contentClassName="rounded-[8px]"
                      onFilesSelected={(files) => chooseAvatarFile(files[0])}
                    >
                      <Button asChild variant="outline" size="account" disabled={saving}>
                        <span>
                          <ImagePlus className="size-[16px]" aria-hidden />
                          更换头像
                        </span>
                      </Button>
                    </FileUploadField>
                    <Button
                      variant="ghost"
                      size="account"
                      onClick={() => {
                        clearLocalAvatar();
                        form.setValue('avatarUrl', '', { shouldDirty: true, shouldValidate: true });
                        setPreviewAvatar(null);
                      }}
                    >
                      <Trash2 className="size-[16px]" aria-hidden />
                      清除头像
                    </Button>
                  </div>
                  <p
                    id="profile-avatar-help"
                    className="text-[12px] leading-[20px] text-[var(--color-neutral-strong)]"
                  >
                    JPG、PNG、GIF、BMP 或 WebP，最大 10 MiB。保存修改后生效。
                  </p>
                  {avatarDraft && (
                    <p className="break-all text-[12px] leading-[20px] text-[var(--color-neutral-strong)]">
                      待保存头像：{avatarDraft.file.name}
                    </p>
                  )}
                </div>
              </div>
              {avatarFileError && (
                <p
                  id="profile-avatar-file-error"
                  role="alert"
                  className="text-[13px] leading-[20px] text-destructive"
                >
                  {avatarFileError}
                </p>
              )}
              <Button
                variant="ghost"
                size="account"
                className="px-[8px] text-[var(--color-neutral-strong)]"
                aria-expanded={avatarLinkOpen}
                aria-controls="profile-avatar-link"
                onClick={() => setAvatarLinkOpen((open) => !open)}
              >
                <LinkIcon className="size-[14px]" aria-hidden />
                使用图片链接
                <ChevronDown
                  className={`size-[14px] ${avatarLinkOpen ? 'rotate-180' : ''}`}
                  aria-hidden
                />
              </Button>
              <div id="profile-avatar-link" hidden={!avatarLinkOpen}>
                <FormField
                  labelClassName="text-[13px] leading-[20px] font-medium"
                  controlId="profile-avatar-url"
                  label="头像地址"
                  error={form.formState.errors.avatarUrl?.message}
                  description="支持 HTTPS 图片地址；填写链接将替换已选本地图片。"
                >
                  {({ invalid, describedBy }) => (
                    <div className="flex min-w-0 flex-wrap items-start gap-[8px]">
                      <Input
                        id="profile-avatar-url"
                        size="profile"
                        className="min-w-0 flex-1 basis-[180px] rounded-[8px] bg-card shadow-none"
                        autoComplete="off"
                        maxLength={512}
                        placeholder="https://example.com/avatar.png"
                        aria-invalid={invalid || undefined}
                        aria-describedby={describedBy}
                        {...form.register('avatarUrl', {
                          maxLength: { value: 512, message: '头像地址不能超过 512 个字符' },
                          validate: validateAvatarUrl,
                          onChange: clearLocalAvatar,
                        })}
                      />
                      <Button
                        variant="outline"
                        size="settings"
                        disabled={!!avatarDraft}
                        onClick={async () => {
                          if (await form.trigger('avatarUrl'))
                            setPreviewAvatar(form.getValues('avatarUrl').trim() || null);
                        }}
                      >
                        预览头像
                      </Button>
                    </div>
                  )}
                </FormField>
              </div>
            </section>
            <FormField
              labelClassName="text-[13px] leading-[20px] font-medium"
              controlId="profile-id-card"
              label="身份证号"
              error={form.formState.errors.idCardNo?.message}
              description={
                user.idVerified === 1
                  ? '已实名认证，身份证号不可修改。'
                  : `留空保留原值${user.idCardNo ? `（${user.idCardNo}）` : ''}，已有号码不会回填。`
              }
            >
              {({ invalid, describedBy }) => (
                <Input
                  id="profile-id-card"
                  size="profile"
                  className="rounded-[8px] bg-card shadow-none"
                  autoComplete="off"
                  maxLength={18}
                  placeholder="请输入 15 位或 18 位身份证号"
                  disabled={user.idVerified === 1}
                  aria-invalid={invalid || undefined}
                  aria-describedby={describedBy}
                  {...form.register('idCardNo', {
                    validate: (value) =>
                      !value.trim() ||
                      /^(\d{15}|\d{17}[0-9X])$/.test(value.trim().toUpperCase()) ||
                      '请输入 15 位或 18 位身份证号',
                  })}
                />
              )}
            </FormField>
            <FormField
              labelClassName="text-[13px] leading-[20px] font-medium"
              controlId="profile-bio"
              label="个人简介"
              error={form.formState.errors.bio?.message}
              description="选填，最多 1000 个字符。"
            >
              {({ invalid, describedBy }) => (
                <Textarea
                  id="profile-bio"
                  className="min-h-[120px] rounded-[8px] bg-card px-[12px] py-[10px] text-[13px] leading-[22px] shadow-none"
                  maxLength={1000}
                  placeholder="介绍你的专业背景、擅长领域或协作经验"
                  aria-invalid={invalid || undefined}
                  aria-describedby={describedBy}
                  {...form.register('bio', {
                    maxLength: { value: 1000, message: '个人简介不能超过 1000 个字符' },
                  })}
                />
              )}
            </FormField>
          </fieldset>
          <ErrorNotice error={error} />
          <div className="flex gap-[12px] border-t border-[var(--color-divider)] pt-[20px]">
            <Button
              variant="outline"
              size="settings"
              disabled={saving}
              onClick={() => {
                finishEditing();
                setError(undefined);
              }}
            >
              取消
            </Button>
            <Button type="submit" variant="dark" size="settings" loading={saving}>
              保存修改
            </Button>
          </div>
        </form>
      ) : (
        <dl className="grid grid-cols-1 gap-x-[32px] gap-y-[24px] text-[13px] leading-[22px] sm:grid-cols-2">
          <div>
            <dt className="mb-[6px] text-[12px] text-[var(--color-neutral-strong)]">真实姓名</dt>
            <dd className="break-words">{user.realName}</dd>
          </div>
          <div>
            <dt className="mb-[6px] text-[12px] text-[var(--color-neutral-strong)]">系统角色</dt>
            <dd className="flex flex-wrap gap-[6px]">
              {user.roles.map((role) => (
                <span
                  key={role}
                  className="inline-flex items-center gap-1.5 rounded-md bg-accent px-2 py-1 text-[12px] text-[var(--color-primary-strong)]"
                >
                  <BadgeCheck className="size-[16px]" aria-hidden />
                  {workspaceViewOptions.find((option) => option.value === role)?.label ?? role}
                </span>
              ))}
            </dd>
          </div>
          <div>
            <dt className="mb-[6px] text-[12px] text-[var(--color-neutral-strong)]">绑定手机</dt>
            <dd className="font-mono">{user.phone}</dd>
          </div>
          <div>
            <dt className="mb-[6px] text-[12px] text-[var(--color-neutral-strong)]">用户编号</dt>
            <dd className="break-all font-mono">{user.uid}</dd>
          </div>
          <div>
            <dt className="mb-[6px] text-[12px] text-[var(--color-neutral-strong)]">身份证号</dt>
            <dd className="break-all font-mono">{user.idCardNo || '未填写'}</dd>
          </div>
          <div>
            <dt className="mb-[6px] text-[12px] text-[var(--color-neutral-strong)]">实名认证</dt>
            <dd>{user.idVerified === 1 ? '已认证' : '未认证'}</dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="mb-[6px] text-[12px] text-[var(--color-neutral-strong)]">个人简介</dt>
            <dd className="min-h-[44px] break-words whitespace-pre-wrap leading-[22px]">
              {user.bio || '还没有填写个人简介，点击编辑资料介绍一下自己吧。'}
            </dd>
          </div>
          {typeof user.organization?.name === 'string' && (
            <div className="sm:col-span-2">
              <dt className="mb-[6px] text-[12px] text-[var(--color-neutral-strong)]">所属组织</dt>
              <dd className="break-words">{user.organization.name}</dd>
            </div>
          )}
        </dl>
      )}
    </section>
  );
}

function PasswordSettings({ user }: { user: AuthUser }) {
  const cache = useQueryClient();
  const navigate = useNavigate();
  const { passwordChanged } = useAuthFlow();
  const inFlight = useRef(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>();
  const form = useForm<{ newPassword: string; confirmNewPassword: string }>({
    defaultValues: { newPassword: '', confirmNewPassword: '' },
    mode: 'onSubmit',
    reValidateMode: 'onSubmit',
  });
  return (
    <section aria-labelledby="security-title" className="flex flex-col gap-[24px]">
      <div className="border-b border-[var(--color-divider)] pb-[20px]">
        <h2 id="security-title" className="m-0 text-[17px] leading-[26px] font-semibold">
          登录密码
        </h2>
        <p className="mt-[6px] text-[13px] leading-[22px] text-[var(--color-neutral-strong)]">
          修改成功后，全部设备需重新登录，包括当前设备。
        </p>
      </div>
      <form
        noValidate
        className="flex flex-col gap-[24px]"
        onSubmit={form.handleSubmit(async (values) => {
          if (inFlight.current) return;
          inFlight.current = true;
          setSaving(true);
          setError(undefined);
          try {
            await cache.cancelQueries({ queryKey: SESSION_KEY });
            await api.changePassword(values.newPassword, values.confirmNewPassword);
            form.reset();
            await cache.cancelQueries();
            passwordChanged();
            cache.clear();
            cache.setQueryData(SESSION_KEY, null);
            await navigate({ to: '/auth', replace: true });
          } catch (failure) {
            setError(failure);
          } finally {
            inFlight.current = false;
            setSaving(false);
          }
        })}
      >
        <input
          type="text"
          name="username"
          autoComplete="username"
          value={user.uid}
          readOnly
          className="sr-only"
          tabIndex={-1}
          aria-hidden
        />
        <fieldset disabled={saving} className="m-0 min-w-0 space-y-[24px] border-0 p-0">
          <FormField
            labelClassName="text-[13px] leading-[20px] font-medium"
            controlId="profile-password"
            label="新密码"
            required
            error={form.formState.errors.newPassword?.message}
            description="8～64 位，须同时包含字母和数字，不支持空格或中文。"
          >
            {({ invalid, describedBy }) => (
              <AuthPasswordInput
                id="profile-password"
                size="profile"
                className="rounded-[8px] bg-card shadow-none"
                maxLength={64}
                autoComplete="new-password"
                placeholder="请输入新密码"
                aria-invalid={invalid || undefined}
                aria-describedby={describedBy}
                {...form.register('newPassword', {
                  required: '请输入新密码',
                  validate: (value) =>
                    new RegExp(passwordPattern).test(value) ||
                    '请输入 8～64 位字母、数字及允许的特殊字符，不能含空格或中文',
                })}
              />
            )}
          </FormField>
          <FormField
            labelClassName="text-[13px] leading-[20px] font-medium"
            controlId="profile-confirm-password"
            label="确认新密码"
            required
            error={form.formState.errors.confirmNewPassword?.message}
          >
            {({ invalid, describedBy }) => (
              <AuthPasswordInput
                id="profile-confirm-password"
                size="profile"
                className="rounded-[8px] bg-card shadow-none"
                maxLength={64}
                autoComplete="new-password"
                placeholder="请再次输入新密码"
                aria-invalid={invalid || undefined}
                aria-describedby={describedBy}
                {...form.register('confirmNewPassword', {
                  required: '请再次输入新密码',
                  validate: (value) =>
                    value === form.getValues('newPassword') || '两次输入的新密码不一致',
                })}
              />
            )}
          </FormField>
        </fieldset>
        <ErrorNotice error={error} />
        <div>
          <Button type="submit" variant="dark" size="settings" loading={saving}>
            更新密码
          </Button>
        </div>
      </form>
    </section>
  );
}
