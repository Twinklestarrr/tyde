import { API_PREFIX } from '@tyde/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AppError } from '../../common/errors.js';
import type { Config } from '../../config/index.js';
import type { AuthService } from '../auth/auth.service.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { validateTransport } from '../auth/security.js';
import type { MovementDetailQuery, MovementQuery } from './personnel-movement-query.js';
import {
  movementDetailBody,
  movementDetailResponse,
  movementListBody,
  movementListResponse,
} from './personnel-movement-query.schema.js';
import type { MovementInput } from './personnel-movement.domain.js';
import {
  movementCommandResponse,
  movementCreateSchema,
  movementProcessBody,
  movementWithdrawBody,
  transferTargetSchema,
} from './personnel-movement.schema.js';
import {
  PersonnelMovementService,
  type TransferTargetQuery,
} from './personnel-movement.service.js';
import {
  attendanceBody,
  attendanceResponse,
  performanceBody,
  performanceCreateBody,
  performanceResponse,
} from './personnel-records.schema.js';
import {
  PersonnelRecordsService,
  type PerformanceInput,
  type PerformanceQuery,
  type ProjectAttendanceQuery,
} from './personnel-records.service.js';
import type { MovementProcessInput, MovementWithdrawInput } from './personnel-transfer.types.js';
import type { EntryInput, RosterQuery } from './personnel.domain.js';
import {
  entryBody,
  entryResponse,
  personnelSchema,
  rosterBody,
  rosterResponse,
} from './personnel.schema.js';
import { PersonnelService } from './personnel.service.js';
export async function personnelRoutes(
  parent: FastifyInstance,
  service: PersonnelService,
  auth: AuthService,
  config: Config,
  records: PersonnelRecordsService,
  movements = new PersonnelMovementService(service.db),
) {
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
        throw new AppError(403, 'ORIGIN_NOT_ALLOWED', '请求来源或会话凭据组合不可信');
      }
      const token =
        client === 'desktop'
          ? req.headers.authorization?.replace(/^Bearer /, '')
          : req.cookies[config.cookieSecure ? '__Host-tyde_session' : 'tyde_session'];
      identities.set(req, await auth.authenticate(token, client));
    });

    app.post<{ Body: MovementQuery }>(
      `${API_PREFIX}/project-personnel/movements/list`,
      {
        schema: personnelSchema(
          'listPersonnelMovements',
          '查询人员变动记录',
          movementListBody,
          movementListResponse,
        ),
      },
      async (req) => ({
        code: 200,
        message: '操作成功',
        data: await movements.list(req.body, identities.get(req)!),
      }),
    );
    app.post<{ Body: MovementDetailQuery }>(
      `${API_PREFIX}/project-personnel/movements/detail`,
      {
        schema: personnelSchema(
          'detailPersonnelMovements',
          '查询人员变动详情',
          movementDetailBody,
          movementDetailResponse,
        ),
      },
      async (req) => ({
        code: 200,
        message: '操作成功',
        data: await movements.detail(req.body, identities.get(req)!),
      }),
    );
    app.post<{ Body: MovementProcessInput }>(
      `${API_PREFIX}/project-personnel/movements/process`,
      {
        schema: personnelSchema(
          'processPersonnelMovement',
          '处理当前转项人工审批节点',
          movementProcessBody,
          movementCommandResponse,
        ),
      },
      async (req) => ({
        code: 200,
        message: '操作成功',
        data: await movements.process(req.body, identities.get(req)!),
      }),
    );
    app.post<{ Body: MovementWithdrawInput }>(
      `${API_PREFIX}/project-personnel/movements/withdraw`,
      {
        schema: personnelSchema(
          'withdrawPersonnelMovement',
          '撤回人员变动',
          movementWithdrawBody,
          movementCommandResponse,
        ),
      },
      async (req) => ({
        code: 200,
        message: '操作成功',
        data: await movements.withdraw(req.body, identities.get(req)!),
      }),
    );
    app.post<{ Body: MovementInput }>(
      `${API_PREFIX}/project-personnel/movements/create`,
      { schema: movementCreateSchema },
      async (req) => ({
        code: 200,
        message: '操作成功',
        data: await movements.create(req.body, identities.get(req)!),
      }),
    );
    app.post<{ Body: TransferTargetQuery }>(
      `${API_PREFIX}/project-personnel/movements/target-projects`,
      { schema: transferTargetSchema },
      async (req) => ({
        code: 200,
        message: '操作成功',
        data: await movements.targets(req.body, identities.get(req)!),
      }),
    );
    app.post<{ Body: ProjectAttendanceQuery }>(
      `${API_PREFIX}/project-personnel/attendance/list`,
      {
        schema: personnelSchema(
          'listProjectPersonnelAttendance',
          '查询项目人员排班考勤',
          attendanceBody,
          attendanceResponse,
        ),
      },
      async (req) => ({
        code: 200,
        message: '操作成功',
        data: await records.attendance(req.body, identities.get(req)!),
      }),
    );
    app.post<{ Body: PerformanceQuery }>(
      `${API_PREFIX}/project-personnel/performance/list`,
      {
        schema: personnelSchema(
          'listProjectMemberPerformance',
          '查询成员表现记录',
          performanceBody,
          performanceResponse,
        ),
      },
      async (req) => ({
        code: 200,
        message: '操作成功',
        data: await records.performance(req.body, identities.get(req)!),
      }),
    );
    app.post<{ Body: PerformanceInput }>(
      `${API_PREFIX}/project-personnel/performance/create`,
      {
        schema: personnelSchema(
          'createProjectMemberPerformance',
          '新增成员表现记录',
          performanceCreateBody,
          {
            type: 'null',
            description: '成功data为null，记录与附件认领同事务，无额外节点、轮次或通知副作用。',
            examples: [null],
          },
        ),
      },
      async (req) => ({
        code: 200,
        message: '操作成功',
        data: await records.createPerformance(req.body, identities.get(req)!),
      }),
    );
    app.post<{ Body: RosterQuery }>(
      `${API_PREFIX}/project-personnel/roster/list`,
      {
        schema: personnelSchema('listProjectRoster', '查询项目花名册', rosterBody, rosterResponse),
      },
      async (req) => ({
        code: 200,
        message: '操作成功',
        data: await service.roster(req.body, identities.get(req)!),
      }),
    );
    app.post<{ Body: EntryInput }>(
      `${API_PREFIX}/project-personnel/roster/entry/save`,
      {
        schema: personnelSchema(
          'saveProjectMemberEntry',
          '保存单人或批量入项决定',
          entryBody,
          entryResponse,
        ),
      },
      async (req) => ({
        code: 200,
        message: '操作成功',
        data: await service.saveEntry(req.body, identities.get(req)!),
      }),
    );
  });
}
