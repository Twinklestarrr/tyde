import type { ProjectRecruitmentService, RecruitmentInput } from './project-recruitment.service.js';
import type { RecruitmentQuery } from './project-recruitment-candidates.js';
import { recruitmentSchema } from './project-recruitment.schema.js';
import type {
  ProjectRecruitmentHandlerService,
  HandlerChangeInput,
} from './project-recruitment-handler.service.js';
import { handlerSchema } from './project-recruitment-handler.schema.js';
import type { ProjectMaterialsService, MaterialsInput } from './project-materials.service.js';
import { materialsSchema, materialsConfirmSchema } from './project-materials.schema.js';
import type { ProjectListService } from './project-list.service.js';
import { projectListSchema } from './project-list.schema.js';
import type { ProjectQueryService } from './project-query.service.js';
import { projectQuerySchema } from './project-query.schema.js';
import { productionPlanSchema } from './project-production-plan.schema.js';
import type {
  ProjectProductionPlanService,
  ProductionPlanInput,
} from './project-production-plan.service.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { API_PREFIX } from '@tyde/shared';
import type { Config } from '../../config/index.js';
import { AuthError } from '../auth/auth.error.js';
import type { AuthPrincipal, AuthService } from '../auth/auth.service.js';
import { validateTransport } from '../auth/security.js';
import type { ProjectManagerService, ManagerRecruitInput } from './project-manager.service.js';
import {
  managerCandidatesQuery,
  managerRecruitBody,
  managerCandidates,
  managerRecruitResult,
  projectManagerSchema,
} from './project-manager.schema.js';
import { ProjectFoundationService, type RequesterParams } from './project-foundation.service.js';
import type { ProjectCreationService } from './project-creation.service.js';
import type { ProjectSaveInput } from './project-creation.types.js';
import {
  projectCreationSchema,
  projectSaveBody,
  projectMutation,
  projectDraftResponse,
} from './project-creation.schema.js';
import {
  categoryQuery,
  categoriesResponse,
  requesterParams,
  requesterResponse,
  projectFoundationSchema,
} from './project-foundation.schema.js';

export async function projectFoundationRoutes(
  parent: FastifyInstance,
  service: ProjectFoundationService,
  auth: AuthService,
  config: Config,
  creation: ProjectCreationService,
  managers: ProjectManagerService,
  plans: ProjectProductionPlanService,
  queries: ProjectQueryService,
  lists: ProjectListService,
  materials: ProjectMaterialsService,
  handlers: ProjectRecruitmentHandlerService,
  recruitment: ProjectRecruitmentService,
) {
  await parent.register(async (app) => {
    const identities = new WeakMap<FastifyRequest, AuthPrincipal>();
    app.addHook('onRequest', async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (
        !req.headers['x-tyde-client'] &&
        !req.headers.origin &&
        !req.headers.cookie &&
        !Object.keys(req.headers).some((key) => key.startsWith('sec-fetch-'))
      )
        req.headers['x-tyde-client'] = 'desktop';
      let client;
      try {
        client = validateTransport(req.headers, req.method, [
          ...config.webOrigins,
          ...config.desktopOrigins,
        ]);
      } catch {
        throw new AuthError(403, 'ORIGIN_NOT_ALLOWED', '请求来源或会话凭据组合不可信');
      }
      const token =
        client === 'desktop'
          ? req.headers.authorization?.replace(/^Bearer /, '')
          : req.cookies[config.cookieSecure ? '__Host-tyde_session' : 'tyde_session'];
      identities.set(req, await auth.authenticate(token, client));
    });
    const planProjectId = (value: string) => {
      const id = Number(value);
      if (!Number.isInteger(id) || id < 1 || id > 2147483647)
        throw new AuthError(400, 'VALIDATION_ERROR', '项目ID必须为32位正整数');
      return id;
    };
    app.get<{ Querystring: { projectId: string } }>(
      `${API_PREFIX}/projects/expert-recruitments/detail`,
      { schema: recruitmentSchema('detail') },
      async (req) => ({
        code: 200,
        message: '操作成功',
        data: await recruitment.detail(planProjectId(req.query.projectId), identities.get(req)!),
      }),
    );
    app.get<{
      Querystring: Omit<RecruitmentQuery, 'projectId' | 'current' | 'size'> & {
        projectId: string;
        current?: string;
        size?: string;
      };
    }>(
      `${API_PREFIX}/projects/expert-recruitments/candidates`,
      { schema: recruitmentSchema('candidates') },
      async (req) => ({
        code: 200,
        message: '操作成功',
        data: await recruitment.candidates(
          {
            ...req.query,
            projectId: planProjectId(req.query.projectId),
            current: planProjectId(req.query.current ?? '1'),
            size: Number(req.query.size ?? '20'),
          },
          identities.get(req)!,
        ),
      }),
    );
    app.post<{ Body: RecruitmentInput }>(
      `${API_PREFIX}/projects/expert-recruitments/submit`,
      { schema: recruitmentSchema('submit') },
      async (req) => ({
        code: 200,
        message: '操作成功',
        data: await recruitment.submit(req.body, identities.get(req)!),
      }),
    );
    app.get<{ Querystring: { projectId: string } }>(
      `${API_PREFIX}/projects/expert-recruitments/handler-candidates`,
      { schema: handlerSchema(false) },
      async (req) => ({
        code: 200,
        message: '操作成功',
        data: await handlers.candidates(planProjectId(req.query.projectId), identities.get(req)!),
      }),
    );
    app.post<{ Body: HandlerChangeInput }>(
      `${API_PREFIX}/projects/expert-recruitment-handler/change`,
      { schema: handlerSchema(true) },
      async (req) => ({
        code: 200,
        message: '操作成功',
        data: await handlers.change(req.body, identities.get(req)!),
      }),
    );
    app.get<{ Querystring: { projectId: string } }>(
      `${API_PREFIX}/projects/standard-materials/detail`,
      { schema: materialsSchema(false) },
      async (req) => ({
        code: 200,
        message: '操作成功',
        data: await materials.get(planProjectId(req.query.projectId), identities.get(req)!),
      }),
    );
    app.post<{ Body: MaterialsInput }>(
      `${API_PREFIX}/projects/standard-materials/update`,
      { schema: materialsSchema(true) },
      async (req) => ({
        code: 200,
        message: '操作成功',
        data: await materials.update(req.body, identities.get(req)!),
      }),
    );
    app.post<{ Querystring: { projectId: string } }>(
      `${API_PREFIX}/projects/standard-materials/confirm-read`,
      { schema: materialsConfirmSchema },
      async (req) => ({
        code: 200,
        message: '操作成功',
        data: await materials.confirmRead(planProjectId(req.query.projectId), identities.get(req)!),
      }),
    );
    app.get(`${API_PREFIX}/projects/list`, { schema: projectListSchema(false) }, async (req) => ({
      code: 200,
      message: '操作成功',
      data: await lists.list('NAVIGATOR', identities.get(req)!),
    }));
    app.get(
      `${API_PREFIX}/projects/manager/list`,
      { schema: projectListSchema(true) },
      async (req) => ({
        code: 200,
        message: '操作成功',
        data: await lists.list('PM', identities.get(req)!),
      }),
    );
    app.get<{ Params: { projectId: string } }>(
      `${API_PREFIX}/projects/:projectId`,
      { schema: projectQuerySchema },
      async (req) => ({
        code: 200,
        message: '操作成功',
        data: await queries.detail(planProjectId(req.params.projectId), identities.get(req)!),
      }),
    );
    app.get<{ Querystring: { projectId: string } }>(
      `${API_PREFIX}/projects/production-plan`,
      { schema: productionPlanSchema(false) },
      async (req) => ({
        code: 200,
        message: '操作成功',
        data: await plans.get(planProjectId(req.query.projectId), identities.get(req)!),
      }),
    );
    app.post<{ Querystring: { projectId: string }; Body: ProductionPlanInput }>(
      `${API_PREFIX}/projects/production-plan/confirm`,
      { schema: productionPlanSchema(true) },
      async (req) => ({
        code: 200,
        message: '操作成功',
        data: await plans.confirm(
          planProjectId(req.query.projectId),
          req.body,
          identities.get(req)!,
        ),
      }),
    );
    app.get<{ Querystring: { projectId: string; keyword?: string } }>(
      `${API_PREFIX}/projects/manager-candidates`,
      {
        schema: {
          ...projectManagerSchema(
            'getProjectManagerCandidates',
            '查询项目策略官列表',
            managerCandidates,
          ),
          querystring: managerCandidatesQuery,
        },
      },
      async (req) => {
        const projectId = Number(req.query.projectId);
        if (!Number.isInteger(projectId) || projectId < 1 || projectId > 2147483647)
          throw new AuthError(400, 'VALIDATION_ERROR', '项目ID必须为32位正整数');
        return {
          code: 200,
          message: '操作成功',
          data: await managers.listCandidates(projectId, req.query.keyword, identities.get(req)!),
        };
      },
    );
    app.post<{ Body: ManagerRecruitInput }>(
      `${API_PREFIX}/projects/manager-recruitments`,
      {
        schema: {
          ...projectManagerSchema(
            'recruitProjectManager',
            '招募或更换策略官',
            managerRecruitResult,
          ),
          body: managerRecruitBody,
        },
      },
      async (req) => ({
        code: 200,
        message: '操作成功',
        data: await managers.recruit(req.body, identities.get(req)!),
      }),
    );
    app.get(
      `${API_PREFIX}/projects/draft/current`,
      {
        schema: projectCreationSchema(
          'getCurrentProjectDraft',
          '查询当前草稿',
          projectDraftResponse,
        ),
      },
      async (req) => ({
        code: 200,
        message: '操作成功',
        data: await creation.currentDraft(identities.get(req)!),
      }),
    );
    app.post<{ Body: ProjectSaveInput }>(
      `${API_PREFIX}/projects/create`,
      {
        schema: {
          ...projectCreationSchema('saveOrCreateProject', '保存草稿或创建项目', projectMutation),
          body: projectSaveBody,
        },
      },
      async (req) => ({
        code: 200,
        message: '操作成功',
        data: await creation.save(req.body, identities.get(req)!),
      }),
    );
    app.get<{ Querystring: { categoryLevel?: string; keyword?: string } }>(
      `${API_PREFIX}/project-categories`,
      {
        schema: {
          ...projectFoundationSchema(
            'getProjectCategories',
            '查询项目类型',
            '三个分类级别独立；只返回启用分类，按级别、展示顺序、ID排序。字典由受信运维维护，本迁移不自动导入旧库数据。',
            categoriesResponse,
          ),
          querystring: categoryQuery,
        },
      },
      async (req) => ({
        code: 200,
        message: '操作成功',
        data: await service.categories(
          {
            ...(req.query.categoryLevel !== undefined
              ? { categoryLevel: Number(req.query.categoryLevel) }
              : {}),
            ...(req.query.keyword !== undefined ? { keyword: req.query.keyword } : {}),
          },
          identities.get(req)!,
        ),
      }),
    );
    app.get<{ Params: RequesterParams }>(
      `${API_PREFIX}/project-requesters/:requesterType/:requesterId/backfill`,
      {
        schema: {
          ...projectFoundationSchema(
            'getProjectRequesterBackfill',
            '回填需求方信息',
            '只回填本人账号；类型必须一致。组织账号按现有有效多组织关系选择OWNER优先、最早加入的组织，不允许指定他人或组织代替本人。',
            requesterResponse,
          ),
          params: requesterParams,
        },
      },
      async (req) => ({
        code: 200,
        message: '操作成功',
        data: await service.requester(req.params, identities.get(req)!),
      }),
    );
  });
}
