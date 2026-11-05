import { expect, test, type Page } from '@playwright/test';
import { expertTaskExample } from '../../apps/server/src/modules/expert/expert-task.schema';
import {
  assignmentDetailExample,
  projectOwnerCandidatesExample,
} from '../../apps/server/src/modules/expert/expert-assignment.schema';
import { recruitmentDetailExample } from '../../apps/server/src/modules/projects/project-recruitment.schema';
import { rosterExample } from '../../apps/server/src/modules/personnel/personnel.schema';
import {
  attendanceExample,
  performanceExample,
} from '../../apps/server/src/modules/personnel/personnel-records.schema';
import { movementItemExample } from '../../apps/server/src/modules/personnel/personnel-movement-query.schema';
import { strategistProjectCard } from '../helpers/strategist-project-card';
import type {
  AuthUser,
  ExpertTask,
  ExpertProjectOwnerCandidate,
  ProjectPersonnelMember,
  ProjectPersonnelAttendanceMember,
  ProjectMemberPerformanceRecord,
  PersonnelMovement,
  WorkbenchProjectDetail,
} from '../../packages/shared/src/index';

const origin = 'http://127.0.0.1:5176';
const projectId = 3001;
const uuid = (id: number) => `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`;
const organizationId = uuid(50),
  otherOrganizationId = uuid(51);
const today = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
const user: AuthUser = {
  id: uuid(1),
  uid: 'EXPERTPERSONNEL10001',
  accountType: 'INDIVIDUAL',
  phone: '138****0001',
  nickname: '专家人员联调员',
  realName: '测试专家',
  idCardNo: null,
  idVerified: 0,
  avatarUrl: null,
  bio: null,
  role: 'EXPERT',
  roles: ['NAVIGATOR', 'PM', 'EXPERT'],
  selectedRole: 'EXPERT',
  hasExpertManagementRole: true,
  status: 'ACTIVE',
  creditScore: 100,
  lastLoginAt: null,
  lastLoginIp: null,
  organization: null,
  organizations: [],
  createdAt: '2026-11-03T02:00:00.000Z',
  updatedAt: '2026-11-03T02:00:00.000Z',
};
const uploaded = {
  fileId: uuid(99),
  objectKey: `member-performance/2026/11/03/${'a'.repeat(32)}.txt`,
  uploadToken: 'u'.repeat(43),
  url: null,
  sensitive: true,
  fileName: '专家表现.txt',
  extension: 'txt',
  size: 18,
  contentType: 'text/plain',
  fileHash: 'a'.repeat(64),
};
interface RequestLog {
  path: string;
  method: string;
  body: Record<string, unknown> | null;
  query: Record<string, string>;
  headers: Record<string, string>;
  raw: string | null;
  status?: number;
}
type Identity = 'OWNER' | 'SUPERVISOR' | 'ORDINARY';

/** 隔离HTTP只改本地内存；组织/角色/来源及写锁均由真实schema字段构造。 */
async function backend(page: Page, desktop = false) {
  if (desktop)
    await page.addInitScript((apiBaseUrl) => {
      window.tydeDesktop = { getRuntimeConfig: async () => ({ ok: true, data: { apiBaseUrl } }) };
    }, origin);
  await page.context().addCookies([
    {
      name: 'expert_personnel_session',
      value: 'active',
      url: origin,
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);
  const task = {
    ...structuredClone(expertTaskExample),
    acceptanceStatus: 'ACCEPTED',
    currentNodeCode: 'PRODUCTION_TASK',
    branchNodeCode: 'MEMBER_ENTRY_CONFIRM',
    basicInfo: {
      ...structuredClone(expertTaskExample.basicInfo),
      projectName: '执行专家人员项目',
      subjectType: 'ORGANIZATION',
      organizationId,
      organizationName: '海潮组织',
      projectOwners: [{ userId: user.id, name: user.nickname, avatarUrl: null }],
    },
    accessContext: {
      projectOwner: true,
      acceptedOrganizationOwner: false,
      canViewOrganizationData: true,
    },
    operations: { canAccept: false, canReject: false, canReportOutput: false },
  } as ExpertTask;
  const rows: ProjectPersonnelMember[] = Array.from({ length: 27 }, (_, index) => ({
    ...(structuredClone(rosterExample.records[0]) as ProjectPersonnelMember),
    memberId: index + 1,
    userId: uuid(100 + index),
    uid: `MEMBER${index + 1}`,
    displayName:
      index === 0 ? '待入项成员甲' : index === 1 ? '待入项成员乙' : `项目成员${index + 1}`,
    accountType: 'ORGANIZATION',
    organizationId: index < 24 ? organizationId : otherOrganizationId,
    organizationName: index < 24 ? '海潮组织' : '远洋组织',
    orgPosition: 'MEMBER',
    employmentType: 'FULL_TIME',
    status: 'PENDING_CONFIRM',
    statusName: '待确认',
    allowedActions: ['SET_ENTRY'],
    projectOwners: [{ userId: user.id, name: user.nickname, avatarUrl: null }],
  }));
  Object.assign(rows[2], {
    displayName: '在项成员甲',
    status: 'ACTIVE',
    statusName: '在项',
    entryDecision: 'YES',
    plannedEntryDate: '2026-10-23',
    joinedAt: '2026-10-23 09:00:00',
    allowedActions: [],
  });
  Object.assign(rows[3], {
    displayName: '历史离项成员',
    status: 'LEFT',
    statusName: '已离开',
    entryDecision: 'YES',
    joinedAt: '2026-10-23 09:00:00',
    leftAt: '2026-10-30 18:00:00',
    allowedActions: [],
  });
  Object.assign(rows[26], {
    accountType: 'INDIVIDUAL',
    organizationId: null,
    organizationName: null,
  });
  const attendance: ProjectPersonnelAttendanceMember[] = [rows[2], rows[24]].map((member) => ({
    ...structuredClone(attendanceExample.records[0]),
    memberId: member.memberId,
    userId: member.userId,
    uid: member.uid,
    displayName: member.displayName,
    organizationId: member.organizationId,
    organizationName: member.organizationName,
    days: [
      {
        ...structuredClone(attendanceExample.records[0].days[0]),
        firstClockInAt: '2026-10-22 09:10:00.123',
        lastClockOutAt: '2026-10-22 17:50:00.456',
      },
    ],
  }));
  const candidates: ExpertProjectOwnerCandidate[] = Array.from({ length: 22 }, (_, index) => ({
    ...structuredClone(projectOwnerCandidatesExample[0]),
    userId: uuid(90 + index),
    uid: `OWNER${index}`,
    name: index === 0 ? '负责人甲' : index === 1 ? '负责人乙' : `负责人${index + 1}`,
    position: 'MEMBER',
    projectOwner: index === 0,
  }));
  const performance = structuredClone(
    performanceExample.records,
  ) as ProjectMemberPerformanceRecord[];
  const movement = {
    ...structuredClone(movementItemExample),
    movementId: 501,
    memberId: 3,
    userId: rows[2].userId,
    displayName: rows[2].displayName,
    accountType: 'ORGANIZATION',
    organizationId,
    organizationName: '海潮组织',
    sourceProjectId: projectId,
    sourceProjectName: '执行专家人员项目',
    initiatedBy: user.id,
    initiatorName: user.nickname,
    plannedEffectiveDate: '2099-11-03',
  } as PersonnelMovement;
  const state = {
    user: structuredClone(user),
    task,
    rows,
    attendance,
    candidates,
    ownerIds: [user.id],
    performance,
    movements: [movement],
    identity: 'OWNER' as Identity,
    readStatuses: {} as Record<string, number>,
    writeStatuses: {} as Record<string, number>,
    unknown: '',
    applyUnknown: false,
    failAfterWrite: '',
    written: false,
    remains: true,
    otherSource: false,
    detailMovement: null as PersonnelMovement | null,
    uploaded: false,
    downloadStatus: 200,
    replaceSource: '' as '' | 'type' | 'organization',
    taskReads: 0,
  };
  state.user.organizations = [organizationId, otherOrganizationId].map((id) => ({
    id,
    name: id === organizationId ? '海潮组织' : '远洋组织',
    position: 'MEMBER',
    joinStatus: 'ACTIVE',
    status: 'ACTIVE',
    verifyStatus: 'VERIFIED',
  }));
  const requests: RequestLog[] = [];
  let sequence = 800;
  const manager = {
    ...structuredClone(assignmentDetailExample.projectDetail),
    id: projectId,
    currentNodeCode: 'PRODUCTION_TASK',
  } as WorkbenchProjectDetail;
  const managed = () => state.user.selectedRole === 'PM' || state.identity !== 'ORDINARY';
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      headers = await request.allHeaders();
    const log: RequestLog = {
      path: url.pathname,
      method: request.method(),
      body: headers['content-type']?.includes('application/json')
        ? (request.postDataJSON() as Record<string, unknown>)
        : null,
      query: Object.fromEntries(url.searchParams),
      headers,
      raw: request.postData(),
    };
    requests.push(log);
    const reply = (data: unknown, status = 200, message = '操作成功') => {
      log.status = status;
      return route.fulfill({ status, json: { code: status, message, data } });
    };
    const read = (kind: string, data: unknown) =>
      reply(
        (state.readStatuses[kind] ?? 200) === 200 ? data : null,
        state.readStatuses[kind] ?? 200,
        `${kind}读取结果`,
      );
    const pageOf = <T>(records: T[]) => {
      const current = Number(log.body?.current ?? 1),
        size = Number(log.body?.size ?? 20);
      return {
        current,
        size,
        total: records.length,
        pages: Math.ceil(records.length / size),
        records: records.slice((current - 1) * size, current * size),
      };
    };
    const write = async (kind: string, apply: () => void) => {
      if (state.writeStatuses[kind])
        return reply(null, state.writeStatuses[kind], `${kind}状态或权限已变化`);
      const mutate = () => {
        apply();
        state.written = true;
        if (state.failAfterWrite) state.readStatuses[state.failAfterWrite] = 503;
      };
      if (state.unknown === kind) {
        if (state.applyUnknown) mutate();
        return route.abort('failed');
      }
      mutate();
      return reply(null);
    };
    if (!headers.cookie?.includes('expert_personnel_session=active'))
      return reply(null, 401, '请先登录');
    if (log.path === '/api/v1/projects/workbench/statistics')
      return reply({
        mode: 'TASK',
        pendingTaskCount: 1,
        completedTaskCount: 0,
        involvedProjectCount: 1,
      });
    if (log.path === '/api/v1/users/me') return reply(state.user);
    if (log.path === '/api/v1/auth/switch-role') {
      const role = log.body?.role as AuthUser['role'];
      state.user.role = role;
      state.user.selectedRole = role;
      return reply({ selectedRole: role, roles: state.user.roles });
    }
    if (log.path === '/api/v1/projects/list') return reply([]);
    if (log.path === `/api/v1/projects/${projectId}`) return reply(manager);
    if (log.path === '/api/v1/projects/manager/list')
      return reply([{ ...strategistProjectCard(manager), branchNodeCode: 'MEMBER_ENTRY_CONFIRM' }]);
    if (log.path === '/api/v1/projects/expert-recruitments/detail')
      return reply({
        ...recruitmentDetailExample,
        projectId,
        currentNodeCode: 'PRODUCTION_TASK',
        canChangeHandler: true,
        currentOperatorRole: 'PRIMARY_MANAGER',
      });
    if (log.path === '/api/v1/expert-assignments/detail')
      return reply({
        ...assignmentDetailExample,
        assignmentId: state.task.assignmentId,
        movementId: state.task.movementId,
        projectDetail: {
          ...manager,
          id: state.task.basicInfo.projectId,
          projectName: state.task.basicInfo.projectName,
        },
        currentNodeCode: state.task.currentNodeCode,
      });
    if (log.path === '/api/v1/expert-assignments/my-tasks') {
      state.taskReads++;
      const other: ExpertTask = {
        ...state.task,
        sourceBizType: 'PROJECT_MEMBER_TRANSFER',
        movementId: state.task.sourceBizId,
        assignmentId: null,
        basicInfo: { ...state.task.basicInfo, projectName: '同项目另一来源' },
      };
      const cards =
        state.replaceSource && state.taskReads > 1
          ? [
              state.replaceSource === 'type'
                ? other
                : {
                    ...state.task,
                    basicInfo: {
                      ...state.task.basicInfo,
                      organizationId: otherOrganizationId,
                      organizationName: '远洋组织',
                    },
                  },
            ]
          : state.written
            ? [...(state.otherSource ? [other] : []), ...(state.remains ? [state.task] : [])]
            : [state.task];
      return read(
        'tasks',
        cards.filter(
          (item) =>
            !log.body?.keyword || item.basicInfo.projectName?.includes(String(log.body.keyword)),
        ),
      );
    }
    if (log.path === '/api/v1/project-personnel/roster/list') {
      if (!managed()) return reply(null, 403, '无当前组织人员管理权限');
      let rows = state.rows.filter(
        (member) =>
          state.user.selectedRole === 'PM' ||
          [organizationId, otherOrganizationId].includes(member.organizationId ?? ''),
      );
      for (const [field, key] of [
        ['organizationIds', 'organizationId'],
        ['statuses', 'status'],
        ['accountTypes', 'accountType'],
        ['orgPositions', 'orgPosition'],
        ['employmentTypes', 'employmentType'],
      ] as const) {
        const values = log.body?.[field] as string[] | undefined;
        if (values?.length) rows = rows.filter((member) => values.includes(String(member[key])));
      }
      if (log.body?.keyword)
        rows = rows.filter((member) =>
          `${member.displayName}${member.uid}`.includes(String(log.body!.keyword)),
        );
      return read('roster', pageOf(rows));
    }
    if (log.path === '/api/v1/project-personnel/roster/entry/save') {
      if (!managed()) return reply(null, 403, '无当前组织人员管理权限');
      const ids = log.body?.memberIds as number[];
      if (
        ids.some(
          (id) =>
            state.rows.find((row) => row.memberId === id)?.organizationId !==
            state.task.basicInfo.organizationId,
        ) &&
        state.user.selectedRole !== 'PM'
      )
        return reply(null, 403, '成员不在当前来源组织');
      return write('entry', () => {
        for (const row of state.rows.filter((row) => ids.includes(row.memberId))) {
          const yes = log.body!.entryDecision === 'YES',
            date = String(log.body!.plannedEntryDate ?? '');
          Object.assign(row, {
            entryDecision: log.body!.entryDecision,
            plannedEntryDate: yes ? date : null,
            status: !yes ? 'ENTRY_DECLINED' : date === today() ? 'ACTIVE' : 'PENDING_ENTRY',
            statusName: !yes ? '已放弃入项' : date === today() ? '在项' : '待入项',
            joinedAt: yes && date === today() ? `${today()} 10:00:00` : null,
            allowedActions: yes && date > today() ? ['SET_ENTRY'] : [],
          });
        }
      });
    }
    if (log.path === '/api/v1/project-personnel/attendance/list') {
      if (!managed()) return reply(null, 403, '无当前组织考勤权限');
      const orgs = log.body?.organizationIds as string[] | undefined;
      let rows = state.attendance.filter(
        (row) => !orgs?.length || orgs.includes(row.organizationId ?? ''),
      );
      if (log.body?.keyword)
        rows = rows.filter((row) =>
          `${row.displayName}${row.uid}`.includes(String(log.body!.keyword)),
        );
      return read('attendance', pageOf(rows));
    }
    if (log.path === '/api/v1/project-personnel/performance/list')
      return managed()
        ? read('performance', pageOf(state.performance))
        : reply(null, 403, '无当前成员表现权限');
    if (log.path === '/api/v1/files/upload') {
      state.uploaded = true;
      return reply(uploaded);
    }
    if (log.path === '/api/v1/files/view')
      return state.downloadStatus === 200
        ? route.fulfill({
            status: 200,
            contentType: 'application/octet-stream',
            body: 'isolated expert performance',
          })
        : reply(null, state.downloadStatus, '无当前表现附件权限');
    if (log.path === '/api/v1/project-personnel/performance/create')
      return managed()
        ? write('performance', () => {
            state.performance.unshift({
              ...state.performance[0],
              performanceId: ++sequence,
              recordDate: String(log.body!.recordDate),
              content: String(log.body!.content),
              attachmentIds: state.uploaded ? [uploaded.fileId] : [],
              attachments: state.uploaded
                ? [
                    {
                      fileId: uploaded.fileId,
                      objectKey: uploaded.objectKey,
                      fileName: uploaded.fileName,
                    },
                  ]
                : [],
            });
          })
        : reply(null, 403, '无当前成员表现权限');
    if (log.path === '/api/v1/expert-assignments/project-owner-candidates')
      return state.identity === 'SUPERVISOR'
        ? read(
            'owners',
            state.candidates.map((candidate) => ({
              ...candidate,
              projectOwner: state.ownerIds.includes(candidate.userId),
            })),
          )
        : reply(null, 403, '只有组织主管可读取负责人候选');
    if (log.path === '/api/v1/expert-assignments/set-project-owners')
      return state.identity === 'SUPERVISOR'
        ? write('owners', () => {
            state.ownerIds = log.body!.projectOwnerUserIds as string[];
            state.task.basicInfo.projectOwners = state.candidates
              .filter((row) => state.ownerIds.includes(row.userId))
              .map((row) => ({ userId: row.userId, name: row.name, avatarUrl: row.avatarUrl }));
          })
        : reply(null, 403, '只有组织主管可设置负责人');
    if (log.path === '/api/v1/project-personnel/movements/list') {
      let rows = state.movements.filter((item) =>
        [item.sourceProjectId, item.targetProjectId].includes(Number(log.body?.projectId)),
      );
      if (log.body?.movementId)
        rows = rows.filter((item) => item.movementId === log.body!.movementId);
      if (log.body?.memberId)
        rows = rows.filter(
          (item) =>
            item.memberId === log.body!.memberId && item.sourceProjectId === log.body!.projectId,
        );
      if (log.body?.keyword)
        rows = rows.filter((item) =>
          `${item.displayName}${item.uid}`.includes(String(log.body!.keyword)),
        );
      return read('movements', pageOf(rows));
    }
    if (log.path === '/api/v1/project-personnel/movements/detail') {
      const row =
        state.detailMovement ??
        state.movements.find(
          (item) =>
            item.sourceProjectId === log.body?.projectId && item.memberId === log.body?.memberId,
        );
      return row ? read('movementDetail', row) : reply(null, 404, '无当前成员变动详情');
    }
    if (log.path === '/api/v1/project-personnel/movements/create') {
      if (!managed() || log.body?.movementType === 'TRANSFER')
        return reply(null, 403, '执行专家不能发起转项');
      return write('movement', () => {
        for (const id of log.body!.memberIds as number[]) {
          const member = state.rows.find((row) => row.memberId === id)!;
          Object.assign(member, { status: 'PENDING_EXIT', statusName: '待离项' });
          state.movements.unshift({
            ...movement,
            movementId: ++sequence,
            memberId: id,
            userId: member.userId,
            displayName: member.displayName,
            reason: String(log.body!.reason),
            plannedEffectiveDate: String(log.body!.plannedEffectiveDate),
          });
        }
      });
    }
    if (log.path === '/api/v1/project-personnel/movements/withdraw')
      return write('withdraw', () => {
        const row = state.movements.find((item) => item.movementId === log.body!.movementId)!;
        Object.assign(row, { status: 'WITHDRAWN', statusName: '已撤回', allowedActions: [] });
      });
    if (log.path === '/api/v1/project-personnel/movements/process')
      return write('process', () => {
        const row = state.movements.find((item) => item.movementId === log.body!.movementId)!;
        const node = row.approvalSteps.find((item) => item.nodeId === log.body!.nodeId)!;
        Object.assign(node, {
          nodeStatus: log.body!.action === 'REJECT' ? 'REJECTED' : 'APPROVED',
          operatorId: user.id,
          operatorName: user.nickname,
          action: log.body!.action,
          actionComment: log.body!.actionComment ?? null,
          nodeVersionNo: node.nodeVersionNo + 1,
        });
        for (const candidate of row.approvalSteps)
          if (
            candidate.nodeSeq === node.nodeSeq &&
            candidate.nodeId !== node.nodeId &&
            candidate.nodeStatus === 'PENDING'
          )
            candidate.nodeStatus = 'CANCELED';
        row.actionableNodeId = null;
        Object.assign(row, {
          allowedActions: [],
          flowVersionNo: (row.flowVersionNo ?? 0) + 1,
          ...(log.body!.action === 'REJECT'
            ? { status: 'REJECTED', statusName: '已驳回', flowStatus: 'REJECTED' }
            : { currentNode: (row.currentNode ?? 0) + 1 }),
        });
      });
    return reply(null, 404, '隔离测试未提供此接口');
  });
  return { state, requests };
}
const calls = (requests: RequestLog[], path: string) =>
  requests.filter((request) => request.path === `/api/v1/${path}`);
function identity(state: Awaited<ReturnType<typeof backend>>['state'], value: Identity) {
  state.identity = value;
  state.ownerIds = [value === 'OWNER' ? user.id : uuid(90)];
  state.task.basicInfo.projectOwners = state.ownerIds.map((userId) => ({
    userId,
    name: userId === user.id ? user.nickname : '负责人甲',
    avatarUrl: null,
  }));
  state.task.accessContext = {
    projectOwner: value === 'OWNER',
    acceptedOrganizationOwner: value === 'SUPERVISOR',
    canViewOrganizationData: value !== 'ORDINARY',
  };
  state.user.hasExpertManagementRole = value !== 'ORDINARY';
  state.user.organizations = [organizationId, otherOrganizationId].map((id) => ({
    id,
    name: id === organizationId ? '海潮组织' : '远洋组织',
    position: value === 'SUPERVISOR' ? 'OWNER' : 'MEMBER',
    joinStatus: 'ACTIVE',
    status: 'ACTIVE',
    verifyStatus: 'VERIFIED',
  }));
}
function transfer(
  state: Awaited<ReturnType<typeof backend>>['state'],
  code = 'SOURCE_ORG_OWNER',
  parallel = false,
) {
  const row = state.movements[0],
    codes = [
      'SOURCE_ORG_OWNER',
      'MEMBER_CONFIRM',
      'TARGET_ENTRANCE_EXAM',
      'TARGET_MANAGER',
      'TARGET_ORG_OWNER',
    ],
    seq = codes.indexOf(code) + 1;
  Object.assign(row, {
    movementType: 'TRANSFER',
    status: 'PROCESSING',
    statusName: '审批处理中',
    targetProjectId: 4001,
    targetProjectName: '目标人员项目',
    flowNo: 'TF-EXPERT-501',
    flowStatus: 'PENDING',
    flowVersionNo: 7,
    currentNode: seq,
    allowedActions: ['APPROVE', 'REJECT'],
    examStatus: code === 'TARGET_ORG_OWNER' ? 'ADMITTED' : null,
    examSubmittedAt: code === 'TARGET_ORG_OWNER' ? '2026-10-29 11:00:00' : null,
  });
  row.approvalSteps = codes.map((nodeCode, index) => ({
    nodeId: uuid(500 + index),
    nodeSeq: index + 1,
    nodeCode,
    nodeName: nodeCode,
    nodeStatus: index + 1 === seq ? 'PENDING' : index + 1 < seq ? 'APPROVED' : 'WAITING',
    operatorId: null,
    operatorName: null,
    action: null,
    actionComment: null,
    actionAt: null,
    nodeVersionNo: 4,
  }));
  if (parallel) row.approvalSteps.push({ ...row.approvalSteps[seq - 1], nodeId: uuid(599) });
  row.actionableNodeId = ['SOURCE_ORG_OWNER', 'TARGET_ORG_OWNER'].includes(code)
    ? row.approvalSteps[seq - 1].nodeId
    : null;
  return row;
}

async function openProject(page: Page) {
  await page.goto(`${origin}/#/`);
  await page.getByRole('button', { name: '查看项目', exact: true }).click();
  await expect(page.getByRole('heading', { name: '项目待办详情', exact: true })).toBeVisible();
}
async function openPersonnel(page: Page) {
  await openProject(page);
  const panel = page.getByRole('region', { name: '执行专家人员管理', exact: true });
  const tab = page.getByRole('tab', { name: '人员管理', exact: true });
  await expect(panel.or(tab).first()).toBeVisible();
  if (!(await panel.isVisible())) await tab.click();
  await expect(panel).toBeVisible();
  return panel;
}
const memberRow = (page: Page, name: string) =>
  page
    .getByRole('region', { name: '执行专家人员管理', exact: true })
    .getByRole('article', { name, exact: true });
async function entryDialog(page: Page, name = '待入项成员甲') {
  await memberRow(page, name).getByRole('button', { name: '设置入项', exact: true }).click();
  return page.getByRole('dialog', { name: '设置入项', exact: true });
}
async function openOwners(page: Page) {
  await page.getByRole('button', { name: '管理项目负责人', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '管理项目负责人', exact: true });
  await expect(
    dialog.getByRole('checkbox', { name: '选择负责人负责人甲', exact: true }),
  ).toBeVisible();
  return dialog;
}
async function saveOwners(page: Page) {
  await page
    .getByRole('dialog', { name: '管理项目负责人', exact: true })
    .getByRole('button', { name: '保存项目负责人', exact: true })
    .click();
  await page
    .getByRole('dialog', { name: '确认更换项目负责人', exact: true })
    .getByRole('button', { name: '确认更换', exact: true })
    .click();
}
async function openMovement(page: Page, automatic = false) {
  const dialog = page.getByRole('dialog', { name: '人员变动详情', exact: true });
  if (automatic) {
    await expect(dialog).toBeVisible();
    return dialog;
  }
  const panel = page.getByRole('region', { name: '执行专家人员管理', exact: true });
  const tab = panel.getByRole('tab', { name: '变动记录', exact: true });
  if (await tab.count()) await tab.click();
  await page.getByRole('button', { name: '查看变动详情', exact: true }).first().click();
  return dialog;
}
async function settleMotion(page: Page) {
  await page.evaluate(async () => {
    await Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity)
        .map((animation) => animation.finished.catch(() => undefined)),
    );
  });
}

for (const [value, desktop] of [
  ['OWNER', false],
  ['SUPERVISOR', true],
] as const) {
  test(`${desktop ? '桌面配置组织主管' : 'Web项目负责人'}读取花名册固定当前组织，当前会话始终EXPERT`, async ({
    page,
  }) => {
    const { state, requests } = await backend(page, desktop);
    identity(state, value);
    const panel = await openPersonnel(page);
    await expect(memberRow(page, '待入项成员甲')).toBeVisible();
    expect(calls(requests, 'project-personnel/roster/list').at(-1)?.body?.organizationIds).toEqual([
      organizationId,
    ]);
    await expect(panel.getByRole('button', { name: '管理项目负责人', exact: true })).toHaveCount(
      value === 'SUPERVISOR' ? 1 : 0,
    );
    expect(calls(requests, 'auth/switch-role')).toHaveLength(0);
    if (desktop) {
      await settleMotion(page);
      await page.screenshot({
        path: 'artifacts/expert-personnel/personnel-desktop.png',
        fullPage: true,
      });
    }
  });
}

test('普通组织成员和个人来源没有人员管理入口，不以主线节点授予组织权限', async ({ page }) => {
  const { state, requests } = await backend(page);
  identity(state, 'ORDINARY');
  await openProject(page);
  await expect(page.getByRole('region', { name: '执行专家人员管理', exact: true })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: '人员管理', exact: true })).toHaveCount(0);
  state.task.basicInfo.subjectType = 'INDIVIDUAL';
  state.task.basicInfo.organizationId = null;
  state.task.basicInfo.organizationName = null;
  await page.reload();
  await page.getByRole('button', { name: '查看项目', exact: true }).click();
  await expect(page.getByRole('region', { name: '执行专家人员管理', exact: true })).toHaveCount(0);
  expect(calls(requests, 'project-personnel/roster/list')).toHaveLength(0);
});

test('组织花名册真实分页与搜索取交集，不能读取同账号其他职责组织', async ({ page }) => {
  const { requests } = await backend(page);
  const panel = await openPersonnel(page);
  await panel
    .getByRole('navigation', { name: '项目花名册分页', exact: true })
    .getByRole('button', { name: '下一页', exact: true })
    .click();
  await expect(memberRow(page, '项目成员22')).toBeVisible();
  await expect(memberRow(page, '项目成员25')).toHaveCount(0);
  expect(calls(requests, 'project-personnel/roster/list').at(-1)?.body).toMatchObject({
    organizationIds: [organizationId],
    current: 2,
  });
  await panel.getByRole('searchbox', { name: '筛选项目成员', exact: true }).fill('项目成员25');
  await panel.getByRole('button', { name: '查询成员', exact: true }).click();
  await expect(panel.getByText('暂无符合条件的项目成员', { exact: true })).toBeVisible();
  expect(calls(requests, 'project-personnel/roster/list').at(-1)?.body).toMatchObject({
    organizationIds: [organizationId],
    current: 1,
    keyword: '项目成员25',
  });
});

test('跨页批量设置未来入项使用成员整数ID，保存不冒充实际在项', async ({ page }) => {
  const { state, requests } = await backend(page);
  const panel = await openPersonnel(page);
  await panel.getByRole('checkbox', { name: '选择待入项成员甲', exact: true }).check();
  await panel
    .getByRole('navigation', { name: '项目花名册分页', exact: true })
    .getByRole('button', { name: '下一页', exact: true })
    .click();
  await panel.getByRole('checkbox', { name: '选择项目成员22', exact: true }).check();
  await panel.getByRole('button', { name: '批量设置入项', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '设置入项', exact: true });
  await dialog.getByLabel(/^预计入项日期/).fill('2099-11-03');
  await dialog.getByRole('button', { name: '确认保存入项决定', exact: true }).click();
  await expect.poll(() => calls(requests, 'project-personnel/roster/entry/save').length).toBe(1);
  expect(calls(requests, 'project-personnel/roster/entry/save')[0].body).toMatchObject({
    projectId,
    memberIds: [1, 22],
    entryDecision: 'YES',
    plannedEntryDate: '2099-11-03',
  });
  expect(state.rows[0]).toMatchObject({ status: 'PENDING_ENTRY', joinedAt: null });
  expect(state.rows[21].status).toBe('PENDING_ENTRY');
});

test('放弃入项原因必填，校验失败保留表单且只提交当前组织成员', async ({ page }) => {
  const { requests } = await backend(page);
  await openPersonnel(page);
  const dialog = await entryDialog(page);
  await dialog.getByRole('radio', { name: '放弃入项', exact: true }).check();
  await dialog.getByRole('button', { name: '确认保存入项决定', exact: true }).click();
  expect(calls(requests, 'project-personnel/roster/entry/save')).toHaveLength(0);
  await dialog.getByLabel('放弃原因', { exact: true }).fill('本阶段无法参与');
  await dialog.getByRole('button', { name: '确认保存入项决定', exact: true }).click();
  await expect.poll(() => calls(requests, 'project-personnel/roster/entry/save').length).toBe(1);
  expect(calls(requests, 'project-personnel/roster/entry/save')[0].body).toMatchObject({
    projectId,
    memberIds: [1],
    entryDecision: 'NO',
    declineReason: '本阶段无法参与',
  });
});

test('过期日期不提交且服务端403锁定原决定，已生效成员没有旧入项写入口', async ({ page }) => {
  const { state, requests } = await backend(page);
  await openPersonnel(page);
  await expect(
    memberRow(page, '在项成员甲').getByRole('button', { name: '设置入项', exact: true }),
  ).toHaveCount(0);
  const dialog = await entryDialog(page);
  await dialog.getByLabel(/^预计入项日期/).fill('2020-01-01');
  await dialog.getByRole('button', { name: '确认保存入项决定', exact: true }).click();
  await expect(dialog.getByLabel(/^预计入项日期/)).toHaveValue('2020-01-01');
  expect(calls(requests, 'project-personnel/roster/entry/save')).toHaveLength(0);
  state.writeStatuses.entry = 403;
  await dialog.getByLabel(/^预计入项日期/).fill('2099-11-03');
  await dialog.getByRole('button', { name: '确认保存入项决定', exact: true }).click();
  await expect(dialog.getByLabel(/^预计入项日期/)).toBeDisabled();
  expect(calls(requests, 'project-personnel/roster/entry/save')).toHaveLength(1);
});

test('未知入项关闭切模块后恢复原成员决定，读取不清锁或重复保存', async ({ page }) => {
  const { state, requests } = await backend(page);
  state.unknown = 'entry';
  state.task.branchNodeCode = 'PRODUCTION_TASK';
  const panel = await openPersonnel(page);
  let dialog = await entryDialog(page);
  await dialog.getByLabel(/^预计入项日期/).fill('2099-11-03');
  await dialog.getByRole('button', { name: '确认保存入项决定', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '重新读取人员信息', exact: true })).toBeEnabled();
  page.once('dialog', (confirmation) => confirmation.accept());
  await dialog.getByRole('button', { name: '关闭弹窗', exact: true }).click();
  await page
    .getByRole('tablist', { name: '执行专家项目模块', exact: true })
    .getByRole('tab', { name: '生产任务', exact: true })
    .click();
  await page
    .getByRole('tablist', { name: '执行专家项目模块', exact: true })
    .getByRole('tab', { name: '人员管理', exact: true })
    .click();
  dialog = page.getByRole('dialog', { name: '设置入项', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '重新读取人员信息', exact: true }).click();
  await expect(dialog.getByLabel(/^预计入项日期/)).toHaveValue('2099-11-03');
  await expect(
    dialog.getByRole('button', { name: '确认保存入项决定', exact: true }),
  ).toBeDisabled();
  expect(calls(requests, 'project-personnel/roster/entry/save')).toHaveLength(1);
  await expect(panel).toBeVisible();
});

test('入项明确成功但后续待办读取失败，只重读不再次保存', async ({ page }) => {
  const { state, requests } = await backend(page);
  state.failAfterWrite = 'tasks';
  const panel = await openPersonnel(page);
  const dialog = await entryDialog(page);
  await dialog.getByLabel(/^预计入项日期/).fill('2099-11-03');
  await dialog.getByRole('button', { name: '确认保存入项决定', exact: true }).click();
  await expect(
    panel.getByText('入项决定已保存，后续信息读取失败，请重新读取人员信息。', { exact: true }),
  ).toBeVisible();
  state.readStatuses.tasks = 200;
  state.failAfterWrite = '';
  await dialog.getByRole('button', { name: '重新读取人员信息', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(calls(requests, 'project-personnel/roster/entry/save')).toHaveLength(1);
});

test('组织考勤月份和组织UUID由服务端查询，保留毫秒时间且不补造缺日', async ({ page }) => {
  const { requests } = await backend(page);
  const panel = await openPersonnel(page);
  await panel.getByRole('tab', { name: '排班考勤', exact: true }).click();
  await panel.getByLabel('考勤月份', { exact: true }).fill('2026-10');
  await panel.getByRole('button', { name: '查询考勤', exact: true }).click();
  await panel
    .getByRole('article', { name: '在项成员甲考勤', exact: true })
    .getByRole('button', { name: '查看考勤明细', exact: true })
    .click();
  const detail = page.getByRole('dialog', { name: '考勤明细', exact: true });
  await expect(detail.getByText(/09:10:00\.123/)).toBeVisible();
  await expect(detail.getByText('2026-10-21', { exact: true })).toHaveCount(0);
  expect(calls(requests, 'project-personnel/attendance/list').at(-1)?.body).toMatchObject({
    projectId,
    month: '2026-10',
    organizationIds: [organizationId],
  });
  await expect(panel.getByText('项目成员25', { exact: true })).toHaveCount(0);
  expect(calls(requests, 'auth/switch-role')).toHaveLength(0);
});

test('专家花名册不提供跨日期表现录入或附件上传入口', async ({ page }) => {
  const { requests } = await backend(page);
  const panel = await openPersonnel(page);
  await expect(panel.getByRole('button', { name: '成员表现', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('上传表现附件', { exact: true })).toHaveCount(0);
  expect(calls(requests, 'files/upload')).toHaveLength(0);
  expect(calls(requests, 'project-personnel/performance/create')).toHaveLength(0);
});

function approvalSource(
  state: Awaited<ReturnType<typeof backend>>['state'],
  code = 'SOURCE_ORG_OWNER',
  parallel = false,
) {
  const row = transfer(state, code, parallel);
  state.task = {
    ...state.task,
    sourceBizType: 'PROJECT_MEMBER_TRANSFER',
    sourceBizId: row.movementId,
    assignmentId: null,
    movementId: row.movementId,
    branchNodeCode: 'MEMBER_MOVEMENT_APPROVAL',
    basicInfo: {
      ...state.task.basicInfo,
      projectId: code === 'TARGET_ORG_OWNER' ? 4001 : projectId,
    },
    accessContext: {
      projectOwner: false,
      acceptedOrganizationOwner: false,
      canViewOrganizationData: false,
    },
  };
  return row;
}
async function confirmMovement(page: Page, action: '同意转项' | '驳回转项' = '同意转项') {
  await page
    .getByRole('dialog', { name: '人员变动详情', exact: true })
    .getByRole('button', { name: action, exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: action, exact: true });
  if (action === '驳回转项')
    await dialog.getByLabel('审批意见', { exact: true }).fill('本轮安排暂不接收');
  await dialog.getByRole('button', { name: '确认操作', exact: true }).click();
}
test('专家人员管理只保留原版操作，不发起汰换或转项', async ({ page }) => {
  const { requests } = await backend(page);
  const panel = await openPersonnel(page);
  await panel.getByRole('tab', { name: '变动记录', exact: true }).click();
  await expect(panel.getByRole('button', { name: /发起汰换|发起转项/ })).toHaveCount(0);
  expect(calls(requests, 'project-personnel/movements/create')).toHaveLength(0);
  expect(calls(requests, 'project-personnel/transfer-targets')).toHaveLength(0);
});

for (const scope of ['type', 'organization'] as const) {
  test(`原人员来源失去后不借同项目另一${scope === 'type' ? '业务类型' : '组织'}卡开放人员写入`, async ({
    page,
  }) => {
    const { state, requests } = await backend(page);
    state.replaceSource = scope;
    await openProject(page);
    const panel = page.getByRole('region', { name: '执行专家人员管理', exact: true });
    await expect(panel.getByText(/当前原来源已无人员管理或审批资格/)).toBeVisible();
    await expect(panel.getByRole('button', { name: '批量设置入项', exact: true })).toHaveCount(0);
    expect(calls(requests, 'project-personnel/roster/list')).toHaveLength(0);
    expect(calls(requests, 'project-personnel/roster/entry/save')).toHaveLength(0);
  });
}

for (const [code, action] of [
  ['SOURCE_ORG_OWNER', '同意转项'],
  ['TARGET_ORG_OWNER', '驳回转项'],
] as const) {
  test(`EXPERT唯一${code === 'SOURCE_ORG_OWNER' ? '原' : '目标'}负责人节点${action}发送原nodeId与双版本，不读取花名册`, async ({
    page,
  }) => {
    const { state, requests } = await backend(page);
    const row = approvalSource(state, code);
    state.remains = false;
    await openPersonnel(page);
    const dialog = await openMovement(page, true);
    await expect(dialog.getByRole('button', { name: action, exact: true })).toBeEnabled();
    await confirmMovement(page, action);
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => calls(requests, 'project-personnel/movements/process').length).toBe(1);
    expect(calls(requests, 'project-personnel/movements/process')[0].body).toMatchObject({
      projectId: code === 'TARGET_ORG_OWNER' ? 4001 : projectId,
      movementId: 501,
      flowNo: 'TF-EXPERT-501',
      nodeId: uuid(code === 'TARGET_ORG_OWNER' ? 504 : 500),
      nodeVersionNo: 4,
      flowVersionNo: 7,
      action: action === '驳回转项' ? 'REJECT' : 'APPROVE',
    });
    expect(calls(requests, 'project-personnel/roster/list')).toHaveLength(0);
    expect(calls(requests, 'project-personnel/attendance/list')).toHaveLength(0);
    expect(calls(requests, 'project-personnel/movements/list')[0].body).toMatchObject({
      movementId: row.movementId,
      projectId: code === 'TARGET_ORG_OWNER' ? 4001 : projectId,
    });
  });
}

test('旧响应同组多PENDING只读，错误actionableNodeId即使剩单节点也不回退猜测', async ({ page }) => {
  const { state, requests } = await backend(page);
  const row = approvalSource(state, 'SOURCE_ORG_OWNER', true);
  delete row.actionableNodeId;
  await openPersonnel(page);
  const dialog = await openMovement(page, true);
  await expect(dialog.getByText(/当前无法精确定位本人的有效审批节点/)).toBeVisible();
  await expect(dialog.getByRole('button', { name: '同意转项', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: '驳回转项', exact: true })).toBeDisabled();
  row.approvalSteps.pop();
  row.actionableNodeId = uuid(9999);
  await dialog.getByRole('button', { name: '重新读取变动详情', exact: true }).click();
  await expect(
    dialog.getByText('服务响应格式异常，请稍后重试', { exact: true }).first(),
  ).toBeVisible();
  await expect(dialog.getByRole('button', { name: '同意转项', exact: true })).toHaveCount(0);
  expect(calls(requests, 'project-personnel/movements/process')).toHaveLength(0);
});

test('本人接单、目标考试与策略官等待节点不生成EXPERT人工审批写入', async ({ page }) => {
  const { state, requests } = await backend(page);
  for (const code of ['MEMBER_CONFIRM', 'TARGET_ENTRANCE_EXAM', 'TARGET_MANAGER']) {
    approvalSource(state, code);
    state.movements[0].allowedActions =
      code === 'MEMBER_CONFIRM'
        ? ['ACCEPT_TRANSFER', 'REJECT_TRANSFER']
        : code === 'TARGET_ENTRANCE_EXAM'
          ? ['TAKE_TARGET_EXAM']
          : [];
    await openPersonnel(page);
    const dialog = await openMovement(page, true);
    await expect(dialog.getByRole('button', { name: '同意转项', exact: true })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: '驳回转项', exact: true })).toHaveCount(0);
    await dialog.getByRole('button', { name: '关闭详情', exact: true }).click();
    await page.getByRole('button', { name: '返回项目卡片', exact: true }).click();
  }
  expect(calls(requests, 'project-personnel/movements/process')).toHaveLength(0);
});

test('精确审批读取返回另一movementId时拒绝响应，不能沿旧节点审批', async ({ page }) => {
  const { state, requests } = await backend(page);
  const row = approvalSource(state);
  state.detailMovement = { ...row, movementId: 999, movementNo: 'MV-NEW', allowedActions: [] };
  await openPersonnel(page);
  const dialog = await openMovement(page, true);
  await expect(dialog.getByText('服务响应格式异常，请稍后重试', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '同意转项', exact: true })).toHaveCount(0);
  expect(calls(requests, 'project-personnel/movements/process')).toHaveLength(0);
});

test('专家切换人员子页后不恢复汰换发起入口或发送申请', async ({ page }) => {
  const { requests } = await backend(page);
  const panel = await openPersonnel(page);
  await panel.getByRole('tab', { name: '变动记录', exact: true }).click();
  await panel.getByRole('tab', { name: '花名册', exact: true }).click();
  await panel.getByRole('tab', { name: '变动记录', exact: true }).click();
  await expect(page.getByRole('button', { name: /发起汰换|恢复变动申请/ })).toHaveCount(0);
  expect(calls(requests, 'project-personnel/movements/create')).toHaveLength(0);
});

test('审批响应未知关闭重开后仍绑定原节点，GET观察不自动重发或清锁', async ({ page }) => {
  const { state, requests } = await backend(page);
  approvalSource(state);
  state.unknown = 'process';
  await openPersonnel(page);
  let dialog = await openMovement(page, true);
  await confirmMovement(page);
  await expect(dialog.getByRole('button', { name: '核实变动结果', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: '关闭详情', exact: true }).click();
  dialog = await openMovement(page);
  await dialog.getByRole('button', { name: '核实变动结果', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '同意转项', exact: true })).toBeDisabled();
  expect(calls(requests, 'project-personnel/movements/process')).toHaveLength(1);
});

test('审批明确成功但后续待办读取失败，只重读结果而不再次操作节点', async ({ page }) => {
  const { state, requests } = await backend(page);
  approvalSource(state);
  state.failAfterWrite = 'tasks';
  await openPersonnel(page);
  const dialog = await openMovement(page, true);
  await confirmMovement(page);
  await expect(
    dialog.getByText('操作已成功，当前仅重试读取后续信息，不会重复提交。', { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByRole('button', { name: '核实变动结果', exact: true })).toBeEnabled();
  state.readStatuses.tasks = 200;
  state.failAfterWrite = '';
  await dialog.getByRole('button', { name: '核实变动结果', exact: true }).click();
  expect(calls(requests, 'project-personnel/movements/process')).toHaveLength(1);
});

test('组织主管使用真候选完整替换负责人集合，不调用兼容单值接口', async ({ page }) => {
  const { state, requests } = await backend(page);
  identity(state, 'SUPERVISOR');
  await openPersonnel(page);
  const dialog = await openOwners(page);
  await expect(
    dialog.getByRole('checkbox', { name: '选择负责人负责人甲', exact: true }),
  ).toBeChecked();
  await dialog.getByRole('button', { name: '移除负责人负责人甲', exact: true }).click();
  await dialog.getByRole('checkbox', { name: '选择负责人负责人乙', exact: true }).check();
  await dialog.getByRole('checkbox', { name: '选择负责人负责人3', exact: true }).check();
  await saveOwners(page);
  await expect(dialog).toHaveCount(0);
  expect(calls(requests, 'expert-assignments/set-project-owners')[0].body).toEqual({
    assignmentId: 1,
    projectOwnerUserIds: [uuid(91), uuid(92)],
  });
  expect(calls(requests, 'expert-assignments/project-owner-candidates')[0].query).toEqual({
    assignmentId: '1',
  });
  expect(calls(requests, 'expert-assignments/change-project-owner')).toHaveLength(0);
});

test('负责人集合至少一人且最多20人，搜索隐藏项也保留已选完整集合', async ({ page }) => {
  const { state, requests } = await backend(page);
  identity(state, 'SUPERVISOR');
  await openPersonnel(page);
  const dialog = await openOwners(page);
  await dialog.getByRole('button', { name: '移除负责人负责人甲', exact: true }).click();
  await dialog.getByRole('button', { name: '保存项目负责人', exact: true }).click();
  expect(calls(requests, 'expert-assignments/set-project-owners')).toHaveLength(0);
  const options = dialog.getByRole('checkbox');
  for (let index = 0; index < 20; index++) await options.nth(index).check();
  await options.nth(20).check();
  await dialog.getByRole('button', { name: '保存项目负责人', exact: true }).click();
  expect(calls(requests, 'expert-assignments/set-project-owners')).toHaveLength(0);
  await expect(page.getByRole('dialog', { name: '确认更换项目负责人', exact: true })).toHaveCount(
    0,
  );
  await options.nth(20).uncheck();
  await dialog.getByRole('searchbox', { name: '筛选负责人候选', exact: true }).fill('负责人乙');
  await expect(dialog.getByText('已选 20 / 20 名', { exact: true })).toBeVisible();
  expect(calls(requests, 'expert-assignments/set-project-owners')).toHaveLength(0);
});

test('负责人更换未知即使GET集合完全相同，跨角色关闭恢复也不自动判成功或重发', async ({ page }) => {
  const { state, requests } = await backend(page);
  identity(state, 'SUPERVISOR');
  state.unknown = 'owners';
  state.applyUnknown = true;
  await openPersonnel(page);
  let dialog = await openOwners(page);
  await dialog.getByRole('button', { name: '移除负责人负责人甲', exact: true }).click();
  await dialog.getByRole('checkbox', { name: '选择负责人负责人乙', exact: true }).check();
  await saveOwners(page);
  await expect(
    dialog.getByRole('button', { name: '重新读取负责人信息', exact: true }),
  ).toBeEnabled();
  await dialog.getByRole('button', { name: '关闭负责人管理', exact: true }).click();
  await page.getByRole('button', { name: '返回项目卡片', exact: true }).click();
  await page.getByRole('combobox', { name: '当前角色', exact: true }).click();
  await page.getByRole('option', { name: '策略官', exact: true }).click();
  await expect(page.getByRole('combobox', { name: '当前角色', exact: true })).toContainText(
    '策略官',
  );
  await page.getByRole('combobox', { name: '当前角色', exact: true }).click();
  await page.getByRole('option', { name: '执行专家', exact: true }).click();
  await expect(page.getByRole('combobox', { name: '当前角色', exact: true })).toContainText(
    '执行专家',
  );
  await page.getByRole('button', { name: '查看项目', exact: true }).click();
  dialog = await openOwners(page);
  await dialog.getByRole('button', { name: '重新读取负责人信息', exact: true }).click();
  await expect(
    dialog.getByRole('checkbox', { name: '选择负责人负责人乙', exact: true }),
  ).toBeChecked();
  await expect(
    dialog.getByRole('checkbox', { name: '选择负责人负责人乙', exact: true }),
  ).toBeDisabled();
  expect(state.ownerIds).toEqual([uuid(91)]);
  expect(calls(requests, 'expert-assignments/set-project-owners')).toHaveLength(1);
});

test('负责人已保存但后续待办读取失败仅重读，不重复完整替换命令', async ({ page }) => {
  const { state, requests } = await backend(page);
  identity(state, 'SUPERVISOR');
  state.failAfterWrite = 'tasks';
  await openPersonnel(page);
  const dialog = await openOwners(page);
  await dialog.getByRole('button', { name: '移除负责人负责人甲', exact: true }).click();
  await dialog.getByRole('checkbox', { name: '选择负责人负责人乙', exact: true }).check();
  await saveOwners(page);
  await expect(
    dialog.getByText('负责人已保存，后续待办读取失败，请重新读取负责人信息。', { exact: true }),
  ).toBeVisible();
  state.readStatuses.tasks = 200;
  state.failAfterWrite = '';
  await dialog.getByRole('button', { name: '重新读取负责人信息', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(calls(requests, 'expert-assignments/set-project-owners')).toHaveLength(1);
});

test('PM入项未知切EXPERT同项目只能读取，不清除原角色锁或使用原决定重发', async ({ page }) => {
  const { state, requests } = await backend(page);
  state.user.role = 'PM';
  state.user.selectedRole = 'PM';
  state.unknown = 'entry';
  await page.goto(`${origin}/#/strategist/projects/${projectId}?tab=PERSONNEL_MANAGEMENT`);
  await page
    .getByRole('article', { name: '待入项成员甲', exact: true })
    .getByRole('button', { name: '设置入项', exact: true })
    .click();
  let dialog = page.getByRole('dialog', { name: '设置入项', exact: true });
  await dialog.getByLabel(/^预计入项日期/).fill('2099-11-03');
  await dialog.getByRole('button', { name: '确认保存入项决定', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '重新读取人员信息', exact: true })).toBeEnabled();
  page.once('dialog', (confirmation) => confirmation.accept());
  await dialog.getByRole('button', { name: '关闭弹窗', exact: true }).click();
  await page.getByRole('link', { name: '返回我的项目', exact: true }).click();
  await page.getByRole('combobox', { name: '当前角色', exact: true }).click();
  await page.getByRole('option', { name: '执行专家', exact: true }).click();
  await expect(page.getByRole('combobox', { name: '当前角色', exact: true })).toContainText(
    '执行专家',
  );
  await page.getByRole('button', { name: '查看项目', exact: true }).click();
  const panel = page.getByRole('region', { name: '执行专家人员管理', exact: true });
  await expect(panel).toBeVisible();
  await expect(page.getByRole('dialog', { name: '设置入项', exact: true })).toHaveCount(0);
  await panel.getByRole('button', { name: '重新读取人员信息', exact: true }).click();
  await expect(
    memberRow(page, '待入项成员甲').getByRole('button', { name: '设置入项', exact: true }),
  ).toBeDisabled();
  expect(calls(requests, 'project-personnel/roster/entry/save')).toHaveLength(1);
  await page.getByRole('button', { name: '返回项目卡片', exact: true }).click();
  await page.getByRole('combobox', { name: '当前角色', exact: true }).click();
  await page.getByRole('option', { name: '策略官', exact: true }).click();
  await expect(page.getByRole('combobox', { name: '当前角色', exact: true })).toContainText(
    '策略官',
  );
  await page.getByRole('link', { name: '人员管理', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '设置入项', exact: true });
  await expect(dialog.getByLabel(/^预计入项日期/)).toHaveValue('2099-11-03');
  await expect(
    dialog.getByRole('button', { name: '确认保存入项决定', exact: true }),
  ).toBeDisabled();
  expect(calls(requests, 'project-personnel/roster/entry/save')).toHaveLength(1);
});

test('375px人员列表与负责人选择不横向溢出，动效结束后保留可操作快照', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const { state } = await backend(page);
  identity(state, 'SUPERVISOR');
  const longName = '超长负责人姓名'.repeat(8);
  state.candidates[0].name = longName;
  state.task.basicInfo.projectOwners[0].name = longName;
  await openPersonnel(page);
  await expect(memberRow(page, '待入项成员甲')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: '管理项目负责人', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '管理项目负责人', exact: true });
  await expect(
    dialog.getByRole('checkbox', { name: `选择负责人${longName}`, exact: true }),
  ).toBeVisible();
  await settleMotion(page);
  expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  const box = await dialog.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(375);
  const content = dialog.locator('[data-slot="dialog-content"]');
  const layout = await content.evaluate((node) => ({
    client: node.clientWidth,
    scroll: node.scrollWidth,
  }));
  await test
    .info()
    .attach('long-owner-layout', { body: JSON.stringify(layout), contentType: 'application/json' });
  await page.screenshot({ path: 'artifacts/expert-personnel/personnel-375.png' });
  expect(layout.scroll).toBeLessThanOrEqual(layout.client);
});

test('多人ANY当前本人actionableNodeId指第二节点，必须按该节点和双版本审批', async ({ page }) => {
  const { state, requests } = await backend(page);
  const row = approvalSource(state, 'SOURCE_ORG_OWNER', true);
  row.actionableNodeId = uuid(599);
  state.remains = false;
  await openPersonnel(page);
  const dialog = await openMovement(page, true);
  await expect(dialog.getByRole('button', { name: '同意转项', exact: true })).toBeEnabled();
  expect(
    row.approvalSteps
      .filter((step) => step.nodeStatus === 'PENDING')
      .map((step) => step.operatorId),
  ).toEqual([null, null]);
  await confirmMovement(page);
  await expect(dialog).toHaveCount(0);
  expect(calls(requests, 'project-personnel/movements/process')[0].body).toMatchObject({
    projectId,
    movementId: 501,
    nodeId: uuid(599),
    nodeVersionNo: 4,
    flowVersionNo: 7,
    action: 'APPROVE',
  });
  expect(row.approvalSteps.find((step) => step.nodeId === uuid(500))?.nodeStatus).toBe('CANCELED');
});
