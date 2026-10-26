import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useBlocker, useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, Download, FileText, Plus, Upload, X } from 'lucide-react';
import {
  ApiError,
  PROJECT_ATTACHMENT_ACCEPT,
  PROJECT_ATTACHMENT_EXTENSIONS,
  PROJECT_ATTACHMENT_MAX_BYTES,
  type AuthUser,
  type CurrentProjectDraft,
  type ProjectAttachmentInput,
  type ProjectAttachmentUploadResult,
  type ProjectCategory,
  type ProjectDraft,
  type ProjectMutation,
  type ProjectSaveInput,
} from '@tyde/shared';
import { ErrorNotice } from '@/components/ErrorNotice';
import { PageRecovery } from '@/components/PageRecovery';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/shared/FormField';
import { FileUploadField } from '@/components/ui/shared/FileUploadField';
import { api } from '@/services/api';
import { WORKSPACE_ROLE_SWITCH_REQUEST } from '@/layouts/WorkspaceView';
import { SESSION_KEY } from '@/hooks/useSession';
import { ProjectCreateFields } from './ProjectCreateFields';
import {
  projectCreateInput,
  projectCreateSteps,
  projectCreateValues,
  projectStepFields,
  validateProjectCreate,
  type ProjectCreateValues,
} from './project-create-form';

interface Attachment {
  key: string;
  fileName: string;
  size: number;
  id?: number;
  objectKey?: string;
  file?: File;
  upload?: ProjectAttachmentUploadResult;
  status: 'uploading' | 'ready' | 'failed';
  message?: string;
}

/** 以已认领附件 ID 恢复表单，不保留或再次提交一次性上传凭证。 */
function draftAttachments(draft: ProjectDraft | null): Attachment[] {
  return (draft?.attachments ?? []).map((item) => ({
    key: `saved-${item.id}`,
    fileName: item.fileName,
    size: item.fileSize,
    id: item.id,
    objectKey: item.objectKey,
    status: 'ready',
  }));
}

/** 先确认本人草稿和需求方，再开放创建；读取失败时不以空草稿覆盖。 */
export function ProjectCreatePage({ user }: { user: AuthUser }) {
  const draft = useQuery({
    queryKey: ['project-draft', user.id, 'NAVIGATOR'],
    queryFn: () => api.getCurrentProjectDraft(),
    retry: false,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const categories = useQuery({
    queryKey: ['project-categories', user.id, 'NAVIGATOR'],
    queryFn: () => api.getProjectCategories(),
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const requester = useQuery({
    queryKey: ['project-requester', user.id, 'NAVIGATOR'],
    queryFn: () => api.getCurrentProjectRequester(user.id),
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const failure = draft.error ?? categories.error ?? requester.error;
  if (failure)
    return (
      <PageRecovery
        title="暂时无法加载项目创建资料"
        description={failure instanceof Error ? failure.message : '请稍后重试。'}
        onRetry={() => {
          void draft.refetch();
          void categories.refetch();
          void requester.refetch();
        }}
        loading={draft.isFetching || categories.isFetching || requester.isFetching}
      />
    );
  if (
    !draft.data ||
    !categories.data ||
    !requester.data ||
    draft.isFetching ||
    categories.isFetching ||
    requester.isFetching
  )
    return (
      <p className="rounded-[12px] border bg-card p-[24px] text-[14px]" role="status">
        正在读取项目草稿…
      </p>
    );
  return (
    <ProjectCreateForm
      key={user.id}
      user={user}
      initialDraft={draft.data}
      categories={categories.data}
      requesterName={requester.data.requesterName}
    />
  );
}

/** 三步创建、服务端草稿与发布共用同一份受控表单。 */
function ProjectCreateForm({
  user,
  initialDraft,
  categories,
  requesterName,
}: {
  user: AuthUser;
  initialDraft: CurrentProjectDraft;
  categories: ProjectCategory[];
  requesterName: string;
}) {
  const cache = useQueryClient();
  const navigate = useNavigate();
  const form = useForm<ProjectCreateValues>({
    defaultValues: projectCreateValues(initialDraft.draft),
    // 本页统一进行快照校验；失焦清错会使后一个控件在点击中途位移。
    mode: 'onSubmit',
  });
  const [draft, setDraft] = useState(initialDraft.draft);
  const [step, setStep] = useState(0);
  const [attachments, setAttachments] = useState(() => draftAttachments(initialDraft.draft));
  const [attachmentsDirty, setAttachmentsDirty] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [readError, setReadError] = useState<unknown>(null);
  const [fileError, setFileError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const [recovery, setRecovery] = useState<'saved' | 'conflict' | 'unknown' | null>(null);
  const [reloading, setReloading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [published, setPublished] = useState<ProjectMutation | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  const mounted = useRef(false);
  const leaving = useRef(false);
  const writing = useRef(false);
  const save = useMutation({
    mutationFn: (input: ProjectSaveInput) => api.saveProject(input),
    retry: false,
    networkMode: 'always',
  });
  const upload = useMutation({
    mutationFn: (file: File) => api.uploadProjectAttachment(file),
    retry: false,
    networkMode: 'always',
  });
  const uploading = attachments.some((item) => item.status === 'uploading');
  const busy = save.isPending || reloading;
  const dirty = form.formState.isDirty || attachmentsDirty;
  const locked = busy || !!recovery || !!published;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    /** 在会话角色真正改变前保护未保存内容，取消切换保留当前表单。 */
    function beforeRoleSwitch(event: Event) {
      if (leaving.current) return;
      if (
        writing.current ||
        uploading ||
        (dirty && !window.confirm('未保存的填写内容将会丢失，确认切换角色？已保存的草稿会保留。'))
      )
        event.preventDefault();
    }
    window.addEventListener(WORKSPACE_ROLE_SWITCH_REQUEST, beforeRoleSwitch);
    return () => window.removeEventListener(WORKSPACE_ROLE_SWITCH_REQUEST, beforeRoleSwitch);
  }, [dirty, uploading]);

  useBlocker({
    shouldBlockFn: () => {
      const current = cache.getQueryData<AuthUser | null>(SESSION_KEY);
      // 角色切换已在请求前确认；仅成功切换后的真实会话允许守卫离开。
      if (
        current &&
        (current.id !== user.id || (current.selectedRole ?? current.role) !== 'NAVIGATOR')
      )
        return false;
      return (
        !leaving.current &&
        (writing.current ||
          uploading ||
          (dirty && !window.confirm('未保存的填写内容将会丢失，确认离开？已保存的草稿会保留。')))
      );
    },
    enableBeforeUnload: () => !leaving.current && (dirty || writing.current || uploading),
  });

  /** 按步骤展示校验错误，保存草稿不强制未填的发布字段。 */
  function validate(publish: boolean, onlyStep?: number) {
    form.clearErrors();
    const errors = validateProjectCreate(form.getValues(), publish, draft?.createdAt);
    const names = Object.keys(errors).filter(
      (name): name is keyof ProjectCreateValues => name in form.getValues(),
    );
    const visible =
      onlyStep === undefined
        ? names
        : names.filter((name) => projectStepFields[onlyStep]?.includes(name));
    for (const name of visible) form.setError(name, { type: 'validate', message: errors[name] });
    if (visible.length) {
      if (onlyStep === undefined) {
        const firstStep = projectStepFields.findIndex((fields) => fields.includes(visible[0]!));
        if (firstStep >= 0) setStep(firstStep);
      }
      window.setTimeout(() => form.setFocus(visible[0]!), 0);
      return false;
    }
    return true;
  }

  /** 手动回读最新草稿，成功后归一化版本和已认领附件；失败仅重试读取。 */
  async function readDraft(discard = true) {
    if (reloading || writing.current) return;
    if (
      discard &&
      dirty &&
      recovery !== 'saved' &&
      !window.confirm('重新读取会替换当前未保存内容，确认继续？')
    )
      return;
    setReloading(true);
    setReadError(null);
    try {
      const result = await api.getCurrentProjectDraft();
      if (!mounted.current) return;
      cache.setQueryData(['project-draft', user.id, 'NAVIGATOR'], result);
      setDraft(result.draft);
      form.reset(projectCreateValues(result.draft));
      setAttachments(draftAttachments(result.draft));
      setAttachmentsDirty(false);
      setRecovery(null);
      setError(null);
      setFileError(null);
      setNotice(
        result.hasDraft ? '已读取最新草稿。' : '当前没有未发布的草稿，请先核对项目列表后再继续。',
      );
    } catch (failure) {
      if (mounted.current) setReadError(failure);
    } finally {
      if (mounted.current) setReloading(false);
    }
  }

  /** 单次上传不自动重试，失败条目必须明确重试或移除。 */
  async function uploadAttachment(item: Attachment) {
    if (!item.file) return;
    setAttachments((current) =>
      current.map((entry) =>
        entry.key === item.key ? { ...entry, status: 'uploading', message: undefined } : entry,
      ),
    );
    try {
      const result = await upload.mutateAsync(item.file);
      if (mounted.current)
        setAttachments((current) =>
          current.map((entry) =>
            entry.key === item.key
              ? { ...entry, upload: result, objectKey: result.objectKey, status: 'ready' }
              : entry,
          ),
        );
    } catch (failure) {
      if (mounted.current)
        setAttachments((current) =>
          current.map((entry) =>
            entry.key === item.key
              ? {
                  ...entry,
                  status: 'failed',
                  message: failure instanceof Error ? failure.message : '上传失败，请重试或移除。',
                }
              : entry,
          ),
        );
    }
  }

  /** 文件在本地校验后逐个上传，凭证只保留于当前表单内存。 */
  function chooseFiles(files: File[]) {
    if (locked) return;
    const rejected: string[] = [];
    const chosen: Attachment[] = [];
    for (const file of files) {
      const extension = file.name.split('.').at(-1)?.toLowerCase() ?? '';
      if (
        !(PROJECT_ATTACHMENT_EXTENSIONS as readonly string[]).includes(extension) ||
        file.size <= 0 ||
        file.size > PROJECT_ATTACHMENT_MAX_BYTES
      ) {
        rejected.push(`${file.name}：请选择支持格式的非空文件，单个不超过 50 MiB。`);
      } else
        chosen.push({
          key: crypto.randomUUID(),
          fileName: file.name,
          size: file.size,
          file,
          status: 'uploading',
        });
    }
    setFileError(rejected.length ? new Error(rejected.join('；')) : null);
    if (!chosen.length) return;
    setAttachments((current) => [...current, ...chosen]);
    setAttachmentsDirty(true);
    for (const item of chosen) void uploadAttachment(item);
  }

  /** 已认领附件经过登录文件代理下载，不拼接敏感对象的公开地址。 */
  async function download(item: Attachment) {
    if (!item.id || !item.objectKey || downloading) return;
    setDownloading(item.key);
    setFileError(null);
    try {
      const blob = await api.readProjectAttachment(item.objectKey);
      if (!mounted.current) return;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = item.fileName;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (failure) {
      if (mounted.current) setFileError(failure);
    } finally {
      if (mounted.current) setDownloading(null);
    }
  }

  /** 发布或保存只发送一次；写成功和随后读取失败分别反馈。 */
  async function write(operation: ProjectSaveInput['operation']) {
    if (writing.current || locked || (user.selectedRole ?? user.role) !== 'NAVIGATOR') return;
    if (!validate(operation === 'CREATE_PROJECT')) {
      setConfirming(false);
      return;
    }
    if (attachments.some((item) => item.status !== 'ready')) {
      setFileError(new Error('请等待附件上传完成，或移除、重试失败的附件。'));
      setConfirming(false);
      return;
    }
    const inputAttachments: ProjectAttachmentInput[] = attachments.map((item, index) =>
      item.id
        ? { id: item.id, sortNo: index }
        : {
            attachmentType: 'STANDARD_REFERENCE',
            objectKey: item.upload?.objectKey,
            uploadToken: item.upload?.uploadToken,
            sortNo: index,
          },
    );
    writing.current = true;
    setError(null);
    setReadError(null);
    setNotice('');
    let result: ProjectMutation;
    try {
      result = await save.mutateAsync({
        ...projectCreateInput(form.getValues()),
        operation,
        requesterType: 'INDIVIDUAL',
        requesterId: user.id,
        attachments: inputAttachments,
        ...(draft ? { versionNo: draft.versionNo } : {}),
      });
    } catch (failure) {
      if (mounted.current) {
        setError(failure);
        if (failure instanceof ApiError && failure.status === 409) setRecovery('conflict');
        else if (!(failure instanceof ApiError) || failure.status === 0 || failure.status >= 500)
          setRecovery('unknown');
      }
      return;
    } finally {
      writing.current = false;
      if (mounted.current) setConfirming(false);
    }
    if (!mounted.current) return;
    if (operation === 'CREATE_PROJECT') {
      setPublished(result);
      leaving.current = true;
      cache.setQueryData(['project-draft', user.id, 'NAVIGATOR'], { hasDraft: false, draft: null });
      await cache.invalidateQueries({
        queryKey: ['navigator-projects', user.id, 'NAVIGATOR'],
        refetchType: 'none',
      });
      await cache.invalidateQueries({
        queryKey: ['project-draft', user.id, 'NAVIGATOR'],
        refetchType: 'none',
      });
      try {
        await navigate({ to: '/projects', search: { created: result.id }, replace: true });
      } catch {
        if (mounted.current) setNotice('项目已发布，请返回项目列表查看。');
      }
      return;
    }
    setRecovery('saved');
    form.reset(form.getValues());
    setAttachmentsDirty(false);
    await readDraft(false);
    if (mounted.current) setNotice('草稿已保存。');
  }

  return (
    <div className="mx-auto max-w-[920px] space-y-[20px]">
      <header className="flex flex-wrap items-start justify-between gap-[16px]">
        <div>
          <p className="mb-[6px] text-[12px] font-medium text-[var(--color-primary-strong)]">
            领航员 · 项目创建
          </p>
          <h1 className="text-[26px] font-semibold tracking-tight">创建项目</h1>
          <p className="mt-[8px] text-[13px] leading-[21px] text-muted-foreground">
            分三步完善项目，随时保存草稿。发布后进入招募策略官环节。
          </p>
        </div>
        <Button
          variant="outline"
          size="account"
          disabled={busy || uploading}
          onClick={() => void navigate({ to: '/projects' })}
        >
          <ArrowLeft className="size-4" aria-hidden />
          返回项目列表
        </Button>
      </header>
      {published ? (
        <section className="space-y-[16px] rounded-[12px] border bg-card p-[24px]">
          <Check className="size-8 text-[var(--color-success)]" aria-hidden />
          <h2 className="text-[20px] font-semibold">项目已发布</h2>
          <p className="text-[14px]">{notice || '项目已进入招募策略官环节。'}</p>
          <Button
            size="account"
            onClick={() =>
              void navigate({ to: '/projects', search: { created: published.id }, replace: true })
            }
          >
            查看项目
          </Button>
        </section>
      ) : (
        <section className="rounded-[12px] border bg-card p-[20px] sm:p-[28px]">
          <ol
            aria-label="创建项目步骤"
            className="mb-[28px] grid grid-cols-3 gap-[8px] border-b pb-[22px]"
          >
            {projectCreateSteps.map((label, index) => (
              <li
                key={label}
                aria-current={step === index ? 'step' : undefined}
                className={`flex min-w-0 items-center gap-[8px] text-[13px] ${step === index ? 'font-semibold text-[var(--color-primary-strong)]' : 'text-muted-foreground'}`}
              >
                <span
                  className={`grid size-[28px] shrink-0 place-items-center rounded-full ${step === index ? 'bg-[var(--color-primary-soft)]' : 'bg-muted'}`}
                >
                  {index + 1}
                </span>
                <span>{label}</span>
              </li>
            ))}
          </ol>
          {draft && (
            <p className="mb-[20px] text-[12px] text-muted-foreground">
              已恢复草稿 · 最近保存 {draft.updatedAt}
            </p>
          )}
          {notice && (
            <p role="status" className="mb-[16px] text-[13px] text-[var(--color-primary-strong)]">
              {notice}
            </p>
          )}
          <form
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              if (step < 2) {
                if (validate(true, step)) setStep(step + 1);
              } else if (validate(true)) {
                if (attachments.some((item) => item.status !== 'ready'))
                  setFileError(new Error('请等待附件上传完成，或移除、重试失败的附件。'));
                else setConfirming(true);
              }
            }}
          >
            <fieldset disabled={locked} className="space-y-[22px]">
              <legend className="mb-[22px] text-[18px] font-semibold">
                {projectCreateSteps[step]}
              </legend>
              <ProjectCreateFields
                form={form}
                step={step}
                categories={categories}
                requesterName={requesterName}
                creatorName={user.nickname ? `${user.nickname}（${user.realName}）` : user.realName}
              />
              {step === 2 && (
                <FormField
                  controlId="project-create-files"
                  label="项目附件（选填）"
                  description="支持常见文档、图片、压缩包和视频，每个文件不超过 50 MiB。附件仅对有权限的用户开放。"
                >
                  <FileUploadField
                    id="project-create-files"
                    aria-label="选择项目附件"
                    accept={PROJECT_ATTACHMENT_ACCEPT}
                    multiple
                    disabled={locked}
                    onFilesSelected={chooseFiles}
                    contentClassName="rounded-[12px] border border-dashed bg-muted p-[20px]"
                  >
                    <span className="flex items-center gap-[10px] text-[13px]">
                      <Upload className="size-5 text-muted-foreground" aria-hidden />
                      点击选择或拖入附件
                    </span>
                  </FileUploadField>
                  {attachments.length > 0 && (
                    <ul className="mt-[12px] divide-y rounded-[10px] border">
                      {attachments.map((item) => (
                        <li
                          key={item.key}
                          className="flex flex-wrap items-center gap-[8px] p-[12px]"
                        >
                          <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                          <div className="min-w-0 flex-1">
                            <p className="break-all text-[13px]">{item.fileName}</p>
                            <p className="mt-[4px] text-[12px] text-muted-foreground">
                              {(item.size / 1024 / 1024).toFixed(2)} MiB ·{' '}
                              {item.status === 'uploading'
                                ? '上传中…'
                                : item.status === 'failed'
                                  ? '上传失败'
                                  : item.id
                                    ? '已保存'
                                    : '上传完成，待保存'}
                            </p>
                            {item.message && (
                              <p role="alert" className="mt-1 text-[12px] text-destructive">
                                {item.message}
                              </p>
                            )}
                          </div>
                          {item.status === 'failed' && (
                            <Button
                              size="mobileTouch"
                              variant="outline"
                              disabled={locked}
                              onClick={() => void uploadAttachment(item)}
                            >
                              重试上传
                            </Button>
                          )}
                          {item.id && (
                            <Button
                              size="iconTouch"
                              variant="ghost"
                              aria-label={`下载 ${item.fileName}`}
                              loading={downloading === item.key}
                              disabled={downloading !== null}
                              onClick={() => void download(item)}
                            >
                              <Download className="size-4" aria-hidden />
                            </Button>
                          )}
                          <Button
                            size="iconTouch"
                            variant="ghost"
                            aria-label={`移除 ${item.fileName}`}
                            disabled={locked}
                            onClick={() => {
                              setAttachments((current) =>
                                current.filter((entry) => entry.key !== item.key),
                              );
                              setAttachmentsDirty(true);
                            }}
                          >
                            <X className="size-4" aria-hidden />
                          </Button>
                        </li>
                      ))}
                    </ul>
                  )}
                </FormField>
              )}
            </fieldset>
            <div className="mt-[20px] space-y-[12px]">
              <ErrorNotice error={fileError} />
              <ErrorNotice error={error} />
              {recovery && (
                <Alert>
                  <div className="space-y-[12px]">
                    <p>
                      {recovery === 'saved'
                        ? '草稿已保存，但暂时无法读取最新内容。请重新读取后继续。'
                        : recovery === 'conflict'
                          ? '内容已发生变化，请重新读取草稿后再保存。'
                          : '提交结果暂未确认，请先重新读取草稿或返回项目列表核对。'}
                    </p>
                    <Button
                      variant="outline"
                      size="account"
                      loading={reloading}
                      onClick={() => void readDraft()}
                    >
                      重新读取草稿
                    </Button>
                  </div>
                </Alert>
              )}
              <ErrorNotice error={readError} />
            </div>
            <div className="mt-[28px] flex flex-wrap justify-between gap-[12px] border-t pt-[20px]">
              <div>
                {step > 0 && (
                  <Button
                    variant="outline"
                    size="account"
                    disabled={busy}
                    onClick={() => setStep(step - 1)}
                  >
                    上一步
                  </Button>
                )}
              </div>
              <div className="flex flex-wrap gap-[10px]">
                <Button
                  variant="outline"
                  size="account"
                  disabled={locked || uploading}
                  loading={save.isPending && save.variables?.operation === 'SAVE_DRAFT'}
                  onClick={() => void write('SAVE_DRAFT')}
                >
                  保存草稿
                </Button>
                {step < 2 ? (
                  <Button type="submit" size="account" disabled={locked}>
                    下一步
                  </Button>
                ) : (
                  <Button type="submit" size="account" disabled={locked || uploading}>
                    <Plus className="size-4" aria-hidden />
                    发布项目
                  </Button>
                )}
              </div>
            </div>
          </form>
        </section>
      )}
      {confirming && (
        <ProjectPublishConfirmation
          busy={save.isPending}
          onCancel={() => setConfirming(false)}
          onConfirm={() => void write('CREATE_PROJECT')}
        />
      )}
    </div>
  );
}

/** 原生模态框提供焦点约束与返回键，确认后仅发起一次发布。 */
function ProjectPublishConfirmation({
  busy,
  onCancel,
  onConfirm,
}: {
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => node?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      aria-labelledby="project-publish-title"
      aria-describedby="project-publish-description"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onCancel();
      }}
      className="fixed inset-0 m-auto w-[calc(100%-32px)] max-w-[480px] rounded-[12px] border bg-card p-[24px] text-foreground shadow-xl backdrop:bg-black/40"
    >
      <h2 id="project-publish-title" className="text-[18px] font-semibold">
        确认发布项目
      </h2>
      <p
        id="project-publish-description"
        className="mt-[12px] text-[14px] leading-[22px] text-muted-foreground"
      >
        发布后进入招募策略官环节，当前项目资料将作为后续协作依据。确认发布？
      </p>
      <div className="mt-[24px] flex justify-end gap-[10px]">
        <Button variant="outline" size="account" disabled={busy} onClick={onCancel}>
          继续填写
        </Button>
        <Button size="account" loading={busy} onClick={onConfirm}>
          确认发布
        </Button>
      </div>
    </dialog>
  );
}
