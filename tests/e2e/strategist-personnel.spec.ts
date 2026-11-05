import { expect, test, type Page } from '@playwright/test';
import { strategistProjectCard } from '../helpers/strategist-project-card';
import { projectPublishedExample } from '../../apps/server/src/modules/projects/project-query.schema';
import { recruitmentDetailExample } from '../../apps/server/src/modules/projects/project-recruitment.schema';
import { productionListResponse } from '../../apps/server/src/modules/production/quality-acceptance.schema';
import { rosterExample } from '../../apps/server/src/modules/personnel/personnel.schema';
import {
  attendanceExample,
  performanceExample,
} from '../../apps/server/src/modules/personnel/personnel-records.schema';
import { movementItemExample } from '../../apps/server/src/modules/personnel/personnel-movement-query.schema';
import { transferTargetExample } from '../../apps/server/src/modules/personnel/personnel-movement.schema';
import type { AuthUser, WorkbenchProjectDetail } from '../../packages/shared/src/index';
import type {
  ProjectPersonnelMember as RosterRow,
  PersonnelMovement as Movement,
  ProjectMemberPerformanceRecord as PerformanceRecord,
} from '../../packages/shared/src/project-personnel';

const origin = 'http://127.0.0.1:5176';
const projectId = 3001;
const uuid = (id: number) => `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`;
const user: AuthUser = {
  id: uuid(1),
  uid: 'PERSONNEL10001',
  accountType: 'INDIVIDUAL',
  phone: '138****0001',
  nickname: '人员管理联调员',
  realName: '测试策略官',
  idCardNo: null,
  idVerified: 0,
  avatarUrl: null,
  bio: null,
  role: 'PM',
  roles: ['NAVIGATOR', 'PM', 'EXPERT'],
  selectedRole: 'PM',
  hasExpertManagementRole: false,
  status: 'ACTIVE',
  creditScore: 100,
  lastLoginAt: null,
  lastLoginIp: null,
  organization: null,
  organizations: [],
  createdAt: '2026-11-03T02:00:00.000Z',
  updatedAt: '2026-11-03T02:00:00.000Z',
};
const project = {
  ...structuredClone(projectPublishedExample),
  id: projectId,
  projectNo: 'PERSONNEL-PROJECT-3001',
  projectName: '策略官人员管理项目',
  currentNodeCode: 'PERSONNEL_MANAGEMENT',
  versionNo: 4,
  attachments: [],
} as WorkbenchProjectDetail;
interface RequestLog {
  path: string;
  method: string;
  body: Record<string, unknown> | null;
  headers: Record<string, string>;
  query: Record<string, string>;
  form: Record<string, string>;
  fileName?: string;
}
const uploaded = {
  fileId: uuid(90),
  objectKey: `member-performance/2026/11/03/${'a'.repeat(32)}.txt`,
  uploadToken: 'u'.repeat(43),
  url: null,
  sensitive: true,
  fileName: '表现说明.txt',
  extension: 'txt',
  size: 0,
  contentType: 'text/plain',
  fileHash: 'a'.repeat(64),
};

/** 全部花名册/考勤/表现/变动写入只修改内存夹具；不连接真实业务库、OSS 或调度。 */
async function backend(page: Page, desktop = false) {
  if (desktop)
    await page.addInitScript((apiBaseUrl) => {
      window.tydeDesktop = { getRuntimeConfig: async () => ({ ok: true, data: { apiBaseUrl } }) };
    }, origin);
  await page
    .context()
    .addCookies([
      { name: 'personnel_session', value: 'active', url: origin, httpOnly: true, sameSite: 'Lax' },
    ]);
  const member = (id: number): RosterRow => ({
    ...structuredClone(rosterExample.records[0]),
    status: 'PENDING_CONFIRM',
    accountType: 'INDIVIDUAL',
    orgPosition: null,
    employmentType: null,
    entryDecision: null,
    allowedActions: ['SET_ENTRY'],
    memberId: id,
    userId: uuid(100 + id),
    uid: `MEMBER${id}`,
    displayName: id === 1 ? '待入项成员甲' : id === 2 ? '待入项成员乙' : `项目成员${id}`,
  });
  const rows = Array.from({ length: 23 }, (_, index) => member(index + 1));
  Object.assign(rows[1], {
    accountType: 'ORGANIZATION',
    organizationId: uuid(80),
    organizationName: '人员协作组',
    orgPosition: 'MEMBER',
    employmentType: 'FULL_TIME',
  });
  Object.assign(rows[2], {
    displayName: '在项成员',
    status: 'ACTIVE',
    statusName: '在项',
    entryDecision: 'YES',
    plannedEntryDate: '2026-10-23',
    joinedAt: '2026-10-23 10:00:00',
    allowedActions: [],
  });
  Object.assign(rows[3], {
    displayName: '历史离项成员',
    status: 'LEFT',
    statusName: '已离开',
    entryDecision: 'YES',
    plannedEntryDate: '2026-10-23',
    joinedAt: '2026-10-23 10:00:00',
    leftAt: '2026-10-30 10:00:00',
    allowedActions: [],
  });
  Object.assign(rows[4], {
    displayName: '组织在项成员',
    accountType: 'ORGANIZATION',
    organizationId: uuid(80),
    organizationName: '人员协作组',
    orgPosition: 'MEMBER',
    employmentType: 'FULL_TIME',
    status: 'ACTIVE',
    statusName: '在项',
    entryDecision: 'YES',
    plannedEntryDate: '2026-10-23',
    joinedAt: '2026-10-23 10:00:00',
    allowedActions: [],
  });
  const state = {
    user: structuredClone(user),
    rows,
    primary: true,
    projectNode: 'PERSONNEL_MANAGEMENT',
    remains: true,
    written: false,
    rosterStatus: 200,
    permissionStatus: 200,
    attendanceStatus: 200,
    performanceStatus: 200,
    listStatus: 200,
    movementStatus: 200,
    targetStatus: 200,
    uploadStatus: 200,
    unknown: '' as string,
    applyUnknown: false,
    hold: '',
    failAfterWrite: '',
    writeStatuses: {} as Record<string, number>,
    performances: new Map<number, PerformanceRecord[]>([
      [1, structuredClone(performanceExample.records)],
    ]),
    movements: [] as Movement[],
  };
  const requests: RequestLog[] = [];
  let release: (() => Promise<void>) | undefined;
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    const headers = await request.allHeaders();
    const log: RequestLog = {
      path: url.pathname,
      method: request.method(),
      query: Object.fromEntries(url.searchParams),
      body: headers['content-type']?.includes('application/json')
        ? (request.postDataJSON() as Record<string, unknown>)
        : null,
      headers,
      form: {},
    };
    if (headers['content-type']?.includes('multipart/form-data')) {
      const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(headers['content-type']);
      for (const part of (request.postDataBuffer()?.toString('utf8') ?? '').split(
        `--${boundary?.[1] ?? boundary?.[2]}`,
      )) {
        const name = /name="([^"]+)"/.exec(part)?.[1],
          start = part.indexOf('\r\n\r\n');
        if (!name || start < 0) continue;
        log.form[name] = part.slice(start + 4).replace(/\r\n$/, '');
        log.fileName = /filename="([^"]+)"/.exec(part)?.[1] ?? log.fileName;
      }
    }
    requests.push(log);
    const reply = (data: unknown, status = 200, message = '操作成功') =>
      route.fulfill({ status, json: { code: status, message, data } });
    const pageOf = <T>(records: T[]) => {
      const current = Number(log.body?.current ?? 1),
        size = Number(log.body?.size ?? 20);
      return {
        records: records.slice((current - 1) * size, current * size),
        total: records.length,
        current,
        size,
        pages: Math.ceil(records.length / size),
      };
    };
    const runWrite = async (kind: string, apply: () => void) => {
      const status = state.writeStatuses[kind] ?? 200;
      if (status !== 200) return reply(null, status, `${kind}操作失败，请重新核实`);
      const complete = async () => {
        apply();
        state.written = true;
        if (state.failAfterWrite === 'roster') state.rosterStatus = 503;
        if (state.failAfterWrite === 'list') state.listStatus = 503;
        if (state.failAfterWrite === 'performance') state.performanceStatus = 503;
        if (state.failAfterWrite === 'movement') state.movementStatus = 503;
        await reply(null);
      };
      if (state.unknown === kind) {
        if (state.applyUnknown) apply();
        return route.abort('failed');
      }
      if (state.hold === kind) {
        release = complete;
        return;
      }
      return complete();
    };
    if (!headers.cookie?.includes('personnel_session=active')) return reply(null, 401, '请先登录');
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
    if (log.path === '/api/v1/expert-assignments/my-tasks' || log.path === '/api/v1/projects/list')
      return reply([]);
    if (log.path === `/api/v1/projects/${projectId}`)
      return reply({ ...project, currentNodeCode: state.projectNode });
    if (log.path === '/api/v1/projects/manager/list')
      return reply(
        state.listStatus === 200
          ? state.written && !state.remains
            ? []
            : [
                {
                  ...strategistProjectCard({ ...project, currentNodeCode: state.projectNode }),
                  primaryProjectManager: state.primary,
                  expertRecruitmentHandler: !state.primary,
                },
              ]
          : null,
        state.listStatus,
        '项目待办暂时无法读取',
      );
    if (log.path === '/api/v1/projects/expert-recruitments/detail')
      return reply(
        state.permissionStatus === 200
          ? {
              ...recruitmentDetailExample,
              projectId,
              currentNodeCode: state.projectNode,
              currentOperatorRole: state.primary ? 'PRIMARY_MANAGER' : 'EXPERT_RECRUITMENT_HANDLER',
              canChangeHandler: state.primary,
              primaryManager: {
                userId: state.primary ? user.id : uuid(9),
                uid: 'MANAGER',
                name: '主策略官',
                avatarUrl: null,
              },
              handler: {
                userId: state.primary ? uuid(9) : user.id,
                uid: 'HANDLER',
                name: '招募协作负责人',
                avatarUrl: null,
              },
            }
          : null,
        state.permissionStatus,
        '人员管理资格读取结果',
      );
    if (log.path === '/api/v1/entrance-exams/reviewers')
      return reply(state.primary ? [] : null, state.primary ? 200 : 403, '仅主策略官可写');
    if (log.path === '/api/v1/project-personnel/roster/list') {
      if (state.rosterStatus !== 200) return reply(null, state.rosterStatus, '花名册暂时无法读取');
      let records = state.rows.filter(
        (row) =>
          !log.body?.keyword ||
          `${row.displayName}${row.uid}`.includes(String(log.body.keyword).trim()),
      );
      const filters = {
        accountTypes: 'accountType',
        orgPositions: 'orgPosition',
        organizationIds: 'organizationId',
        employmentTypes: 'employmentType',
        responsibleUserIds: 'responsibleUserId',
        statuses: 'status',
      } as const;
      for (const [key, field] of Object.entries(filters)) {
        const values = log.body?.[key] as unknown[] | undefined;
        if (values?.length)
          records = records.filter((row) => values.includes(row[field as keyof RosterRow]));
      }
      return reply(
        pageOf(
          records.map((row) => ({
            ...row,
            allowedActions: state.primary ? row.allowedActions : [],
          })),
        ),
      );
    }
    if (log.path === '/api/v1/project-personnel/roster/entry/save')
      return runWrite('entry', () => {
        const ids = log.body!.memberIds as number[];
        for (const row of state.rows.filter((item) => ids.includes(item.memberId))) {
          if (log.body!.entryDecision === 'YES')
            Object.assign(row, {
              entryDecision: 'YES',
              plannedEntryDate: log.body!.plannedEntryDate,
              status: 'PENDING_ENTRY',
              statusName: '待入项',
              joinedAt: null,
            });
          else
            Object.assign(row, {
              entryDecision: 'NO',
              plannedEntryDate: null,
              status: 'ENTRY_DECLINED',
              statusName: '已放弃入项',
              allowedActions: [],
            });
        }
        state.projectNode = 'PRODUCTION_TASK';
      });
    if (log.path === '/api/v1/project-personnel/attendance/list') {
      if (state.attendanceStatus !== 200)
        return reply(null, state.attendanceStatus, '项目考勤读取失败');
      let records = state.rows.filter(
        (row) => !['LEFT', 'REMOVED', 'ENTRY_DECLINED'].includes(row.status),
      );
      if (log.body?.keyword)
        records = records.filter((row) => row.displayName.includes(String(log.body!.keyword)));
      const organizations = log.body?.organizationIds as string[] | undefined;
      if (organizations?.length)
        records = records.filter(
          (row) => row.organizationId !== null && organizations.includes(row.organizationId),
        );
      const month = String(log.body?.month);
      return reply(
        pageOf(
          records.map((row) => {
            const day = {
              ...attendanceExample.records[0].days[0],
              date: `${month}-02`,
              shiftStartAt: `${month}-02 09:00:00`,
              shiftEndAt: `${month}-02 18:00:00`,
              firstClockInAt: `${month}-02 09:10:00.000`,
              lastClockOutAt: `${month}-02 17:50:00.000`,
            };
            const statuses = log.body?.attendanceStatuses as string[] | undefined;
            const days =
              statuses?.length && !statuses.includes(day.finalAttendanceStatus) ? [] : [day];
            return {
              memberId: row.memberId,
              userId: row.userId,
              uid: row.uid,
              displayName: row.displayName,
              organizationId: row.organizationId,
              organizationName: row.organizationName,
              summary: days.length
                ? attendanceExample.records[0].summary
                : {
                    scheduledCount: 0,
                    presentCount: 0,
                    lateCount: 0,
                    earlyLeaveCount: 0,
                    leaveCount: 0,
                    absentCount: 0,
                  },
              days,
            };
          }),
        ),
      );
    }
    if (log.path === '/api/v1/project-personnel/production/list') {
      return reply(
        pageOf([
          {
            ...structuredClone(productionListResponse.examples[0].records[0]),
            memberId: 1,
            userId: state.rows[0].userId,
            displayName: '待入项成员甲',
            reportDate: String(log.body?.reportDateStart),
            allowedActions: state.primary ? ['CREATE_PERFORMANCE'] : [],
          },
        ]),
      );
    }
    if (log.path === '/api/v1/project-personnel/performance/list') {
      if (state.performanceStatus !== 200)
        return reply(null, state.performanceStatus, '成员表现暂时无法读取');
      const records = (state.performances.get(Number(log.body?.memberId)) ?? []).filter(
        (row) =>
          (!log.body?.recordDateStart || row.recordDate >= String(log.body.recordDateStart)) &&
          (!log.body?.recordDateEnd || row.recordDate <= String(log.body.recordDateEnd)),
      );
      return reply(pageOf(records));
    }
    if (log.path === '/api/v1/project-personnel/performance/create')
      return runWrite('performance', () => {
        const id = Number(log.body!.memberId),
          records = state.performances.get(id) ?? [];
        const ids = log.body?.attachmentIds as string[] | undefined;
        records.unshift({
          performanceId: 100 + records.length,
          recordDate: String(log.body!.recordDate),
          content: String(log.body!.content).trim(),
          attachmentIds: ids ?? [],
          attachments: ids?.length
            ? [
                {
                  fileId: uploaded.fileId,
                  objectKey: uploaded.objectKey,
                  fileName: uploaded.fileName,
                },
              ]
            : [],
          recordedByName: '主策略官',
          createdAt: '2026-11-03 12:00:00',
        });
        state.performances.set(id, records);
      });
    if (log.path === '/api/v1/files/upload')
      return reply(
        state.uploadStatus === 200
          ? { ...uploaded, fileName: log.fileName, size: Buffer.byteLength(log.form.file ?? '') }
          : null,
        state.uploadStatus,
        '表现附件上传结果',
      );
    if (log.path === '/api/v1/files/view')
      return route.fulfill({
        status: 200,
        contentType: 'application/octet-stream',
        body: 'isolated personnel attachment',
      });
    if (log.path === '/api/v1/project-personnel/movements/target-projects')
      return reply(
        state.targetStatus === 200
          ? (log.body?.memberIds as number[]).some(
              (id) => !state.rows.find((row) => row.memberId === id)?.organizationId,
            )
            ? {
                total: 0,
                current: log.body?.current ?? 1,
                size: log.body?.size ?? 20,
                pages: 0,
                records: [],
              }
            : {
                ...transferTargetExample,
                current: log.body?.current ?? 1,
                size: log.body?.size ?? 20,
              }
          : null,
        state.targetStatus,
        '转项候选读取结果',
      );
    if (log.path === '/api/v1/project-personnel/movements/list') {
      let records = state.movements;
      if (log.body?.movementId)
        records = records.filter((row) => row.movementId === log.body!.movementId);
      if (log.body?.memberId)
        records = records.filter((row) => row.memberId === log.body!.memberId);
      const types = log.body?.movementTypes as string[] | undefined,
        statuses = log.body?.statuses as string[] | undefined;
      if (types?.length) records = records.filter((row) => types.includes(row.movementType));
      if (statuses?.length) records = records.filter((row) => statuses.includes(row.status));
      if (log.body?.keyword)
        records = records.filter((row) => row.displayName.includes(String(log.body!.keyword)));
      return reply(
        state.movementStatus === 200
          ? pageOf(
              records.map((row) => ({
                ...row,
                allowedActions: state.primary ? row.allowedActions : [],
              })),
            )
          : null,
        state.movementStatus,
        '人员异动读取结果',
      );
    }
    if (log.path === '/api/v1/project-personnel/movements/detail') {
      const row = state.movements
        .filter(
          (movement) =>
            movement.sourceProjectId === log.body?.projectId &&
            movement.memberId === log.body?.memberId,
        )
        .at(-1);
      return reply(
        row ? { ...row, allowedActions: state.primary ? row.allowedActions : [] } : null,
        row ? 200 : 404,
        row ? '操作成功' : '没有人员异动记录',
      );
    }
    if (log.path === '/api/v1/project-personnel/movements/create')
      return runWrite('movement-create', () => {
        for (const id of log.body!.memberIds as number[]) {
          const row = state.rows.find((member) => member.memberId === id)!;
          const transfer = log.body!.movementType === 'TRANSFER';
          state.movements.push({
            ...structuredClone(movementItemExample),
            movementId: 100 + state.movements.length,
            memberId: id,
            userId: row.userId,
            uid: row.uid,
            displayName: row.displayName,
            accountType: row.accountType,
            organizationId: row.organizationId,
            organizationName: row.organizationName,
            sourceProjectId: projectId,
            sourceProjectName: project.projectName,
            targetProjectId: transfer ? Number(log.body!.targetProjectId) : null,
            targetProjectName: transfer ? '目标项目' : null,
            movementType: transfer ? 'TRANSFER' : 'REMOVAL',
            reason: String(log.body!.reason),
            plannedEffectiveDate: String(log.body!.plannedEffectiveDate),
            status: transfer ? 'PROCESSING' : 'WAITING_EFFECTIVE',
            statusName: transfer ? '审批处理中' : '待生效',
            flowNo: transfer ? `TF${100 + state.movements.length}` : null,
            flowStatus: transfer ? 'PENDING' : null,
            flowVersionNo: transfer ? 0 : null,
            currentNode: transfer ? 1 : null,
            approvalSteps: [],
            allowedActions: ['WITHDRAW'],
          });
          Object.assign(row, {
            status: transfer ? 'PENDING_TRANSFER' : 'PENDING_EXIT',
            statusName: transfer ? '转项中' : '待离项',
            plannedLeaveDate: log.body!.plannedEffectiveDate,
          });
        }
      });
    if (log.path === '/api/v1/project-personnel/movements/withdraw')
      return runWrite('movement-withdraw', () => {
        const movement = state.movements.find((row) => row.movementId === log.body!.movementId)!;
        Object.assign(movement, {
          status: 'WITHDRAWN',
          statusName: '已撤回',
          withdrawnAt: '2026-11-03 12:00:00',
          allowedActions: [],
        });
      });
    if (log.path === '/api/v1/project-personnel/movements/process')
      return runWrite('movement-process', () => {
        const movement = state.movements.find((row) => row.movementId === log.body!.movementId)!;
        const step = movement.approvalSteps.find((row) => row.nodeId === log.body!.nodeId);
        if (step)
          Object.assign(step, {
            nodeStatus: log.body!.action === 'REJECT' ? 'REJECTED' : 'APPROVED',
            nodeVersionNo: step.nodeVersionNo + 1,
            operatorId: user.id,
            operatorName: '主策略官',
            action: log.body!.action,
            actionComment: log.body!.actionComment ?? null,
            actionAt: '2026-11-03 12:00:00',
          });
        Object.assign(movement, {
          status: log.body!.action === 'REJECT' ? 'REJECTED' : 'WAITING_EFFECTIVE',
          statusName: log.body!.action === 'REJECT' ? '已驳回' : '待生效',
          allowedActions: [],
          flowVersionNo: Number(movement.flowVersionNo) + 1,
        });
      });
    return reply(null, 404, '隔离测试未提供此接口');
  });
  return { state, requests, release: async () => release?.() };
}

async function openPersonnel(page: Page) {
  await page.goto(`${origin}/#/strategist/projects/${projectId}?tab=PERSONNEL_MANAGEMENT`);
  const panel = page.getByRole('region', { name: '人员管理', exact: true });
  await expect(panel).toBeVisible();
  return panel;
}
const entryWrites = (requests: RequestLog[]) =>
  requests.filter((request) => request.path.endsWith('/roster/entry/save'));
const performanceWrites = (requests: RequestLog[]) =>
  requests.filter((request) => request.path.endsWith('/performance/create'));
const movementWrites = (requests: RequestLog[], command: string) =>
  requests.filter((request) => request.path.endsWith(`/movements/${command}`));
const memberRow = (page: Page, name: string) =>
  page
    .getByRole('region', { name: '人员管理', exact: true })
    .getByRole('article', { name, exact: true });

function movementFixture(id = 201): Movement {
  return {
    ...structuredClone(movementItemExample),
    movementId: id,
    movementNo: `TF-${id}`,
    movementType: 'TRANSFER',
    status: 'PROCESSING',
    statusName: '审批处理中',
    memberId: 5,
    userId: uuid(105),
    uid: 'MEMBER5',
    displayName: '组织在项成员',
    accountType: 'ORGANIZATION',
    organizationId: uuid(80),
    organizationName: '人员协作组',
    sourceProjectId: projectId,
    sourceProjectName: project.projectName,
    targetProjectId: 2,
    targetProjectName: '目标项目',
    flowNo: `TF-${id}`,
    flowStatus: 'PENDING',
    flowVersionNo: 3,
    currentNode: 4,
    approvalSteps: [
      {
        nodeId: uuid(31),
        nodeSeq: 4,
        nodeCode: 'TARGET_MANAGER',
        nodeName: '目标主策略官审批',
        nodeStatus: 'PENDING',
        operatorId: null,
        operatorName: null,
        action: null,
        actionComment: null,
        actionAt: null,
        nodeVersionNo: 2,
      },
    ],
    allowedActions: ['APPROVE', 'REJECT'],
  };
}

for (const desktop of [false, true]) {
  test(`${desktop ? '桌面运行配置' : 'Web'}主策略官批量保存未来入项，成员ID与Cookie正确且不冒充已生效`, async ({
    page,
  }) => {
    const fixture = await backend(page, desktop);
    const panel = await openPersonnel(page);
    if (!desktop)
      await page.screenshot({
        path: 'artifacts/strategist-personnel/personnel-desktop.png',
        fullPage: true,
      });
    await panel.getByRole('checkbox', { name: '选择待入项成员甲', exact: true }).check();
    await panel.getByRole('checkbox', { name: '选择待入项成员乙', exact: true }).check();
    await panel.getByRole('button', { name: '批量设置入项', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '设置入项', exact: true });
    await dialog.getByRole('radio', { name: '确认入项', exact: true }).check();
    await dialog.getByLabel(/^预计入项日期/).fill('2099-11-03');
    fixture.state.hold = 'entry';
    await dialog.getByRole('button', { name: '确认保存入项决定', exact: true }).click();
    await expect.poll(() => entryWrites(fixture.requests).length).toBe(1);
    await expect(
      dialog.getByRole('button', { name: '确认保存入项决定', exact: true }),
    ).toBeDisabled();
    await fixture.release();
    await expect(dialog).toHaveCount(0);
    expect(entryWrites(fixture.requests)[0].body).toMatchObject({
      projectId,
      memberIds: [1, 2],
      entryDecision: 'YES',
      plannedEntryDate: '2099-11-03',
    });
    expect(entryWrites(fixture.requests)[0].headers.cookie).toContain('personnel_session=active');
    expect(entryWrites(fixture.requests)[0].headers['x-tyde-client']).toBe('web');
    expect(fixture.state.rows.slice(0, 2).map((row) => [row.status, row.joinedAt])).toEqual([
      ['PENDING_ENTRY', null],
      ['PENDING_ENTRY', null],
    ]);
    expect(entryWrites(fixture.requests)).toHaveLength(1);
    expect(project.versionNo).toBe(4);
  });
}

test('放弃入项须填写原因，提交只使用当前项目成员ID而不传脱敏用户信息', async ({ page }) => {
  const { state, requests } = await backend(page);
  await openPersonnel(page);
  await memberRow(page, '待入项成员甲')
    .getByRole('button', { name: '设置入项', exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: '设置入项', exact: true });
  await dialog.getByRole('radio', { name: '放弃入项', exact: true }).check();
  await dialog.getByRole('button', { name: '确认保存入项决定', exact: true }).click();
  expect(entryWrites(requests)).toHaveLength(0);
  await dialog.getByLabel('放弃原因', { exact: true }).fill('无法按期参加本项目');
  await dialog.getByRole('button', { name: '确认保存入项决定', exact: true }).click();
  await expect.poll(() => state.rows[0].status).toBe('ENTRY_DECLINED');
  expect(entryWrites(requests)[0].body).toMatchObject({
    projectId,
    memberIds: [1],
    entryDecision: 'NO',
    declineReason: '无法按期参加本项目',
  });
  expect(entryWrites(requests)[0].body).not.toHaveProperty('userId');
  expect(state.rows[0].plannedEntryDate).toBeNull();
});

test('协作策略官可读花名册，不提供入项、跨日期表现或人员变动写入口', async ({ page }) => {
  const { state, requests } = await backend(page);
  state.primary = false;
  const panel = await openPersonnel(page);
  await expect(memberRow(page, '历史离项成员')).toBeVisible();
  await expect(panel.getByRole('button', { name: '设置入项', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: '批量设置入项', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: '成员表现', exact: true })).toHaveCount(0);
  await panel.getByRole('tab', { name: '变动记录', exact: true }).click();
  await expect(panel.getByRole('button', { name: /发起转项|发起汰换/ })).toHaveCount(0);
  expect(entryWrites(requests)).toHaveLength(0);
  expect(performanceWrites(requests)).toHaveLength(0);
});

test('花名册服务端分页与搜索使用交集，查询新条件回到第一页', async ({ page }) => {
  const { requests } = await backend(page);
  const panel = await openPersonnel(page);
  await panel.getByRole('navigation').getByRole('button', { name: '下一页', exact: true }).click();
  await expect(panel.getByRole('navigation').getByText(/第 2 \//)).toBeVisible();
  await panel.getByRole('searchbox', { name: '筛选项目成员', exact: true }).fill('待入项成员乙');
  await panel.getByRole('button', { name: '查询成员', exact: true }).click();
  await expect(memberRow(page, '待入项成员乙')).toBeVisible();
  await expect(memberRow(page, '待入项成员甲')).toHaveCount(0);
  const reads = requests.filter((request) => request.path.endsWith('/roster/list'));
  expect(reads.some((request) => request.body?.current === 2)).toBe(true);
  expect(reads.at(-1)?.body).toMatchObject({ projectId, keyword: '待入项成员乙', current: 1 });
});

test('花名册403不提供旧人员写入入口，也不回退成模拟成功', async ({ page }) => {
  const { state, requests } = await backend(page);
  state.rosterStatus = 403;
  const panel = await openPersonnel(page);
  await expect(panel.getByText('花名册暂时无法读取', { exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: '设置入项', exact: true })).toHaveCount(0);
  expect(entryWrites(requests)).toHaveLength(0);
});

test('入项响应未知保留成员与决定，关闭重开或显式重读不能自动重复保存', async ({ page }) => {
  const { state, requests } = await backend(page);
  state.unknown = 'entry';
  await openPersonnel(page);
  await memberRow(page, '待入项成员甲')
    .getByRole('button', { name: '设置入项', exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: '设置入项', exact: true });
  await dialog.getByLabel(/^预计入项日期/).fill('2099-11-03');
  await dialog.getByRole('button', { name: '确认保存入项决定', exact: true }).click();
  await expect(
    dialog.getByText('入项决定结果尚未确认，已保留本次成员与决定，暂停重复保存。', { exact: true }),
  ).toBeVisible();
  page.once('dialog', (confirmation) => confirmation.accept());
  await dialog.getByRole('button', { name: '关闭弹窗', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole('tab', { name: '生产任务', exact: true }).click();
  await page.getByRole('tab', { name: '人员管理', exact: true }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '重新读取人员信息', exact: true }).click();
  expect(entryWrites(requests)).toHaveLength(1);
  await expect(
    dialog.getByRole('button', { name: '确认保存入项决定', exact: true }),
  ).toBeDisabled();
  await expect(dialog.getByLabel(/^预计入项日期/)).toHaveValue('2099-11-03');
});

test('入项已成功但待办读取失败只重读，不重复保存原决定', async ({ page }) => {
  const { state, requests } = await backend(page);
  state.failAfterWrite = 'list';
  const panel = await openPersonnel(page);
  await memberRow(page, '待入项成员甲')
    .getByRole('button', { name: '设置入项', exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: '设置入项', exact: true });
  await dialog.getByLabel(/^预计入项日期/).fill('2099-11-03');
  await dialog.getByRole('button', { name: '确认保存入项决定', exact: true }).click();
  await expect(
    panel.getByText('入项决定已保存，后续信息读取失败，请重新读取人员信息。', { exact: true }),
  ).toBeVisible();
  expect(entryWrites(requests)).toHaveLength(1);
  state.listStatus = 200;
  await dialog.getByRole('button', { name: '重新读取人员信息', exact: true }).click();
  await expect(page.getByRole('tab', { name: '生产任务', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  expect(entryWrites(requests)).toHaveLength(1);
});

test('项目月考勤按真实排班展示毫秒打卡时间，不补造未排班日期', async ({ page }) => {
  const { requests } = await backend(page);
  const panel = await openPersonnel(page);
  await panel.getByRole('tab', { name: '排班考勤', exact: true }).click();
  await panel.getByLabel('考勤月份', { exact: true }).fill('2026-10');
  await panel.getByRole('searchbox', { name: '筛选考勤成员', exact: true }).fill('待入项成员甲');
  await panel.getByRole('button', { name: '查询考勤', exact: true }).click();
  await panel
    .getByRole('article', { name: '待入项成员甲考勤', exact: true })
    .getByRole('button', { name: '查看考勤明细', exact: true })
    .click();
  const details = page.getByRole('dialog', { name: '考勤明细', exact: true });
  await expect(details.getByText('2026-10-02', { exact: true })).toBeVisible();
  await expect(details.getByText(/09:10:00\.000/)).toBeVisible();
  await expect(details.getByText(/17:50:00\.000/)).toBeVisible();
  await expect(details.getByText('2026-10-01', { exact: true })).toHaveCount(0);
  const reads = requests.filter((request) => request.path.endsWith('/attendance/list'));
  expect(reads.at(-1)?.body).toMatchObject({
    projectId,
    month: '2026-10',
    keyword: '待入项成员甲',
    current: 1,
  });
});

test('考勤状态只筛明细和汇总，不减少成员总数或补造缺勤', async ({ page }) => {
  await backend(page);
  const panel = await openPersonnel(page);
  await panel.getByRole('tab', { name: '排班考勤', exact: true }).click();
  await panel.getByRole('searchbox', { name: '筛选考勤成员', exact: true }).fill('待入项成员甲');
  await panel.getByRole('checkbox', { name: '正常', exact: true }).check();
  await panel.getByRole('button', { name: '查询考勤', exact: true }).click();
  await expect(
    panel
      .getByRole('navigation', { name: '项目考勤分页', exact: true })
      .getByText('共 1 条记录', { exact: true }),
  ).toBeVisible();
  await panel
    .getByRole('article', { name: '待入项成员甲考勤', exact: true })
    .getByRole('button', { name: '查看考勤明细', exact: true })
    .click();
  await expect(
    page
      .getByRole('dialog', { name: '考勤明细', exact: true })
      .getByText('本月暂无符合条件的排班明细', { exact: true }),
  ).toBeVisible();
});

test('375px人员花名册长姓名和筛选不撑破页面', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const { state } = await backend(page);
  state.rows[0].displayName = `长姓名${'LongMember'.repeat(15)}`;
  await openPersonnel(page);
  await expect(memberRow(page, state.rows[0].displayName)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await page.screenshot({
    path: 'artifacts/strategist-personnel/personnel-375.png',
    fullPage: true,
  });
});

async function openPerformance(page: Page) {
  const panel = await openPersonnel(page);
  await panel.getByRole('tab', { name: '生产情况', exact: true }).click();
  await panel.getByLabel('生产日期', { exact: true }).fill('2026-10-22');
  await panel.getByRole('button', { name: '查询日生产', exact: true }).click();
  await panel
    .getByRole('article', { name: '待入项成员甲 2026-10-22', exact: true })
    .getByRole('button', { name: '记录成员表现', exact: true })
    .click();
  const list = page.getByRole('dialog', { name: '成员表现', exact: true });
  await list.getByRole('button', { name: '新增表现记录', exact: true }).click();
  return { list, editor: page.getByRole('dialog', { name: '新增表现记录', exact: true }) };
}

test('表现从生产日期录入纯文本，不提供改日期或附件上传，保存沿用真实成员和日期', async ({
  page,
}) => {
  const { state, requests } = await backend(page);
  const { list, editor } = await openPerformance(page);
  await expect(editor.getByLabel('发生日期', { exact: true })).toHaveCount(0);
  await expect(editor.getByLabel('上传表现附件', { exact: true })).toHaveCount(0);
  await editor.getByLabel('表现内容', { exact: true }).fill('按期完成工作，保存原始记录。');
  await editor.getByRole('button', { name: '保存表现记录', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(list.getByText('按期完成工作，保存原始记录。', { exact: true })).toBeVisible();
  expect(performanceWrites(requests)).toHaveLength(1);
  expect(performanceWrites(requests)[0].body).toMatchObject({
    projectId,
    memberId: 1,
    recordDate: '2026-10-22',
    content: '按期完成工作，保存原始记录。',
    attachmentIds: [],
  });
  expect(requests.filter((request) => request.path === '/api/v1/files/upload')).toHaveLength(0);
  expect(state.performances.get(1)?.[0].attachmentIds).toEqual([]);
});

test('生产日期表现正文必填，未知保存保留草稿并停止重发', async ({ page }) => {
  const { state, requests } = await backend(page);
  state.unknown = 'performance';
  const { editor } = await openPerformance(page);
  await editor.getByRole('button', { name: '保存表现记录', exact: true }).click();
  expect(performanceWrites(requests)).toHaveLength(0);
  await editor
    .getByLabel('表现内容', { exact: true })
    .fill('历史成员仍可记录表现，未知结果保留内容');
  await editor.getByRole('button', { name: '保存表现记录', exact: true }).click();
  await expect(
    editor.getByText('表现记录保存结果尚未确认，已保留内容并暂停重发。', { exact: true }),
  ).toBeVisible();
  await editor.getByRole('button', { name: '重新读取表现', exact: true }).click();
  await expect(editor.getByRole('textbox', { name: '表现内容', exact: true })).toHaveValue(
    '历史成员仍可记录表现，未知结果保留内容',
  );
  await expect(editor.getByRole('button', { name: '保存表现记录', exact: true })).toBeDisabled();
  expect(performanceWrites(requests)).toHaveLength(1);
});

test('后端未提供CREATE_REMOVAL时主策略官不可仅凭已入项状态发起汰换', async ({ page }) => {
  const { requests } = await backend(page);
  const panel = await openPersonnel(page);
  await panel.getByRole('checkbox', { name: '选择在项成员', exact: true }).check();
  await panel.getByRole('tab', { name: '变动记录', exact: true }).click();
  await expect(panel.getByRole('button', { name: '发起汰换', exact: true })).toBeDisabled();
  await expect(panel.getByRole('button', { name: '发起转项', exact: true })).toBeDisabled();
  expect(movementWrites(requests, 'create')).toHaveLength(0);
  expect(movementWrites(requests, 'target-projects')).toHaveLength(0);
});

test('后端未提供CREATE_TRANSFER时不能选择目标或发起转项', async ({ page }) => {
  const { requests } = await backend(page);
  const panel = await openPersonnel(page);
  await panel.getByRole('checkbox', { name: '选择组织在项成员', exact: true }).check();
  await panel.getByRole('tab', { name: '变动记录', exact: true }).click();
  await expect(panel.getByRole('button', { name: '发起汰换', exact: true })).toBeDisabled();
  await expect(panel.getByRole('button', { name: '发起转项', exact: true })).toBeDisabled();
  expect(movementWrites(requests, 'create')).toHaveLength(0);
  expect(movementWrites(requests, 'target-projects')).toHaveLength(0);
});

for (const action of ['APPROVE', 'REJECT'] as const) {
  test(`当前主策略官${action === 'APPROVE' ? '同意' : '驳回'}人工转项节点，精确提交节点和流程版本`, async ({
    page,
  }) => {
    const { state, requests } = await backend(page);
    state.movements = [movementFixture()];
    const panel = await openPersonnel(page);
    await panel.getByRole('tab', { name: '变动记录', exact: true }).click();
    await panel
      .getByRole('region', { name: '人员异动记录', exact: true })
      .getByRole('button', { name: '查看变动详情', exact: true })
      .click();
    const details = page.getByRole('dialog', { name: '人员变动详情', exact: true });
    const label = action === 'APPROVE' ? '同意转项' : '驳回转项';
    await details.getByRole('button', { name: label, exact: true }).click();
    const confirmation = page.getByRole('dialog', { name: label, exact: true });
    if (action === 'REJECT') {
      await confirmation.getByRole('button', { name: '确认操作', exact: true }).click();
      expect(movementWrites(requests, 'process')).toHaveLength(0);
      await expect(confirmation).toHaveCount(0);
      await details.getByRole('button', { name: label, exact: true }).click();
      await confirmation.getByLabel('审批意见', { exact: true }).fill('目标项目暂不接受');
    }
    await confirmation.getByRole('button', { name: '确认操作', exact: true }).click();
    await expect.poll(() => movementWrites(requests, 'process').length).toBe(1);
    expect(movementWrites(requests, 'process')[0].body).toMatchObject({
      projectId,
      movementId: 201,
      flowNo: 'TF-201',
      nodeId: uuid(31),
      nodeVersionNo: 2,
      flowVersionNo: 3,
      action,
    });
    expect(movementWrites(requests, 'detail')[0].body).toEqual({ projectId, memberId: 5 });
  });
}

test('本人接单和目标考试等待节点不能被PM人工审批跳过', async ({ page }) => {
  const { state, requests } = await backend(page);
  const movement = movementFixture();
  movement.currentNode = 1;
  movement.approvalSteps[0] = {
    ...movement.approvalSteps[0],
    nodeSeq: 1,
    nodeCode: 'MEMBER_CONFIRM',
    nodeName: '本人接单',
  };
  movement.allowedActions = ['ACCEPT_TRANSFER', 'REJECT_TRANSFER', 'TAKE_TARGET_EXAM'];
  state.movements = [movement];
  const panel = await openPersonnel(page);
  await panel.getByRole('tab', { name: '变动记录', exact: true }).click();
  await panel.getByRole('button', { name: '查看变动详情', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '人员变动详情', exact: true });
  await expect(dialog.getByRole('button', { name: '同意转项', exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: '驳回转项', exact: true })).toHaveCount(0);
  expect(movementWrites(requests, 'process')).toHaveLength(0);
});

test('历史异动不等于最新详情时不能沿用旧节点动作', async ({ page }) => {
  const { state, requests } = await backend(page);
  state.movements = [movementFixture()];
  const panel = await openPersonnel(page);
  await panel.getByRole('tab', { name: '变动记录', exact: true }).click();
  const view = panel.getByRole('button', { name: '查看变动详情', exact: true });
  await expect(view).toBeVisible();
  state.movements.push(movementFixture(202));
  await view.click();
  const dialog = page.getByRole('dialog', { name: '人员变动详情', exact: true });
  await expect(dialog.getByRole('button', { name: '同意转项', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: '驳回转项', exact: true })).toBeDisabled();
  expect(movementWrites(requests, 'detail')[0].body).toEqual({ projectId, memberId: 5 });
});

test('发起人仅在允许撤回时显式撤回，使用movementId而不冒用memberId', async ({ page }) => {
  const { state, requests } = await backend(page);
  const movement = movementFixture();
  movement.allowedActions = ['WITHDRAW'];
  state.movements = [movement];
  const panel = await openPersonnel(page);
  await panel.getByRole('tab', { name: '变动记录', exact: true }).click();
  await panel.getByRole('button', { name: '查看变动详情', exact: true }).click();
  await page
    .getByRole('dialog', { name: '人员变动详情', exact: true })
    .getByRole('button', { name: '撤回变动', exact: true })
    .click();
  await page
    .getByRole('dialog', { name: '撤回变动', exact: true })
    .getByRole('button', { name: '确认操作', exact: true })
    .click();
  await expect.poll(() => movementWrites(requests, 'withdraw').length).toBe(1);
  expect(movementWrites(requests, 'withdraw')[0].body).toEqual({ projectId, movementId: 201 });
  expect(state.movements[0].status).toBe('WITHDRAWN');
});

test('切换列表不会为缺少授权动作的成员恢复变动发起能力', async ({ page }) => {
  const { requests } = await backend(page);
  const panel = await openPersonnel(page);
  await panel.getByRole('checkbox', { name: '选择在项成员', exact: true }).check();
  await panel.getByRole('tab', { name: '变动记录', exact: true }).click();
  await expect(panel.getByRole('button', { name: '发起汰换', exact: true })).toBeDisabled();
  await expect(panel.getByRole('button', { name: '发起转项', exact: true })).toBeDisabled();
  expect(movementWrites(requests, 'create')).toHaveLength(0);
  expect(movementWrites(requests, 'target-projects')).toHaveLength(0);
});

for (const applied of [false, true]) {
  test(`审批响应未知${applied ? '已生效' : '未生效'}，只按精确节点动作核实而不自动重发`, async ({
    page,
  }) => {
    const { state, requests } = await backend(page);
    state.movements = [movementFixture()];
    state.unknown = 'movement-process';
    state.applyUnknown = applied;
    const panel = await openPersonnel(page);
    await panel.getByRole('tab', { name: '变动记录', exact: true }).click();
    await panel.getByRole('button', { name: '查看变动详情', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '人员变动详情', exact: true });
    await dialog.getByRole('button', { name: '同意转项', exact: true }).click();
    await page
      .getByRole('dialog', { name: '同意转项', exact: true })
      .getByRole('button', { name: '确认操作', exact: true })
      .click();
    await expect(dialog.getByRole('button', { name: '核实变动结果', exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: '核实变动结果', exact: true }).click();
    if (applied) await expect(dialog).toHaveCount(0);
    else {
      await expect(dialog.getByRole('button', { name: '同意转项', exact: true })).toBeDisabled();
      await expect(
        dialog.getByText('已读取该变动的最新记录，仍未核实目标节点动作，继续暂停重发。', {
          exact: true,
        }),
      ).toBeVisible();
    }
    expect(movementWrites(requests, 'process')).toHaveLength(1);
    expect(
      movementWrites(requests, 'list').some(
        (request) => request.body?.movementId === 201 && request.body?.size === 1,
      ),
    ).toBe(true);
  });
}

test('人员异动审批卡直达人员管理异动子页，刷新不回退到花名册或生产计划', async ({ page }) => {
  const { state, requests } = await backend(page);
  state.movements = [movementFixture()];
  await page.route('**/api/v1/projects/manager/list', (route) =>
    route.fulfill({
      status: 200,
      json: {
        code: 200,
        message: '操作成功',
        data: [{ ...strategistProjectCard(project), branchNodeCode: 'MEMBER_MOVEMENT_APPROVAL' }],
      },
    }),
  );
  await page.goto(`${origin}/#/strategist/projects`);
  await page.getByRole('link', { name: '人员管理', exact: true }).click();
  const panel = page.getByRole('region', { name: '人员管理', exact: true });
  await expect(panel.getByRole('tab', { name: '变动记录', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(panel.getByRole('region', { name: '人员异动记录', exact: true })).toBeVisible();
  await page.reload();
  await expect(panel.getByRole('tab', { name: '变动记录', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  expect(movementWrites(requests, 'process')).toHaveLength(0);
});
