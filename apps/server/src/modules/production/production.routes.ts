import {
  QualityService,
  type ProductionQuery,
  type QualityContext,
  type QualityInput,
} from './quality.service.js';
import {
  AcceptanceService,
  type AcceptanceKey,
  type AcceptanceSubmit,
  type AcceptanceReview,
} from './acceptance.service.js';
import * as qa from './quality-acceptance.schema.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { API_PREFIX } from '@tyde/shared';
import type { Config } from '../../config/index.js';
import type { AuthPrincipal, AuthService } from '../auth/auth.service.js';
import { AuthError } from '../auth/auth.error.js';
import { validateTransport } from '../auth/security.js';
import { ProductionService } from './production.service.js';
import { OutputReportService } from './output-report.service.js';
import type {
  ReportQuery,
  ReportSave,
  ReportCorrect,
  ReportReview,
} from './output-report.domain.js';
import {
  reportableBody,
  assigneesBody,
  reportsBody,
  saveBody,
  correctBody,
  reviewBody,
  reportableResponse,
  assigneesResponse,
  reportsResponse,
  nullReportResponse,
} from './output-report.schema.js';
import type { TaskQuery, TaskInput } from './production-domain.js';
import {
  productionSchema,
  membersBody,
  membersResponse,
  createBody,
  listBody,
  listResponse,
} from './production.schema.js';
export async function productionRoutes(
  parent: FastifyInstance,
  service: ProductionService,
  auth: AuthService,
  config: Config,
) {
  const quality = new QualityService(service.db);
  const acceptance = new AcceptanceService(service.db);
  const output = new OutputReportService(service.db);
  await parent.register(async (app) => {
    const identities = new WeakMap<FastifyRequest, AuthPrincipal>();
    app.addHook('onRequest', async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (
        !req.headers['x-tyde-client'] &&
        !req.headers.origin &&
        !req.headers.cookie &&
        !Object.keys(req.headers).some((k) => k.startsWith('sec-fetch-'))
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

    app.post<{ Body: TaskQuery }>(
      `${API_PREFIX}/production-tasks/members`,
      {
        schema: productionSchema(
          'listProductionTaskMembers',
          '查询可指定人员',
          membersBody,
          membersResponse,
        ),
      },
      async (req) => ({
        code: 200,
        message: '操作成功',
        data: await service.members(req.body, identities.get(req)!),
      }),
    );
    app.post<{ Body: TaskInput }>(
      `${API_PREFIX}/production-tasks/create`,
      {
        schema: productionSchema('createProductionTask', '创建生产子任务', createBody, {
          type: 'null',
          description: '创建成功data为null；子任务、指定关系、轮次和PENDING通知同事务。',
          examples: [null],
        }),
      },
      async (req) => ({
        code: 200,
        message: '操作成功',
        data: await service.create(req.body, identities.get(req)!),
      }),
    );
    app.post<{ Body: TaskQuery }>(
      `${API_PREFIX}/production-tasks/list`,
      {
        schema: productionSchema(
          'listProductionTasks',
          '查询生产子任务列表',
          listBody,
          listResponse,
        ),
      },
      async (req) => ({
        code: 200,
        message: '操作成功',
        data: await service.list(req.body, identities.get(req)!),
      }),
    );
    app.post<{ Body: { projectId: number } }>(
      `${API_PREFIX}/production-tasks/reportable-list`,
      {
        schema: productionSchema(
          'listReportableProductionTasks',
          '查询本人可报量子任务',
          reportableBody,
          reportableResponse,
        ),
      },
      async (req) => ({
        code: 200,
        message: '操作成功',
        data: await output.reportable(req.body, identities.get(req)!),
      }),
    );
    app.post<{ Body: TaskQuery & { subtaskId: number } }>(
      `${API_PREFIX}/production-tasks/member-list`,
      {
        schema: productionSchema(
          'listProductionTaskAssignees',
          '查询子任务作业人员明细',
          assigneesBody,
          assigneesResponse,
        ),
      },
      async (req) => ({
        code: 200,
        message: '操作成功',
        data: await output.assignees(req.body, identities.get(req)!),
      }),
    );
    app.post<{ Body: ReportQuery }>(
      `${API_PREFIX}/production-tasks/reports`,
      {
        schema: productionSchema(
          'listProductionOutputReports',
          '查询报量数据',
          reportsBody,
          reportsResponse,
        ),
      },
      async (req) => ({
        code: 200,
        message: '操作成功',
        data: await output.reports(req.body, identities.get(req)!),
      }),
    );
    app.post<{ Body: ReportSave }>(
      `${API_PREFIX}/production-tasks/report/save`,
      {
        bodyLimit: 512 * 1024,
        schema: productionSchema(
          'saveProductionOutputReports',
          '批量保存日报量',
          saveBody,
          nullReportResponse,
        ),
      },
      async (req) => ({
        code: 200,
        message: '操作成功',
        data: await output.save(req.body, identities.get(req)!),
      }),
    );
    app.post<{ Body: ReportCorrect }>(
      `${API_PREFIX}/production-tasks/report/correct`,
      {
        schema: productionSchema(
          'correctProductionOutputReport',
          '修正已退回报量',
          correctBody,
          nullReportResponse,
        ),
      },
      async (req) => ({
        code: 200,
        message: '操作成功',
        data: await output.correct(req.body, identities.get(req)!),
      }),
    );
    app.post<{ Body: ReportReview }>(
      `${API_PREFIX}/production-tasks/report/review`,
      {
        schema: productionSchema(
          'reviewProductionOutputReports',
          '核查日报量',
          reviewBody,
          nullReportResponse,
        ),
      },
      async (req) => ({
        code: 200,
        message: '操作成功',
        data: await output.review(req.body, identities.get(req)!),
      }),
    );
    app.post<{ Body: ProductionQuery }>(
      `${API_PREFIX}/project-personnel/production/list`,
      {
        schema: productionSchema(
          'listPersonnelProduction',
          '查询人员日生产情况',
          qa.productionListBody,
          qa.productionListResponse,
        ),
      },
      async (req) => ({
        code: 200,
        message: '操作成功',
        data: await quality.list(req.body, identities.get(req)!),
      }),
    );
    app.post<{ Body: QualityContext }>(
      `${API_PREFIX}/project-personnel/production/quality/context`,
      {
        schema: productionSchema(
          'getPersonnelQualityContext',
          '查询质量记录弹窗',
          qa.qualityContextBody,
          qa.qualityContextResponse,
        ),
      },
      async (req) => ({
        code: 200,
        message: '操作成功',
        data: await quality.context(req.body, identities.get(req)!),
      }),
    );
    app.post<{ Body: QualityInput }>(
      `${API_PREFIX}/project-personnel/production/quality/save`,
      {
        bodyLimit: 512 * 1024,
        schema: productionSchema(
          'savePersonnelQuality',
          '追加人工质量记录',
          qa.qualitySaveBody,
          qa.nullQualityAcceptance,
        ),
      },
      async (req) => ({
        code: 200,
        message: '操作成功',
        data: await quality.save(req.body, identities.get(req)!),
      }),
    );
    app.post<{ Body: AcceptanceKey }>(
      `${API_PREFIX}/production-tasks/acceptance/context`,
      {
        schema: productionSchema(
          'getProductionAcceptanceContext',
          '查询提交验收上下文',
          qa.acceptanceContextBody,
          qa.acceptanceContextResponse,
        ),
      },
      async (req) => ({
        code: 200,
        message: '操作成功',
        data: await acceptance.context(req.body, identities.get(req)!),
      }),
    );
    app.post<{ Body: AcceptanceSubmit }>(
      `${API_PREFIX}/production-tasks/acceptance/submit`,
      {
        schema: productionSchema(
          'submitProductionAcceptance',
          '提交子任务验收',
          qa.acceptanceSubmitBody,
          qa.nullQualityAcceptance,
        ),
      },
      async (req) => ({
        code: 200,
        message: '操作成功',
        data: await acceptance.submit(req.body, identities.get(req)!),
      }),
    );
    app.post<{ Body: AcceptanceReview }>(
      `${API_PREFIX}/production-tasks/acceptance/review`,
      {
        schema: productionSchema(
          'reviewProductionAcceptance',
          '领航员验收子任务',
          qa.acceptanceReviewBody,
          qa.nullQualityAcceptance,
        ),
      },
      async (req) => ({
        code: 200,
        message: '操作成功',
        data: await acceptance.review(req.body, identities.get(req)!),
      }),
    );
  });
}
