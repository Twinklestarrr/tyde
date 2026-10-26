import { productionRoutes } from './modules/production/production.routes.js';
import { ProductionService } from './modules/production/production.service.js';
import { PersonnelRecordsService } from './modules/personnel/personnel-records.service.js';
import { personnelRoutes } from './modules/personnel/personnel.routes.js';
import { PersonnelService } from './modules/personnel/personnel.service.js';
import { ExamCandidateCommandService } from './modules/entrance-exams/exam-candidate-command.service.js';
import { ExamCandidateService } from './modules/entrance-exams/exam-candidate.service.js';
import { ProjectRecruitmentService } from './modules/projects/project-recruitment.service.js';
import { ProjectRecruitmentHandlerService } from './modules/projects/project-recruitment-handler.service.js';
import { ProjectMaterialsService } from './modules/projects/project-materials.service.js';
import { examAutoCallbackRoutes } from './modules/entrance-exams/exam-auto.routes.js';
import { ExamAutoService } from './modules/entrance-exams/exam-auto.service.js';
import { ExamQueryService } from './modules/entrance-exams/exam-query.service.js';
import { ExamGradingCommandService } from './modules/entrance-exams/exam-grading-command.service.js';
import { ExamImportService } from './modules/entrance-exams/exam-import.service.js';
import { ExamCommandService } from './modules/entrance-exams/exam-command.service.js';
import { examManagementRoutes } from './modules/entrance-exams/exam-management.routes.js';
import { ExamManagementService } from './modules/entrance-exams/exam-management.service.js';
import { expertAssignmentRoutes } from './modules/expert/expert-assignment.routes.js';
import { ExpertAssignmentService } from './modules/expert/expert-assignment.service.js';
import { attendanceRoutes } from './modules/attendance/attendance.routes.js';
import { AttendanceService } from './modules/attendance/attendance.service.js';
import { personalApplicationRoutes } from './modules/users/personal-application.routes.js';
import { PersonalApplicationService } from './modules/users/personal-application.service.js';
import { ProjectListService } from './modules/projects/project-list.service.js';
import { ProjectQueryService } from './modules/projects/project-query.service.js';
import { ProjectProductionPlanService } from './modules/projects/project-production-plan.service.js';
import { organizationRoutes } from './modules/organizations/organization.routes.js';
import { OrganizationService } from './modules/organizations/organization.service.js';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyError, type FastifyServerOptions } from 'fastify';
import cookie from '@fastify/cookie';
import { Prisma, PrismaClient } from '@prisma/client';
import { API_PREFIX } from '@tyde/shared';
import { readConfig, type Config } from './config/index.js';
import { AuthError } from './modules/auth/auth.error.js';
import { AuthService } from './modules/auth/auth.service.js';
import { authRoutes } from './modules/auth/auth.routes.js';
import { registerDocs } from './docs.js';
import { fileRoutes } from './modules/files/file.routes.js';
import { FileService } from './modules/files/file.service.js';
import { FileRegistryService } from './modules/files/file-registry.service.js';
import { createObjectStorage, type ObjectStorage } from './modules/files/object-storage.js';
import { registerBrowserTransport } from './browser-transport.js';
import { ProjectFoundationService } from './modules/projects/project-foundation.service.js';
import { projectFoundationRoutes } from './modules/projects/project-foundation.routes.js';
import { ProjectCreationService } from './modules/projects/project-creation.service.js';
import { ProjectManagerService } from './modules/projects/project-manager.service.js';

export function fastifyOptions(config: Config): FastifyServerOptions {
  return {
    logger: {
      level: config.logLevel,
      redact: [
        'req.headers.authorization',
        'req.headers["x-agent-signature"]',
        'req.headers.cookie',
        'res.headers["set-cookie"]',
        '*.code',
        '*.registrationToken',
        '*.sessionToken',
        '*.password',
        '*.confirmPassword',
        '*.newPassword',
        '*.confirmNewPassword',
        '*.idCardNo',
        '*.accessToken',
        '*.refreshToken',
        '*.uploadToken',
        '*.avatarUploadToken',
        '*.logoUploadToken',
        '*.claimTokenHash',
      ],
    },
    genReqId: () => randomUUID(),
    trustProxy: config.trustProxy,
    bodyLimit: 16 * 1024,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  };
}

export async function createApp(
  config: Config = readConfig(),
  db = new PrismaClient({ datasources: { db: { url: config.databaseUrl } } }),
  app = Fastify(fastifyOptions(config)),
  storage: ObjectStorage = createObjectStorage(config.files),
) {
  await app.register(cookie);
  registerBrowserTransport(app, config);
  await registerDocs(app, config);
  app.addHook('onClose', async () => {
    await db.$disconnect();
  });
  app.setErrorHandler<FastifyError>((error, req, reply) => {
    const legacy =
      req.url.startsWith(`${API_PREFIX}/auth/`) ||
      req.url.startsWith(`${API_PREFIX}/files`) ||
      req.url.startsWith(`${API_PREFIX}/users/`) ||
      req.url.startsWith(`${API_PREFIX}/organizations`) ||
      req.url.startsWith(`${API_PREFIX}/project-categories`) ||
      req.url.startsWith(`${API_PREFIX}/project-requesters`) ||
      req.url.startsWith(`${API_PREFIX}/projects/`) ||
      req.url.startsWith(`${API_PREFIX}/expert-assignments/`) ||
      req.url.startsWith(`${API_PREFIX}/project-personnel/`) ||
      req.url.startsWith(`${API_PREFIX}/production-tasks/`) ||
      req.url.startsWith(`${API_PREFIX}/entrance-exams/`) ||
      req.url.startsWith(`${API_PREFIX}/integrations/agents/entrance-exam-grading/`);
    const failure = (status: number, code: string, message: string) =>
      legacy
        ? { code: status === 429 ? 4292 : status, message, data: null }
        : { code, message, requestId: req.id };
    if (error instanceof AuthError) {
      if (error.retryAfter) reply.header('Retry-After', error.retryAfter);
      return reply.code(error.status).send(failure(error.status, error.code, error.message));
    }
    if (error.validation || error.statusCode === 400 || error.statusCode === 413)
      return reply
        .code(error.statusCode === 413 ? 413 : 400)
        .send(
          failure(error.statusCode === 413 ? 413 : 400, 'VALIDATION_ERROR', '请求字段或格式不正确'),
        );
    const unavailable =
      error instanceof Prisma.PrismaClientInitializationError ||
      (error instanceof Prisma.PrismaClientKnownRequestError &&
        ['P1001', 'P1002', 'P1008', 'P1017', 'P2024'].includes(error.code));
    // 不记录错误 message / SQL / 请求体，避免其中夹带验证码和数据库连接串。
    req.log.error(
      { errorType: error.name, errorCode: 'code' in error ? error.code : undefined },
      'request failed',
    );
    return reply
      .code(unavailable ? 503 : 500)
      .send(
        failure(
          unavailable ? 503 : 500,
          unavailable ? 'SERVICE_UNAVAILABLE' : 'INTERNAL_ERROR',
          unavailable ? '服务暂不可用，请稍后重试' : '操作失败，请稍后重试',
        ),
      );
  });
  const files = new FileRegistryService(db, storage, config.files);
  const auth = new AuthService(db, config, undefined, files);
  await authRoutes(app, auth, config);
  await personalApplicationRoutes(app, new PersonalApplicationService(db), auth, config);
  await attendanceRoutes(app, new AttendanceService(db), auth, config);
  await personnelRoutes(
    app,
    new PersonnelService(db),
    auth,
    config,
    new PersonnelRecordsService(db, files),
  );
  await productionRoutes(app, new ProductionService(db), auth, config);
  await expertAssignmentRoutes(app, new ExpertAssignmentService(db), auth, config);
  const gradings = new ExamGradingCommandService(db);
  await examAutoCallbackRoutes(app, gradings, config);
  await examManagementRoutes(
    app,
    new ExamManagementService(db),
    auth,
    config,
    new ExamImportService(db, new FileService(files)),
    new ExamCommandService(db, files),
    new ExamQueryService(db),
    gradings,
    new ExamAutoService(db),
    new ExamCandidateService(db),
    new ExamCandidateCommandService(db, files),
  );
  await fileRoutes(app, new FileService(files), auth, config);
  await organizationRoutes(app, new OrganizationService(db, files), auth, config);
  await projectFoundationRoutes(
    app,
    new ProjectFoundationService(db),
    auth,
    config,
    new ProjectCreationService(db, files),
    new ProjectManagerService(db),
    new ProjectProductionPlanService(db),
    new ProjectQueryService(db),
    new ProjectListService(db),
    new ProjectMaterialsService(db, files),
    new ProjectRecruitmentHandlerService(db),
    new ProjectRecruitmentService(db),
  );
  app.get(
    `${API_PREFIX}/health/live`,
    {
      schema: {
        operationId: 'healthLive',
        tags: ['Health'],
        summary: '存活检查',
        response: {
          200: {
            type: 'object',
            required: ['status', 'application'],
            properties: {
              status: {
                type: 'string',
                enum: ['ok'],
                description: '进程存活状态，ok=服务进程正常；不检查数据库。',
                examples: ['ok'],
              },
              application: { type: 'string', description: '服务应用名称。', examples: ['tyde'] },
            },
          },
        },
      },
    },
    async () => ({ status: 'ok', application: 'tyde' }),
  );
  app.get(
    `${API_PREFIX}/health/ready`,
    {
      schema: {
        operationId: 'healthReady',
        tags: ['Health'],
        summary: '数据库就绪检查',
        response: Object.fromEntries(
          [
            [200, 'ready'],
            [503, 'unavailable'],
          ].map(([code, status]) => [
            code,
            {
              type: 'object',
              required: ['status'],
              properties: {
                status: {
                  type: 'string',
                  enum: [status],
                  description:
                    '数据库就绪状态：ready=数据库可连接，unavailable=数据库不可用；不可用时 HTTP 503。',
                  examples: [status],
                },
              },
            },
          ]),
        ),
      },
    },
    async (_req, reply) => {
      try {
        await db.$queryRaw`SELECT 1`;
        return { status: 'ready' };
      } catch {
        return reply.code(503).send({ status: 'unavailable' });
      }
    },
  );
  return app;
}
