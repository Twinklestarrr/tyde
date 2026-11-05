import { Prisma, type PrismaClient, type Project, type ProjectCategory } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { AppError } from '../../common/errors.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import type { FileRegistryService } from '../files/file-registry.service.js';
import { syncProjectAttachments } from './project-attachments.js';
import type { ProjectSaveInput } from './project-creation.types.js';
import { displayName, projectDetailData, projectDetailInclude } from './project-detail.js';
import { resolveCurrentRequester } from './project-requester.js';
import { parseProjectTime, projectTime } from './project-time.js';

const bad = (message: string) => new AppError(400, 'VALIDATION_ERROR', message);
const conflict = (message: string) => new AppError(409, 'DUPLICATE', message);
const text = (value?: string | null) => value?.trim() || null;
const draftWhere = (uid: string) => ({ createdBy: uid, status: 'DRAFT', deleted: false });

export class ProjectCreationService {
  constructor(
    readonly db: PrismaClient,
    readonly files: FileRegistryService,
  ) {}

  async currentDraft(principal: AuthPrincipal) {
    return this.db.$transaction(
      async (tx) => {
        const draft = await tx.project.findFirst({
          where: draftWhere(principal.uid),
          include: projectDetailInclude,
        });
        return draft
          ? { hasDraft: true, draft: await projectDetailData(tx, draft) }
          : { hasDraft: false, draft: null };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  async save(input: ProjectSaveInput, principal: AuthPrincipal) {
    try {
      return await this.db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${principal.userId}::uuid FOR UPDATE`;
        const { requester, user } = await resolveCurrentRequester(tx, principal, input);
        const draft = await tx.project.findFirst({ where: draftWhere(principal.uid) });
        if (draft) {
          if (input.versionNo == null) throw bad('已有草稿时versionNo不能为空');
          if (input.versionNo !== draft.versionNo) throw conflict('草稿已被更新，请刷新后重试');
        }
        const now = new Date();
        const data = this.snapshot(input, requester, principal.uid);
        const third = input.categoryLevel3Ids ?? [];
        if (new Set(third).size !== third.length) throw bad('三级分类标签不能重复');
        if (input.operation === 'CREATE_PROJECT') {
          // 按旧服务实际校验：标准正文/必备要求必填，链接不能代替正文；描述/简介非必填。
          if (
            !data.projectName ||
            input.categoryLevel1Id == null ||
            input.categoryLevel2Id == null ||
            third.length === 0 ||
            !data.difficultyLevel ||
            data.projectQuantity == null ||
            !data.quantityUnit ||
            !data.deadline ||
            data.requiredHeadcount == null ||
            !data.employmentType ||
            !data.standardContent ||
            !data.mandatoryRequirement
          )
            throw bad('必填信息未填写');
        }
        const categories: ProjectCategory[] = [];
        const resolveCategory = async (id: number | null | undefined, level: number) => {
          if (id == null) return;
          const category = await tx.projectCategory.findUnique({ where: { id } });
          if (!category || category.status !== 'ENABLED' || category.categoryLevel !== level)
            throw bad('项目类型不存在、已停用或分类级别不匹配');
          categories.push(category);
        };
        await resolveCategory(input.categoryLevel1Id, 1);
        await resolveCategory(input.categoryLevel2Id, 2);
        for (const id of third) await resolveCategory(id, 3);
        if (data.projectQuantity != null && data.projectQuantity.lte(0)) throw bad('项目量级异常');
        if (data.requiredHeadcount != null && data.requiredHeadcount <= 0)
          throw bad('需求人数异常');
        if (data.deadline && data.deadline <= (draft?.createdAt ?? now)) throw bad('截止时间异常');
        const publishing = input.operation === 'CREATE_PROJECT';
        if (
          publishing &&
          (await tx.project.findFirst({
            where: {
              requesterType: requester.requesterType,
              requesterId: requester.requesterId,
              projectName: data.projectName,
              status: 'PUBLISHED',
              deleted: false,
              ...(draft ? { id: { not: draft.id } } : {}),
            },
            select: { id: true },
          }))
        )
          throw conflict('已有同名项目，请确认或修改名称');
        const state = {
          status: publishing ? 'PUBLISHED' : 'DRAFT',
          currentNodeCode: publishing ? 'RECRUIT_PROJECT_MANAGER' : null,
          publishedAt: publishing ? now : null,
          updatedAt: now,
        };
        let saved: Project;
        if (draft) {
          const updated = await tx.project.updateMany({
            where: { id: draft.id, ...draftWhere(principal.uid), versionNo: draft.versionNo },
            data: { ...data, ...state, versionNo: { increment: 1 } },
          });
          if (updated.count !== 1) throw conflict('草稿已被更新，请刷新后重试');
          saved = await tx.project.findUniqueOrThrow({ where: { id: draft.id } });
        } else {
          saved = await tx.project.create({
            data: {
              ...data,
              ...state,
              createdBy: principal.uid,
              projectNo: `PRJ${projectTime(now).replace(/[- :]/g, '')}${randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase()}`,
              versionNo: 0,
              createdAt: now,
            },
          });
        }
        await tx.projectCategoryRelation.deleteMany({ where: { projectId: saved.id } });
        for (const category of categories)
          await tx.projectCategoryRelation.create({
            data: {
              projectId: saved.id,
              categoryId: category.id,
              categoryLevel: category.categoryLevel,
              categoryNameSnapshot: category.categoryName,
              sortNo: category.categoryLevel === 3 ? third.indexOf(category.id) : 0,
              createdBy: principal.uid,
            },
          });
        await syncProjectAttachments(
          tx,
          this.files,
          saved.id,
          input.attachments,
          principal.uid,
          displayName(user.displayName, user.realName, principal.uid),
        );
        return {
          id: saved.id,
          projectNo: saved.projectNo,
          operation: input.operation,
          status: saved.status,
          currentNodeCode: saved.currentNodeCode,
          versionNo: saved.versionNo,
          updatedAt: projectTime(saved.updatedAt),
          publishedAt: saved.publishedAt ? projectTime(saved.publishedAt) : null,
        };
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        ['P2002', 'P2000', 'P2020'].includes(error.code)
      )
        throw conflict('项目数据发生冲突，请刷新后重试');
      throw error;
    }
  }

  private snapshot(
    input: ProjectSaveInput,
    requester: { requesterType: string; requesterId: string; requesterName: string },
    uid: string,
  ) {
    return {
      requesterType: requester.requesterType,
      requesterId: requester.requesterId,
      requesterName: requester.requesterName,
      projectName: text(input.projectName),
      projectDescription: text(input.projectDescription),
      difficultyLevel: input.difficultyLevel ?? null,
      projectQuantity:
        input.projectQuantity != null ? new Prisma.Decimal(input.projectQuantity) : null,
      quantityUnit: text(input.quantityUnit),
      deadline: input.deadline != null ? parseProjectTime(input.deadline) : null,
      requiredHeadcount: input.requiredHeadcount ?? null,
      educationRequirement: input.educationRequirement ?? 'BACHELOR',
      employmentType: input.employmentType ?? null,
      experienceRequirement: text(input.experienceRequirement),
      workSummary: text(input.workSummary),
      specialRequirement: text(input.specialRequirement),
      mandatoryRequirement: text(input.mandatoryRequirement),
      standardContent: text(input.standardContent),
      standardLink: text(input.standardLink),
      updatedBy: uid,
    };
  }
}
