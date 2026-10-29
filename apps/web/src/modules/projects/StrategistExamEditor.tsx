import { useEffect, useRef, useState, type SetStateAction } from 'react';
import { useBlocker } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Download, FileText, Upload, X } from 'lucide-react';
import {
  type AuthUser,
  type EntranceExamConfiguration,
  type EntranceExamConfigInput,
  type EntranceExamEditInput,
  type EntranceExamReviewer,
  type EntranceExamTemplateType,
  ENTRANCE_EXAM_SOURCE_MAX_BYTES,
} from '@tyde/shared';
import { ErrorNotice } from '@/components/ErrorNotice';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { FileUploadField } from '@/components/ui/shared/FileUploadField';
import { SESSION_KEY } from '@/hooks/useSession';
import { WORKSPACE_ROLE_SWITCH_REQUEST } from '@/layouts/WorkspaceView';
import { api } from '@/services/api';
import { EntranceExamDialog, ENTRANCE_EXAM_LEAVE_REQUEST } from './EntranceExamDialog';
import { saveExamBlob } from './EntranceExamFiles';
import { StrategistExamFields } from './StrategistExamFields';
import { StrategistExamFiles } from './StrategistExamFiles';
import {
  entranceExamConfigurationValues,
  entranceExamImportedValues,
  entranceExamInput,
  examAllFiles,
  newEntranceExam,
  type EntranceExamFormValues,
  type EntranceExamFormErrors,
  type ExamDraftFile,
} from './entrance-exam-form';

export { ENTRANCE_EXAM_LEAVE_REQUEST } from './EntranceExamDialog';
interface StrategistExamEditorProps {
  user: AuthUser;
  projectId: number;
  projectName: string;
  initialConfiguration?: EntranceExamConfiguration;
  reviewerCandidates: EntranceExamReviewer[];
  reviewersLoading: boolean;
  reviewersError: unknown;
  onRetryReviewers: () => void;
  existingExamNames: string[];
  busy: boolean;
  locked: boolean;
  onSave: (input: EntranceExamConfigInput | EntranceExamEditInput) => Promise<void>;
  onVerify: () => Promise<void>;
  onClose: () => void;
}

/** 新建与编辑共用内存表单；父级保留写结果锁，关闭弹框不会重放未知提交。 */
export function StrategistExamEditor(props: StrategistExamEditorProps) {
  const {
    user,
    projectId,
    projectName,
    initialConfiguration,
    busy,
    locked,
    onSave,
    onVerify,
    onClose,
  } = props;
  const cache = useQueryClient();
  const [initial] = useState(() => {
    try {
      return {
        values: initialConfiguration
          ? entranceExamConfigurationValues(initialConfiguration)
          : newEntranceExam(projectName),
        error: null,
      };
    } catch (error) {
      return { values: newEntranceExam(projectName), error };
    }
  });
  const [values, setValues] = useState(initial.values);
  const [errors, setErrors] = useState<EntranceExamFormErrors>({});
  const [error, setError] = useState<unknown>(null);
  const [dirty, setDirty] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [source, setSource] = useState<File | null>(null);
  const [references, setReferences] = useState<ExamDraftFile[]>([]);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<unknown>(null);
  const [importNotice, setImportNotice] = useState('');
  const [template, setTemplate] = useState<EntranceExamTemplateType | null>(null);
  const mounted = useRef(false),
    writing = useRef(false);
  const uploading = [...examAllFiles(values), ...references].some(
    (file) => file.status === 'uploading',
  );
  const working = busy || saving || verifying || importing || uploading;
  const disabled = working || locked || confirming || Boolean(initial.error);
  const editing = initialConfiguration !== undefined;
  const formId = 'strategist-exam-form';
  const label = editing ? '编辑考试' : '创建考试';
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  function sessionMatches() {
    const session = cache.getQueryData<AuthUser | null>(SESSION_KEY);
    return (
      mounted.current && session?.id === user.id && (session.selectedRole ?? session.role) === 'PM'
    );
  }
  function change(next: SetStateAction<EntranceExamFormValues>) {
    setValues(next);
    setDirty(true);
    setErrors({});
    setError(null);
  }
  function close() {
    if (working || writing.current) return;
    if (!dirty || window.confirm('未保存的考试配置将会丢失，确认关闭？')) onClose();
  }
  useEffect(() => {
    function leave(event: Event) {
      if (writing.current || working) {
        event.preventDefault();
        return;
      }
      if (
        dirty &&
        !window.confirm(
          `未保存的考试配置将会丢失，确认切换${event.type === WORKSPACE_ROLE_SWITCH_REQUEST ? '角色' : '模块'}？`,
        )
      )
        event.preventDefault();
    }
    window.addEventListener(WORKSPACE_ROLE_SWITCH_REQUEST, leave);
    window.addEventListener(ENTRANCE_EXAM_LEAVE_REQUEST, leave);
    return () => {
      window.removeEventListener(WORKSPACE_ROLE_SWITCH_REQUEST, leave);
      window.removeEventListener(ENTRANCE_EXAM_LEAVE_REQUEST, leave);
    };
  }, [dirty, working]);
  useBlocker({
    shouldBlockFn: () => {
      const session = cache.getQueryData<AuthUser | null>(SESSION_KEY);
      if (session && (session.id !== user.id || (session.selectedRole ?? session.role) !== 'PM'))
        return false;
      return (
        working ||
        writing.current ||
        (dirty && !window.confirm('未保存的考试配置将会丢失，确认离开？'))
      );
    },
    enableBeforeUnload: () => working || dirty,
  });

  function input() {
    const result = entranceExamInput(projectId, values, {
      existingExamNames: props.existingExamNames,
      originalExamName: initialConfiguration?.examName,
    });
    setErrors(result.errors);
    if (!result.input) {
      setConfirming(false);
      setError(new Error('请修正标注的考试配置后再提交。'));
      requestAnimationFrame(() =>
        document
          .getElementById(formId)
          ?.querySelector<HTMLElement>('[aria-invalid="true"]')
          ?.focus(),
      );
      return null;
    }
    return initialConfiguration
      ? {
          ...result.input,
          examId: initialConfiguration.examId,
          expectedCurrentVersionId: initialConfiguration.currentVersionId,
        }
      : result.input;
  }
  async function submit() {
    if (writing.current || working || locked || !sessionMatches()) return;
    const data = input();
    if (!data) return;
    writing.current = true;
    setSaving(true);
    setError(null);
    try {
      await onSave(data);
    } catch (failure) {
      if (sessionMatches()) setError(failure);
    } finally {
      writing.current = false;
      if (mounted.current) {
        setSaving(false);
        setConfirming(false);
      }
    }
  }
  async function verify() {
    if (working || !sessionMatches()) return;
    if (dirty && !window.confirm('重新读取可能替换未保存的考试配置，确认继续？')) return;
    setVerifying(true);
    setError(null);
    try {
      await onVerify();
    } catch (failure) {
      if (sessionMatches()) setError(failure);
    } finally {
      if (mounted.current) setVerifying(false);
    }
  }
  async function downloadTemplate(type: EntranceExamTemplateType) {
    if (template || disabled || !sessionMatches()) return;
    setTemplate(type);
    setImportError(null);
    try {
      const result = await api.downloadEntranceExamTemplate(type);
      if (sessionMatches()) saveExamBlob(result.blob, result.fileName);
    } catch (failure) {
      if (sessionMatches()) setImportError(failure);
    } finally {
      if (mounted.current) setTemplate(null);
    }
  }
  async function parse() {
    if (disabled || !sessionMatches()) return;
    setImportError(null);
    if (!source) {
      setImportError(new Error('请先选择XLS、XLSX或TXT试卷文件。'));
      return;
    }
    if (references.some((file) => file.status !== 'ready' || !file.reference?.uploadToken)) {
      setImportError(new Error('请先完成导入引用附件上传，或移除失败项。'));
      return;
    }
    const names = references.map((file) => file.name.trim());
    if (
      new Set(names).size !== names.length ||
      references.reduce((sum, file) => sum + file.size, 0) > 50 * 1024 * 1024
    ) {
      setImportError(new Error('引用附件名称不能重复，总大小不超过50 MiB。'));
      return;
    }
    if (dirty && !window.confirm('导入会替换当前未保存的考试配置，确认继续？')) return;
    setImporting(true);
    try {
      const result = await api.parseEntranceExamImport({
        projectId,
        file: source,
        attachmentRefs: references.map((file) => ({
          name: file.name.trim(),
          objectKey: file.reference!.objectKey,
          uploadToken: file.reference!.uploadToken!,
        })),
      });
      if (!sessionMatches()) return;
      change(entranceExamImportedValues(result.config));
      setImportNotice('试卷已解析到当前表单。请补充截止时间、分数与判卷轮次，核对后再发布或保存。');
    } catch (failure) {
      if (sessionMatches()) setImportError(failure);
    } finally {
      if (mounted.current) setImporting(false);
    }
  }
  return (
    <EntranceExamDialog
      label={label}
      title={editing ? `编辑考试 · V${initialConfiguration.versionNo}` : '创建准入考试'}
      onClose={close}
      busy={working}
      footer={
        initial.error ? (
          <Button variant="outline" size="account" onClick={close}>
            关闭
          </Button>
        ) : confirming ? (
          <section
            role="alertdialog"
            aria-label={editing ? '确认保存新版本' : '确认发布考试'}
            className="w-full space-y-[10px] text-[14px] leading-6"
          >
            <h3 className="font-semibold">{editing ? '确认保存新版本' : '确认发布考试'}</h3>
            <p>
              {editing
                ? '保存后将切换为新配置版本，已入场考生绑定的原版本不会改变。'
                : '确认后将创建进行中的考试，请核对试卷、截止时间与阅卷人。'}
              确认提交时会再次检查当前上海截止时间。
            </p>
            <div className="flex flex-wrap justify-end gap-[10px]">
              <Button
                variant="outline"
                size="account"
                disabled={working}
                onClick={() => setConfirming(false)}
              >
                继续填写
              </Button>
              <Button
                size="account"
                loading={working}
                disabled={locked}
                onClick={() => void submit()}
              >
                {editing ? '确认保存' : '确认发布'}
              </Button>
            </div>
          </section>
        ) : (
          <>
            <Button variant="outline" size="account" disabled={working} onClick={close}>
              取消
            </Button>
            <Button
              type="submit"
              form={formId}
              size="account"
              disabled={disabled}
              loading={working}
            >
              {editing ? '保存新版本' : '发布考试'}
            </Button>
          </>
        )
      }
    >
      <p className="text-[13px] leading-6 text-muted-foreground">
        {editing
          ? '保存会生成新版本；已经入场的考生继续使用原试卷和原准入线。'
          : '确认发布后考试立即开放；当前填写内容只保存在本次弹框中。'}
      </p>
      <ErrorNotice error={initial.error} />
      {locked && <Alert>提交结果或权限需要重新核对，当前禁止再次提交。</Alert>}
      {(locked || Boolean(initial.error)) && (
        <Button
          variant="outline"
          size="mobileTouch"
          disabled={working}
          loading={verifying}
          onClick={() => void verify()}
        >
          重新读取考试状态
        </Button>
      )}
      {!initial.error && (
        <>
          <details className="rounded-[12px] border bg-muted/30 p-[16px]">
            <summary className="cursor-pointer text-[14px] font-medium">导入试卷与下载模板</summary>
            <div className="mt-[16px] space-y-[16px]">
              <div className="flex flex-wrap gap-[10px]">
                {(
                  [
                    { type: 'EXCEL', label: 'Excel模板' },
                    { type: 'TXT', label: 'TXT模板' },
                    { type: 'REDOC', label: '文档XML模板' },
                  ] as const
                ).map((item) => (
                  <Button
                    key={item.type}
                    variant="outline"
                    size="mobileTouch"
                    loading={template === item.type}
                    disabled={disabled || template !== null}
                    onClick={() => void downloadTemplate(item.type)}
                  >
                    <Download className="size-4" aria-hidden />
                    {item.label}
                  </Button>
                ))}
              </div>
              <p className="text-[13px] leading-6 text-muted-foreground">
                支持XLS、XLSX、UTF-8 TXT，源文件不超过10
                MiB。远程文档导入暂未开放；本地解析不会创建考试。
              </p>
              <FileUploadField
                aria-label="选择试卷文件"
                accept=".xls,.xlsx,.txt"
                disabled={disabled}
                onFilesSelected={(files) => {
                  const file = files[0];
                  if (!file) return;
                  if (
                    !['xls', 'xlsx', 'txt'].includes(
                      file.name.split('.').at(-1)?.toLowerCase() ?? '',
                    ) ||
                    file.size <= 0 ||
                    file.size > ENTRANCE_EXAM_SOURCE_MAX_BYTES
                  ) {
                    setImportError(new Error('请选择非空XLS、XLSX或TXT文件，最大10 MiB。'));
                    return;
                  }
                  setSource(file);
                  setDirty(true);
                  setImportError(null);
                }}
                contentClassName="min-h-[64px] items-center justify-center gap-[10px] rounded-[10px] border border-dashed p-[16px] text-[13px] text-muted-foreground"
              >
                <Upload className="size-4" aria-hidden />
                选择或拖入试卷文件
              </FileUploadField>
              {source && (
                <div className="flex min-w-0 items-center gap-[10px] rounded-[10px] border p-[12px] text-[13px]">
                  <FileText className="size-4 shrink-0" aria-hidden />
                  <span className="min-w-0 flex-1 break-all">{source.name}</span>
                  <Button
                    variant="dangerGhost"
                    size="iconTouch"
                    aria-label="移除试卷文件"
                    disabled={disabled}
                    onClick={() => {
                      setSource(null);
                      setDirty(true);
                    }}
                  >
                    <X className="size-4" aria-hidden />
                  </Button>
                </div>
              )}
              <StrategistExamFiles
                label="导入引用附件"
                files={references}
                limit={100}
                disabled={disabled}
                user={user}
                onChange={(update) => {
                  setReferences(update);
                  setDirty(true);
                }}
              />
              <Button
                variant="outline"
                size="mobileTouch"
                loading={importing}
                disabled={disabled || !source}
                onClick={() => void parse()}
              >
                解析并填入表单
              </Button>
              <ErrorNotice error={importError} />
              {importNotice && (
                <p role="status" className="text-[13px] text-primary">
                  {importNotice}
                </p>
              )}
            </div>
          </details>
          <form
            id={formId}
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              if (!disabled && input()) setConfirming(true);
            }}
          >
            <fieldset disabled={disabled} className="min-w-0">
              <StrategistExamFields
                {...props}
                values={values}
                onChange={change}
                errors={errors}
                disabled={disabled}
              />
            </fieldset>
          </form>
          <ErrorNotice error={error} />
          {Object.keys(errors).length > 0 && (
            <ul
              role="alert"
              className="list-disc space-y-[4px] pl-[20px] text-[13px] text-destructive"
            >
              {[...new Set(Object.values(errors))].map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </EntranceExamDialog>
  );
}
