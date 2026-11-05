import { useEffect, useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import type { AuthUser, WorkbenchProjectDetail } from '@tyde/shared';
import { SESSION_KEY } from '@/hooks/useSession';
import { api } from '@/services/api';
import { ErrorNotice } from '@/components/ErrorNotice';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';

const difficulty = { EASY: '简单', MEDIUM: '中等', HARD: '困难' };
const education = {
  PHD: '博士',
  MASTER: '硕士',
  BACHELOR: '本科',
  COLLEGE: '大专',
  BELOW_COLLEGE: '大专以下',
};
const employment = { FULL_TIME: '全职', PART_TIME: '兼职', UNLIMITED: '不限' };
const attachmentLabels = { STANDARD_REFERENCE: '标准参考', CASE: '案例', OTHER: '其他' };
function Value({ label, value }: { label: string; value: string | number | null }) {
  return (
    <div className="min-w-0 space-y-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="whitespace-pre-wrap break-words text-[13px] leading-5">{value ?? '未填写'}</dd>
    </div>
  );
}

/** 项目档案按需打开；复用已读取详情，不重挂载背后的流程或候选草稿。 */
export function ProjectDetailsDialog({
  project,
  onClose,
}: {
  project: WorkbenchProjectDetail;
  onClose: () => void;
}) {
  const cache = useQueryClient();
  const identity = useRef(cache.getQueryData<AuthUser | null>(SESSION_KEY));
  const mounted = useRef(false);
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
      !current ||
      current.id !== identity.current?.id ||
      (current.selectedRole ?? current.role) !==
        (identity.current?.selectedRole ?? identity.current?.role)
    )
      throw new Error('当前页面或身份已变化，请重新打开项目附件。');
  }
  const download = useMutation({
    mutationFn: async (file: WorkbenchProjectDetail['attachments'][number]) => {
      requireIdentity();
      const blob = await api.readProjectAttachment(file.objectKey);
      requireIdentity();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = file.fileName.replace(/[\\/\p{Cc}]/gu, '_').trim() || 'project-attachment';
      document.body.append(link);
      try {
        link.click();
      } finally {
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 0);
      }
    },
  });
  return (
    <Dialog
      title="项目详情"
      description={project.projectNo}
      aria-label="项目详情"
      aria-describedby="project-details-description"
      closeLabel="关闭项目详情"
      size="lg"
      onClose={onClose}
      closeOnBackdrop
      contentClassName="space-y-[24px]"
      contentProps={{ role: 'region', 'aria-label': '项目详情内容' }}
      footer={
        <Button variant="outline" size="mobileTouch" onClick={onClose}>
          关闭
        </Button>
      }
    >
      <p id="project-details-description" className="sr-only">
        查看项目基础信息、人员画像、标准配置与参考附件。
      </p>
      <section className="space-y-3" aria-labelledby="project-basic-title">
        <h3 id="project-basic-title" className="text-sm font-semibold">
          基础信息
        </h3>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 lg:grid-cols-3">
          <Value label="项目名称" value={project.projectName} />
          <Value label="需求方" value={project.requesterName} />
          <Value label="创建人" value={project.creatorName} />
          <Value label="一级分类" value={project.categoryLevel1Name} />
          <Value label="二级分类" value={project.categoryLevel2Name} />
          <Value label="三级分类" value={project.categoryLevel3Names.join('、') || null} />
          <Value
            label="项目难度"
            value={project.difficultyLevel ? difficulty[project.difficultyLevel] : null}
          />
          <Value
            label="项目量级"
            value={
              project.projectQuantity == null
                ? null
                : `${project.projectQuantity} ${project.quantityUnit || ''}`
            }
          />
          <Value label="截止时间（上海时间）" value={project.deadline} />
          <Value label="创建时间（上海时间）" value={project.createdAt} />
        </dl>
        <dl>
          <Value label="项目描述" value={project.projectDescription} />
        </dl>
      </section>
      <section className="space-y-3 border-t pt-4" aria-labelledby="project-people-title">
        <h3 id="project-people-title" className="text-sm font-semibold">
          人员画像
        </h3>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 lg:grid-cols-3">
          <Value
            label="需求人数"
            value={project.requiredHeadcount == null ? null : `${project.requiredHeadcount} 人`}
          />
          <Value
            label="学历要求"
            value={project.educationRequirement ? education[project.educationRequirement] : null}
          />
          <Value
            label="人员属性"
            value={project.employmentType ? employment[project.employmentType] : null}
          />
          <Value label="经验要求" value={project.experienceRequirement} />
          <Value label="工作摘要" value={project.workSummary} />
          <Value label="特殊要求" value={project.specialRequirement} />
          <Value label="必备要求" value={project.mandatoryRequirement} />
        </dl>
      </section>
      <section className="space-y-3 border-t pt-4" aria-labelledby="project-standard-title">
        <h3 id="project-standard-title" className="text-sm font-semibold">
          标准配置
        </h3>
        <dl className="space-y-3">
          <Value label="标准说明 / 作业规范" value={project.standardContent} />
          <Value label="标准参考链接" value={project.standardLink} />
        </dl>
        <h3 className="text-sm font-medium">参考附件</h3>
        <ErrorNotice error={download.error} />
        {!project.attachments.length ? (
          <p className="text-[13px] text-muted-foreground">暂无参考附件</p>
        ) : (
          <ul className="divide-y rounded-xl border">
            {project.attachments.map((file) => (
              <li key={file.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
                <div className="min-w-0">
                  <p className="break-all text-sm">{file.fileName}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {attachmentLabels[file.attachmentType]} · {Math.ceil(file.fileSize / 1024)} KB
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="mobileTouch"
                  disabled={download.isPending}
                  loading={download.isPending && download.variables?.id === file.id}
                  onClick={() => download.mutate(file)}
                >
                  <Download className="size-4" aria-hidden />
                  下载
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </Dialog>
  );
}
