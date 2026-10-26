import { memberImportRoutes } from './member-import.routes.js';
import {
  OrganizationApprovalService,
  type ExitInput,
  type ApprovalQuery,
  type ProcessInput,
} from './organization-approval.service.js';
import {
  exitHeaders,
  exitBody,
  pendingBody,
  recordsBody,
  processBody,
  exitResponse,
  pendingResponse,
  recordsResponse,
  processResponse,
} from './approval.schema.js';
import {
  MemberService,
  type MemberQuery,
  type MemberUpdateInput,
  type MemberPositionInput,
} from './member.service.js';
import {
  memberQueryBody,
  memberUpdateBody,
  memberPositionBody,
  memberListResponse,
  memberUpdateResponse,
  memberPositionResponse,
} from './member.schema.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { API_PREFIX } from '@tyde/shared';
import type { Config } from '../../config/index.js';
import { AuthError } from '../auth/auth.error.js';
import type { AuthPrincipal, AuthService } from '../auth/auth.service.js';
import { validateTransport } from '../auth/security.js';
import { OrganizationService, type OrganizationUpdateInput } from './organization.service.js';
import {
  organizationSchema,
  organizationQuery,
  organizationUpdateBody,
  organizationDetailResponse,
  organizationUpdateResponse,
} from './organization.schema.js';

export async function organizationRoutes(
  parent: FastifyInstance,
  service: OrganizationService,
  auth: AuthService,
  config: Config,
) {
  await parent.register(async (app) => {
    const identities = new WeakMap<FastifyRequest, AuthPrincipal>();
    const members = new MemberService(service.db);
    const approvals = new OrganizationApprovalService(service.db);
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
    app.get<{ Querystring: { orgId: string } }>(
      `${API_PREFIX}/organizations`,
      {
        schema: {
          ...organizationSchema(
            'getOrganization',
            '获取组织信息',
            '主管和管理员可查；ACTIVE=在组、EXIT_APPROVING=退出审批中、PENDING_LEAVE=待离职仍可读取，其余状态禁止。',
            organizationDetailResponse,
          ),
          querystring: organizationQuery,
        },
      },
      async (req) => ({
        code: 200,
        message: '操作成功',
        data: await service.detail(req.query.orgId, identities.get(req)!),
      }),
    );
    app.post<{ Body: OrganizationUpdateInput }>(
      `${API_PREFIX}/organizations/update`,
      {
        schema: {
          ...organizationSchema(
            'updateOrganization',
            '编辑组织基本资料',
            '仅ACTIVE（正常在组）的OWNER（主管）可编辑。仅description、logoUrl部分更新；不传/null保持原值，空串清空。新上传Logo通过logoUrl=objectKey及logoUploadToken认领本人ORG_LOGO图片；已属于该组织的图片可重复保存，替换/清空释放旧图。写入、文件认领/释放、权限检查与审计在同一组织行锁事务中完成。',
            organizationUpdateResponse,
          ),
          body: organizationUpdateBody,
        },
      },
      async (req) => ({
        code: 200,
        message: '操作成功',
        data: await service.update(req.body, identities.get(req)!),
      }),
    );
    app.post<{ Body: MemberQuery }>(
      `${API_PREFIX}/organizations/members`,
      {
        schema: {
          ...organizationSchema(
            'getOrganizationMembers',
            '获取组织人员列表',
            '主管/管理员在ACTIVE、EXIT_APPROVING、PENDING_LEAVE状态可查询。分页、日期和属性筛选遵循旧SQL。旧Controller称排除已离组，但实际SQL没有排除，当前按SQL保留。项目筛选按本组织每条userOrgRelId关联的ACTIVE项目成员记录生效；projectId为新库32位JSON整数，省略/null不筛选。activeProjectCount返回该组织关系全部ACTIVE记录数，无记录0；不去重项目、不过滤角色/项目状态/删除、不受projectId筛选影响。不额外检查项目存在性，0/负数沿旧SQL返回无匹配。',
            memberListResponse,
          ),
          body: memberQueryBody,
        },
      },
      async (req) => ({
        code: 200,
        message: '操作成功',
        data: await members.list(req.body, identities.get(req)!),
      }),
    );
    app.post<{ Body: MemberUpdateInput }>(
      `${API_PREFIX}/organizations/members/update`,
      {
        schema: {
          ...organizationSchema(
            'updateOrganizationMember',
            '编辑组织成员',
            '主管可编辑所有目标；管理员仅普通成员或自己。操作人退出审批中/待离职仍保留权限；目标状态不额外限制，遵循旧Service。versionNo条件写入与递增，冲突409；joinedAt按上海旧日期格式输入，不得为未来。',
            memberUpdateResponse,
          ),
          body: memberUpdateBody,
        },
      },
      async (req) => ({
        code: 200,
        message: '操作成功',
        data: await members.update(req.body, identities.get(req)!),
      }),
    );
    app.post<{ Body: MemberPositionInput }>(
      `${API_PREFIX}/organizations/members/position`,
      {
        schema: {
          ...organizationSchema(
            'updateOrganizationMemberPosition',
            '变更成员组织角色',
            '目标须ACTIVE。主管可转让OWNER或调整ADMIN/MEMBER；管理员仅可调整普通成员或自己的ADMIN/MEMBER。主管不能直接降级自己，转让后变ADMIN。组织最多5名有效管理员（含待审核/待激活/退出中/待离职），转给现有ADMIN不新增名额。同角色不递增版本。所有写入在组织行锁下事务完成。',
            memberPositionResponse,
          ),
          body: memberPositionBody,
        },
      },
      async (req) => ({
        code: 200,
        message: '操作成功',
        data: await members.position(req.body, identities.get(req)!),
      }),
    );
    app.post<{ Body: ExitInput; Headers: { 'idempotency-key': string } }>(
      `${API_PREFIX}/organizations/members/exit-requests`,
      {
        schema: {
          ...organizationSchema(
            'createMemberExitRequest',
            '发起成员退出或移除组织',
            '本人退出创建单主管待办；主管不能退出，须先转让。主管可代操作非主管，管理员仅代普通成员。代操作当天LEFT、未来PENDING_LEAVE。幂等按组织+申请人+key返回已有流程，不校验新payload；日期仍须合法。项目清退未接入，LEFT同事务持久化PENDING补偿记录，不代表项目/排班已清退。',
            exitResponse,
          ),
          headers: exitHeaders,
          body: exitBody,
        },
      },
      async (req) => ({
        code: 200,
        message: '操作成功',
        data: await approvals.exit(req.headers['idempotency-key'], req.body, identities.get(req)!),
      }),
    );
    app.post<{ Body: ApprovalQuery }>(
      `${API_PREFIX}/organizations/approvals/pending`,
      {
        schema: {
          ...organizationSchema(
            'getPendingApprovals',
            '获取组织待审批列表',
            '参与状态的组织主管/管理员可查；结果同时限定组织、本人审批人、节点PENDING、流程PENDING，无其他审批人查询参数。',
            pendingResponse,
          ),
          body: pendingBody,
        },
      },
      async (req) => ({
        code: 200,
        message: '操作成功',
        data: await approvals.pending(req.body, identities.get(req)!),
      }),
    );
    app.post<{ Body: ApprovalQuery }>(
      `${API_PREFIX}/organizations/approvals/records`,
      {
        schema: {
          ...organizationSchema(
            'getApprovalRecords',
            '获取组织审批记录',
            '参与状态主管/管理员查询组织内全部已处理节点；不是按工单或当前操作人分页。最新动作按内部递增序号取值，人员显示优先当前资料，缺失回退快照。',
            recordsResponse,
          ),
          body: recordsBody,
        },
      },
      async (req) => ({
        code: 200,
        message: '操作成功',
        data: await approvals.records(req.body, identities.get(req)!),
      }),
    );
    app.post<{ Body: ProcessInput }>(
      `${API_PREFIX}/organizations/approvals/process`,
      {
        schema: {
          ...organizationSchema(
            'processApproval',
            '处理组织审批',
            '仅当前组织主管且为该节点实际审批人可处理ORG_MEMBER_EXIT、ATTENDANCE_LEAVE或ATTENDANCE_CORRECTION，考勤申请禁止自审；通过时复查申请人有效关系及排班/日考勤版本，批准后变更日考勤并追加修正审计，驳回不写考勤。组织→流程→节点加锁，流程和节点双版本检查，节点/流程/成员状态/动作日志同事务。驳回意见必填。主管转让不会自动转派已有待办（沿旧Service）；项目清退/负责人/实时事件待04/07/12回补，到期组织离职须运行维护命令。',
            processResponse,
          ),
          body: processBody,
        },
      },
      async (req) => ({
        code: 200,
        message: '操作成功',
        data: await approvals.process(req.body, identities.get(req)!),
      }),
    );
    await memberImportRoutes(app, service.db, config, (req) => identities.get(req)!);
  });
}
