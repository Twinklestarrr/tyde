import { useEffect, useRef } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Download, X } from 'lucide-react';
import type { WorkbenchProjectDetail } from '@tyde/shared';
import { api } from '@/services/api';
import { ErrorNotice } from '@/components/ErrorNotice';
import { Button } from '@/components/ui/button';

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
    <div className="min-w-0 space-y-1">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="whitespace-pre-wrap break-words text-[13px] leading-6">{value ?? '未填写'}</dd>
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
  const dialog = useRef<HTMLDialogElement>(null);
  const backdropPressed = useRef(false);
  useEffect(() => {
    const node = dialog.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    node?.showModal();
    document.body.style.overflow = 'hidden';
    return () => {
      node?.close();
      document.body.style.overflow = overflow;
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);
  const download = useMutation({
    mutationFn: async (file: WorkbenchProjectDetail['attachments'][number]) => {
      const blob = await api.readProjectAttachment(file.objectKey);
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
    <dialog
      ref={dialog}
      aria-labelledby="project-details-title"
      aria-describedby="project-details-description"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onPointerDown={(event) => {
        const box = event.currentTarget.getBoundingClientRect();
        backdropPressed.current =
          event.target === event.currentTarget &&
          (event.clientX < box.left ||
            event.clientX > box.right ||
            event.clientY < box.top ||
            event.clientY > box.bottom);
      }}
      onClick={(event) => {
        if (backdropPressed.current && event.target === event.currentTarget) onClose();
      }}
      className="fixed inset-0 m-auto max-h-[calc(100dvh-32px)] w-[calc(100%-32px)] max-w-[960px] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden rounded-[16px] border bg-card p-0 text-foreground shadow-xl backdrop:bg-black/40 open:grid"
    >
      <header className="flex min-w-0 items-start justify-between gap-4 border-b p-5">
        <div className="min-w-0">
          <h2 id="project-details-title" className="text-lg font-semibold">
            项目详情
          </h2>
          <p className="mt-1 break-all text-xs text-muted-foreground">{project.projectNo}</p>
          <p className="mt-2 line-clamp-2 break-words text-sm font-medium">
            {project.projectName || '未命名项目'}
          </p>
          <p id="project-details-description" className="sr-only">
            查看项目基础信息、人员画像、标准配置与参考附件。
          </p>
        </div>
        <Button variant="ghost" size="account" aria-label="关闭项目详情" onClick={onClose}>
          <X className="size-4" aria-hidden />
        </Button>
      </header>
      <div
        role="region"
        aria-label="项目详情内容"
        className="min-h-0 space-y-4 overflow-y-auto overscroll-contain p-4 sm:p-5"
      >
        <section
          className="rounded-[16px] border bg-card p-5 sm:p-6"
          aria-labelledby="project-basic-title"
        >
          <h3 id="project-basic-title" className="mb-5 text-base font-semibold">
            基础信息
          </h3>
          <dl className="grid gap-x-8 gap-y-5 sm:grid-cols-2 lg:grid-cols-3">
            <Value label="项目名称" value={project.projectName} />
            <Value label="项目描述" value={project.projectDescription} />
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
        </section>
        <section
          className="rounded-[16px] border bg-card p-5 sm:p-6"
          aria-labelledby="project-people-title"
        >
          <h3 id="project-people-title" className="mb-5 text-base font-semibold">
            人员画像
          </h3>
          <dl className="grid gap-x-8 gap-y-5 sm:grid-cols-2 lg:grid-cols-3">
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
        <section
          className="rounded-[16px] border bg-card p-5 sm:p-6"
          aria-labelledby="project-standard-title"
        >
          <h3 id="project-standard-title" className="mb-5 text-base font-semibold">
            标准配置
          </h3>
          <dl className="space-y-5">
            <Value label="标准说明 / 作业规范" value={project.standardContent} />
            <Value label="标准参考链接" value={project.standardLink} />
          </dl>
          <h3 className="mt-6 mb-3 text-sm font-medium">参考附件</h3>
          <ErrorNotice error={download.error} />
          {!project.attachments.length ? (
            <p className="text-[13px] text-muted-foreground">暂无参考附件</p>
          ) : (
            <ul className="divide-y rounded-xl border">
              {project.attachments.map((file) => (
                <li key={file.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
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
      </div>
      <footer className="flex justify-end border-t px-5 py-4">
        <Button variant="outline" size="mobileTouch" onClick={onClose}>
          关闭
        </Button>
      </footer>
    </dialog>
  );
}
