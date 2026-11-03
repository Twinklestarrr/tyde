import type {
  ExamCandidateCommandService,
  CandidateAttemptInput,
  CandidateSubmitInput,
} from './exam-candidate-command.service.js';
import type { ExamCandidateService } from './exam-candidate.service.js';
import { candidateCommandSchema, candidateSchema } from './exam-candidate.schema.js';
import type { ExamAutoService } from './exam-auto.service.js';
import type { AutoRetryInput, AutoCompensateInput } from './exam-auto.types.js';
import { autoRetrySchema, autoCompensateSchema } from './exam-auto.schema.js';
import type { ExamQueryService, ExamLocator, ExamRosterInput } from './exam-query.service.js';
import type { ExamAdmissionInput } from './exam-admission.js';
import { examAdmissionSchema } from './exam-admission.schema.js';
import type { ExamGradingDetailInput } from './exam-grading-query.js';
import { examGradingDetailSchema } from './exam-grading-query.schema.js';
import type {
  ExamGradingCommandService,
  ManualGradingInput,
} from './exam-grading-command.service.js';
import { manualGradingSchema } from './exam-grading-command.schema.js';
import { examQuerySchema } from './exam-query.schema.js';
import { examConfigRouteSchema } from './exam-config.schema.js';
import type { ExamConfigInput, ExamEditInput } from './exam-config.types.js';
import type { ExamCommandService } from './exam-command.service.js';
import type { ExamImportService } from './exam-import.service.js';
import { examImportRoutes } from './exam-import.routes.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { API_PREFIX } from '@tyde/shared';
import type { Config } from '../../config/index.js';
import { AuthError } from '../auth/auth.error.js';
import type { AuthPrincipal, AuthService } from '../auth/auth.service.js';
import { validateTransport } from '../auth/security.js';
import type { ExamManagementService } from './exam-management.service.js';
import type { ExamTemplateType } from './exam-import-template.js';
import { examSchema } from './exam-management.schema.js';

export async function examManagementRoutes(
  parent: FastifyInstance,
  service: ExamManagementService,
  auth: AuthService,
  config: Config,
  imports: ExamImportService,
  commands: ExamCommandService,
  queries: ExamQueryService,
  gradings: ExamGradingCommandService,
  auto: ExamAutoService,
  candidates: ExamCandidateService,
  candidateCommands: ExamCandidateCommandService,
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
        client = validateTransport(req.headers, req.method, config.webOrigins);
      } catch {
        throw new AuthError(403, 'ORIGIN_NOT_ALLOWED', '请求来源或会话凭据组合不可信');
      }
      const token =
        client === 'desktop'
          ? req.headers.authorization?.replace(/^Bearer /, '')
          : req.cookies[config.cookieSecure ? '__Host-tyde_session' : 'tyde_session'];
      identities.set(req, await auth.authenticate(token, client));
    });
    app.get<{ Querystring: { projectId: string } }>(
      `${API_PREFIX}/entrance-exams/current`,
      { schema: candidateSchema(false) },
      async (req) => ({
        code: 200,
        message: '操作成功',
        data: await candidates.current(Number(req.query.projectId), identities.get(req)!),
      }),
    );
    app.post<{ Body: { projectId: number } }>(
      `${API_PREFIX}/entrance-exams/enter`,
      { schema: candidateSchema(true) },
      async (req) => ({
        code: 200,
        message: '操作成功',
        data: await candidates.enter(req.body.projectId, identities.get(req)!),
      }),
    );
    app.post<{ Body: CandidateSubmitInput }>(
      `${API_PREFIX}/entrance-exams/submit`,
      { schema: candidateCommandSchema(true), bodyLimit: 2 * 1024 * 1024 },
      async (req) => ({
        code: 200,
        message: '操作成功',
        data: await candidateCommands.submit(req.body, identities.get(req)!),
      }),
    );
    app.post<{ Body: CandidateAttemptInput }>(
      `${API_PREFIX}/entrance-exams/cancel`,
      { schema: candidateCommandSchema(false) },
      async (req) => ({
        code: 200,
        message: '操作成功',
        data: await candidateCommands.cancel(req.body, identities.get(req)!),
      }),
    );
    app.get<{
      Querystring: Omit<ExamAdmissionInput, 'projectId' | 'current' | 'size'> & {
        projectId: string;
        current?: string;
        size?: string;
      };
    }>(`${API_PREFIX}/entrance-exams/admissions`, { schema: examAdmissionSchema }, async (req) => {
      const projectId = Number(req.query.projectId);
      if (!Number.isInteger(projectId) || projectId < 1 || projectId > 2147483647)
        throw new AuthError(400, 'VALIDATION_ERROR', '项目ID必须为32位正整数');
      return {
        code: 200,
        message: '操作成功',
        data: await queries.admissions(
          {
            keyword: req.query.keyword,
            admissionStatus: req.query.admissionStatus,
            projectId,
            ...(req.query.current !== undefined ? { current: Number(req.query.current) } : {}),
            ...(req.query.size !== undefined ? { size: Number(req.query.size) } : {}),
          },
          identities.get(req)!,
        ),
      };
    });
    app.post<{ Body: AutoRetryInput }>(
      `${API_PREFIX}/entrance-exams/grading/retry`,
      { schema: autoRetrySchema },
      async (req) => ({
        code: 200,
        message: '操作成功',
        data: await auto.retry(req.body, identities.get(req)!),
      }),
    );
    app.post<{ Body: AutoCompensateInput }>(
      `${API_PREFIX}/entrance-exams/grading/auto/compensate`,
      { schema: autoCompensateSchema, bodyLimit: 4 * 1024 * 1024 },
      async (req) => ({
        code: 200,
        message: '操作成功',
        data: await gradings.compensate(req.body, identities.get(req)!),
      }),
    );
    app.post<{ Body: ManualGradingInput }>(
      `${API_PREFIX}/entrance-exams/grading/manual`,
      { schema: manualGradingSchema },
      async (req) => ({
        code: 200,
        message: '操作成功',
        data: await gradings.manual(req.body, identities.get(req)!),
      }),
    );
    app.post<{ Body: ExamGradingDetailInput }>(
      `${API_PREFIX}/entrance-exams/grading/detail`,
      { schema: examGradingDetailSchema },
      async (req) => ({
        code: 200,
        message: '操作成功',
        data: await queries.gradingDetail(req.body, identities.get(req)!),
      }),
    );
    app.post<{ Body: ExamLocator }>(
      `${API_PREFIX}/entrance-exams/detail`,
      { schema: examQuerySchema('detail') },
      async (req) => ({
        code: 200,
        message: '操作成功',
        data: await queries.detail(req.body, identities.get(req)!),
      }),
    );
    app.get<{ Querystring: { projectId: string } }>(
      `${API_PREFIX}/entrance-exams/management`,
      { schema: examQuerySchema('management') },
      async (req) => {
        const id = Number(req.query.projectId);
        if (!Number.isInteger(id) || id < 1 || id > 2147483647)
          throw new AuthError(400, 'VALIDATION_ERROR', '项目ID必须为32位正整数');
        return {
          code: 200,
          message: '操作成功',
          data: await queries.management(id, identities.get(req)!),
        };
      },
    );
    app.post<{ Body: ExamLocator & { closeReason?: string | null } }>(
      `${API_PREFIX}/entrance-exams/close`,
      { schema: examQuerySchema('close') },
      async (req) => ({
        code: 200,
        message: '操作成功',
        data: await commands.close(req.body, identities.get(req)!),
      }),
    );
    app.post<{ Body: ExamRosterInput }>(
      `${API_PREFIX}/entrance-exams/roster`,
      { schema: examQuerySchema('roster') },
      async (req) => ({
        code: 200,
        message: '操作成功',
        data: await queries.roster(req.body, identities.get(req)!),
      }),
    );
    await examImportRoutes(app, imports, (req) => identities.get(req)!);
    app.post<{ Body: ExamConfigInput }>(
      `${API_PREFIX}/entrance-exams/publish`,
      { schema: examConfigRouteSchema(false), bodyLimit: 2 * 1024 * 1024 },
      async (req) => ({
        code: 200,
        message: '操作成功',
        data: await commands.save(req.body, identities.get(req)!),
      }),
    );
    app.put<{ Body: ExamEditInput }>(
      `${API_PREFIX}/entrance-exams/edit`,
      { schema: examConfigRouteSchema(true), bodyLimit: 2 * 1024 * 1024 },
      async (req) => ({
        code: 200,
        message: '操作成功',
        data: await commands.save(req.body, identities.get(req)!, true),
      }),
    );
    app.get<{ Querystring: { type: ExamTemplateType } }>(
      `${API_PREFIX}/entrance-exams/import/template`,
      { schema: examSchema(true) },
      async (req, reply) => {
        const file = await service.template(req.query.type, identities.get(req)!);
        return reply
          .header('X-Content-Type-Options', 'nosniff')
          .header('Content-Disposition', `attachment; filename="${file.filename}"`)
          .type(file.contentType)
          .send(file.content);
      },
    );
    app.get<{ Querystring: { projectId: string; keyword?: string } }>(
      `${API_PREFIX}/entrance-exams/reviewers`,
      { schema: examSchema(false) },
      async (req) => {
        const id = Number(req.query.projectId);
        if (!Number.isInteger(id) || id < 1 || id > 2147483647)
          throw new AuthError(400, 'VALIDATION_ERROR', '项目ID必须为32位正整数');
        return {
          code: 200,
          message: '操作成功',
          data: await service.reviewers(id, req.query.keyword, identities.get(req)!),
        };
      },
    );
  });
}
