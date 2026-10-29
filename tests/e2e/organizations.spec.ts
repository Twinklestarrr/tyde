import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test, expect, type Locator, type Page } from '@playwright/test';
import type {
  AuthUser,
  OrganizationDetail,
  OrganizationMember,
  OrganizationPendingApproval,
  OrganizationApprovalRecord,
  OrganizationImportResult,
} from '../../packages/shared/src/index';

const uuid = (id: number) => `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`;
const orgId = uuid(100);
const timestamp = '2026-01-02T01:00:00.000Z';
const userFixture: AuthUser = {
  id: uuid(1),
  uid: 'ORG10001',
  accountType: 'ORGANIZATION',
  phone: '138****0001',
  nickname: '联调主管',
  realName: '测试主管',
  idCardNo: null,
  idVerified: 0,
  avatarUrl: null,
  bio: null,
  role: 'EXPERT',
  roles: ['EXPERT'],
  selectedRole: 'EXPERT',
  hasExpertManagementRole: true,
  status: 'ACTIVE',
  creditScore: 100,
  lastLoginAt: null,
  lastLoginIp: null,
  organization: null,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const organizationFixture: OrganizationDetail = {
  id: orgId,
  name: '潮汐组织联调组',
  unifiedCreditCode: '91310000TEST000002',
  description: '来自真实接口契约的组织简介',
  businessLicenseUrl: null,
  logoUrl: null,
  expertiseTags: ['数据标注'],
  verifyStatus: 'APPROVED',
  status: 'ACTIVE',
  position: 'OWNER',
  createdAt: timestamp,
};
const memberFixture = (
  id: number,
  name: string,
  position: OrganizationMember['position'] = 'MEMBER',
): OrganizationMember => ({
  memberId: uuid(1000 + id),
  userId: uuid(id),
  uid: `ORG${10000 + id}`,
  realName: name,
  nickname: `${name}昵称`,
  phoneMasked: `138****${String(id).padStart(4, '0')}`,
  avatarUrl: null,
  userStatus: 'ACTIVE',
  employmentType: 'FULL_TIME',
  position,
  joinStatus: 'ACTIVE',
  joinedAt: timestamp,
  plannedLeaveDate: null,
  leftAt: null,
  activeProjectCount: id === 3 ? 2 : 0,
  versionNo: 4,
});
const approvalFixture = (id: number): OrganizationPendingApproval => ({
  flowNo: `OMX${String(id).padStart(40, 'A')}`,
  businessType: 'ORG_MEMBER_EXIT',
  businessId: uuid(1000 + id + 2),
  businessNo: null,
  title: `联调退出申请${id}`,
  applicantName: `申请成员${id}`,
  applyReason: '工作安排调整',
  targetMemberId: uuid(1000 + id + 2),
  targetMemberName: `申请成员${id}`,
  plannedLeaveDate: '2099-01-01',
  appliedAt: timestamp,
  nodeId: uuid(2000 + id),
  nodeVersionNo: id + 2,
  flowVersionNo: id + 6,
  nodeName: '组织主管审批',
  applicantId: uuid(id + 2),
  applicantOrgId: orgId,
  formData: {
    targetMemberId: uuid(1000 + id + 2),
    plannedLeaveDate: '2099-01-01',
    joinStatus: 'EXIT_APPROVING',
  },
  dueAt: null,
});
interface RecordedRequest {
  path: string;
  method: string;
  body: Record<string, unknown> | null;
  headers: Record<string, string>;
  authenticated: boolean;
  form: Record<string, string>;
  fileName?: string;
}

const logoBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAJ0lEQVR4nGNQXLr9PyWYYXAZQCwYxAbgM4zkQBw1YDAYQFZSHhADAOlp0x+yOzC+AAAAAElFTkSuQmCC',
  'base64',
);
const logoReceipt = {
  objectKey: 'org-logo/2026/10/23/0123456789abcdef0123456789abcdef.png',
  uploadToken: 'l'.repeat(43),
  url: 'https://logos.example.test/local-logo.png',
  sensitive: false,
  fileName: 'organization-logo.png',
  extension: 'png',
  size: logoBytes.length,
  contentType: 'image/png',
  fileHash: createHash('sha256').update(logoBytes).digest('hex'),
};

/** 仅检验下载字节与浏览器下载行为，工作簿格式由服务端测试覆盖。 */
const templateBytes = Buffer.from('PK\u0003\u0004organization-template-byte-fixture');
const writePaths = {
  organization: '/api/v1/organizations/update',
  member: '/api/v1/organizations/members/update',
  role: '/api/v1/organizations/members/position',
  departure: '/api/v1/organizations/members/exit-requests',
  approval: '/api/v1/organizations/approvals/process',
  import: '/api/v1/organizations/member-imports/generate',
};
const calls = (requests: RecordedRequest[], path: string) =>
  requests.filter((request) => request.path === path);
const importCell = (dialog: Locator, row: number, column: string) =>
  dialog.getByLabel(`第 ${row} 行 ${column}`, { exact: true });
async function selectImportCell(dialog: Locator, row: number, column: string, option: string) {
  await importCell(dialog, row, column).click();
  await dialog.getByRole('option', { name: option, exact: true }).click();
  await expect(importCell(dialog, row, column)).toHaveText(option);
}
async function importDraft(dialog: Locator) {
  const count = await dialog.getByLabel(/^第 \d+ 行 姓名$/).count();
  return Promise.all(
    Array.from({ length: count }, (_, index) =>
      Promise.all(
        ['姓名', '手机号', '人员属性', '组织角色', '入组日期'].map((column) =>
          importCell(dialog, index + 1, column).evaluate((control) =>
            control instanceof HTMLInputElement ? control.value : control.textContent?.trim(),
          ),
        ),
      ),
    ),
  );
}
async function pasteMembers(cell: Locator, text: string) {
  await cell.evaluate((input, value) => {
    const clipboard = new DataTransfer();
    clipboard.setData('text/plain', value);
    input.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true }),
    );
  }, text);
}

async function organizationBackend(
  page: Page,
  origin: string,
  position: 'OWNER' | 'ADMIN' | 'MEMBER' = 'OWNER',
) {
  const members = [
    memberFixture(1, '测试主管', 'OWNER'),
    memberFixture(2, '联调管理员', 'ADMIN'),
    memberFixture(3, '联调成员甲'),
    ...Array.from({ length: 20 }, (_, index) => memberFixture(index + 4, `其他成员${index + 1}`)),
  ];
  const currentId = position === 'OWNER' ? 1 : position === 'ADMIN' ? 2 : 3;
  const state = {
    user: { ...structuredClone(userFixture), id: uuid(currentId), uid: `ORG${10000 + currentId}` },
    organization: { ...structuredClone(organizationFixture), position },
    members,
    orgStatus: 200,
    organizationUpdateStatus: 200,
    memberUpdateStatus: 200,
    departureStatus: 200,
    approvalStatus: 200,
    pending: [approvalFixture(1), approvalFixture(2)],
    history: [] as OrganizationApprovalRecord[],
    importMode: 'invalid' as 'invalid' | 'network' | 'success',
    importErrorRow: 1,
  };
  state.user.organization = { ...state.organization, joinStatus: 'ACTIVE' };
  const requests: RecordedRequest[] = [];
  await page.context().addCookies([
    {
      name: 'organization_session',
      value: 'active',
      url: origin,
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);
  await page.route('https://logos.example.test/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1" />',
    }),
  );
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const headers = await request.allHeaders();
    const authenticated = Boolean(headers.cookie?.includes('organization_session=active'));
    const contentType = headers['content-type'] || '';
    const body = contentType.includes('application/json')
      ? (request.postDataJSON() as Record<string, unknown>)
      : null;
    const record: RecordedRequest = {
      path: url.pathname,
      method: request.method(),
      body,
      headers,
      authenticated,
      form: {},
    };
    if (contentType.includes('multipart/form-data')) {
      const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType);
      for (const part of (request.postDataBuffer()?.toString('utf8') || '').split(
        `--${boundary?.[1] || boundary?.[2]}`,
      )) {
        const name = /name="([^"]+)"/.exec(part)?.[1];
        const contentStart = part.indexOf('\r\n\r\n');
        if (!name || contentStart < 0) continue;
        record.form[name] = part.slice(contentStart + 4).replace(/\r\n$/, '');
        const fileName = /filename="([^"]+)"/.exec(part)?.[1];
        if (fileName) record.fileName = fileName;
      }
    }
    requests.push(record);
    const reply = (data: unknown, status = 200, message = '操作成功') =>
      route.fulfill({ status, json: { code: status, message, data } });
    if (!authenticated) return reply(null, 401, '请先登录');
    if (url.pathname === '/api/v1/users/me') return reply(state.user);
    if (url.pathname === '/api/v1/expert-assignments/my-tasks' && request.method() === 'POST') {
      expect(body).toEqual({});
      return reply([]);
    }
    if (url.pathname === '/api/v1/files/upload') {
      expect(record.form.bizType).toBe('ORG_LOGO');
      return reply(logoReceipt);
    }
    if (url.pathname === '/api/v1/organizations') {
      expect(url.searchParams.get('orgId')).toBe(orgId);
      return reply(
        state.orgStatus === 200 ? state.organization : null,
        state.orgStatus,
        state.orgStatus === 200 ? '操作成功' : '无权读取组织资料',
      );
    }
    if (url.pathname === writePaths.organization) {
      if (state.organizationUpdateStatus !== 200)
        return reply(null, state.organizationUpdateStatus, '组织资料服务暂不可用');
      for (const key of ['description', 'logoUrl'] as const)
        if (typeof body?.[key] === 'string') state.organization[key] = body[key] as string;
      if (body?.logoUrl === logoReceipt.objectKey) {
        expect(body.logoUploadToken).toBe(logoReceipt.uploadToken);
        state.organization.logoUrl = logoReceipt.url;
      }
      state.user.organization = { ...state.user.organization, ...state.organization };
      return reply({
        id: orgId,
        description: state.organization.description,
        logoUrl: state.organization.logoUrl,
        updatedAt: timestamp,
      });
    }
    if (url.pathname === '/api/v1/organizations/members') {
      const current = Number(body?.current || 1),
        size = Number(body?.size || 20);
      let records = state.members;
      if (body?.keyword)
        records = records.filter((member) =>
          `${member.realName} ${member.uid}`.includes(String(body.keyword)),
        );
      for (const key of ['position', 'employmentType', 'joinStatus'] as const)
        if (body?.[key]) records = records.filter((member) => member[key] === body[key]);
      if (body?.projectId !== undefined && body.projectId !== 42) records = [];
      return reply({
        total: records.length,
        pages: Math.ceil(records.length / size),
        current,
        size,
        records: records.slice((current - 1) * size, current * size),
      });
    }
    if (url.pathname === writePaths.member) {
      if (state.memberUpdateStatus !== 200)
        return reply(null, state.memberUpdateStatus, '成员版本冲突');
      const member = state.members.find((item) => item.memberId === body?.memberId)!;
      if (typeof body?.employmentType === 'string')
        member.employmentType = body.employmentType as OrganizationMember['employmentType'];
      if (typeof body?.joinedAt === 'string')
        member.joinedAt = new Date(`${body.joinedAt.replace(' ', 'T')}+08:00`).toISOString();
      member.versionNo++;
      return reply({
        memberId: member.memberId,
        userId: member.userId,
        employmentType: member.employmentType,
        joinedAt: member.joinedAt,
        versionNo: member.versionNo,
        updatedAt: timestamp,
      });
    }
    if (url.pathname === writePaths.role) {
      const member = state.members.find((item) => item.memberId === body?.memberId)!;
      const beforePosition = member.position;
      if (body?.position === 'OWNER') {
        state.members.find((item) => item.position === 'OWNER')!.position = 'ADMIN';
        state.organization.position = 'ADMIN';
        state.user.organization = { ...state.user.organization, position: 'ADMIN' };
      }
      member.position = body?.position as OrganizationMember['position'];
      return reply({
        memberId: member.memberId,
        beforePosition,
        position: member.position,
        updatedAt: timestamp,
      });
    }
    if (url.pathname === writePaths.departure) {
      if (state.departureStatus !== 200)
        return reply(null, state.departureStatus, '组织退出服务暂不可用');
      const member = state.members.find((item) =>
        body?.memberId ? item.memberId === body.memberId : item.userId === state.user.id,
      )!;
      const self = member.userId === state.user.id;
      member.joinStatus = self ? 'EXIT_APPROVING' : 'PENDING_LEAVE';
      member.plannedLeaveDate = String(body?.plannedLeaveDate);
      if (self)
        state.user.organization = { ...state.user.organization, joinStatus: 'EXIT_APPROVING' };
      return reply({
        flowNo: `OMX${'B'.repeat(40)}`,
        businessType: 'ORG_MEMBER_EXIT',
        businessId: member.memberId,
        flowStatus: self ? 'PENDING' : 'APPROVED',
        memberId: member.memberId,
        joinStatus: member.joinStatus,
        plannedLeaveDate: member.plannedLeaveDate,
        appliedAt: timestamp,
      });
    }
    if (
      url.pathname === '/api/v1/organizations/approvals/pending' ||
      url.pathname === '/api/v1/organizations/approvals/records'
    ) {
      const current = Number(body?.current || 1),
        size = Number(body?.size || 20);
      const records = url.pathname.endsWith('/pending') ? state.pending : state.history;
      return reply({
        total: records.length,
        pages: Math.ceil(records.length / size),
        current,
        size,
        records: records.slice((current - 1) * size, current * size),
      });
    }
    if (url.pathname === writePaths.approval) {
      const pending = state.pending.find((item) => item.nodeId === body?.nodeId)!;
      if (state.approvalStatus !== 200) {
        if (state.approvalStatus === 409) {
          pending.nodeVersionNo++;
          pending.flowVersionNo++;
        }
        return reply(
          null,
          state.approvalStatus,
          state.approvalStatus === 403 ? '当前账户无权审批' : '审批版本冲突',
        );
      }
      const status = body?.action === 'APPROVE' ? 'APPROVED' : 'REJECTED';
      state.pending = state.pending.filter((item) => item.nodeId !== pending.nodeId);
      state.history.unshift({
        ...pending,
        nodeSeq: 1,
        nodeCode: 'OWNER_APPROVAL',
        nodeStatus: status,
        actionType: body?.action as 'APPROVE' | 'REJECT',
        operatorName: '联调主管',
        actionComment: (body?.actionComment as string) || null,
        actionAt: timestamp,
        applicantOrgName: state.organization.name,
        flowStatus: status,
        finishedAt: timestamp,
      });
      return reply({
        flowNo: pending.flowNo,
        nodeId: pending.nodeId,
        action: body?.action,
        nodeStatus: status,
        flowStatus: status,
        currentNode: null,
        joinStatus: status === 'APPROVED' ? 'PENDING_LEAVE' : 'ACTIVE',
        plannedLeaveDate: status === 'APPROVED' ? pending.plannedLeaveDate : null,
        processedAt: timestamp,
        finishedAt: timestamp,
      });
    }
    if (url.pathname === '/api/v1/organizations/member-imports/template')
      return route.fulfill({
        status: 200,
        headers: {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': `attachment; filename="member-import-template.xlsx"; filename*=UTF-8''${encodeURIComponent('成员导入模板.xlsx')}`,
        },
        body: templateBytes,
      });
    if (url.pathname === writePaths.import) {
      if (state.importMode === 'network') return route.abort('failed');
      const invalid = state.importMode === 'invalid';
      const rows = (record.form.memberText || '导入联调成员')
        .split('\n')
        .filter((row) => row.trim());
      const result: OrganizationImportResult = {
        sourceType: record.fileName
          ? /\.xlsx?$/i.test(record.fileName)
            ? 'EXCEL'
            : 'CSV'
          : 'TEXT',
        textIgnored: false,
        totalCount: rows.length,
        validCount: invalid ? Math.max(0, rows.length - 1) : rows.length,
        invalidCount: invalid ? 1 : 0,
        createdCount: invalid ? 0 : rows.length,
        rowErrors: invalid
          ? [
              {
                rowNo: state.importErrorRow,
                field: 'phone',
                value: '138****0004',
                errorCode: 'FORMAT_INVALID',
                message: '手机号格式不正确',
              },
            ]
          : [],
        members: invalid
          ? []
          : rows.map((row, index) => ({
              memberId: uuid(9001 + index * 2),
              userId: uuid(9002 + index * 2),
              uid: `ORG${19002 + index}`,
              accountType: 'INDIVIDUAL',
              phoneMasked: '138****9002',
              realName: row.split(/[,\t]/)[0]!.trim(),
              position: 'MEMBER',
              employmentType: 'FULL_TIME',
              joinedAt: timestamp,
              joinStatus: 'PENDING_ACTIVATION',
            })),
        createdAt: invalid ? null : timestamp,
      };
      return reply(result, invalid ? 400 : 200, invalid ? '成员信息校验失败' : '操作成功');
    }
    return reply(null, 404, '未匹配接口');
  });
  return { state, requests };
}

async function openOrganization(page: Page, origin: string, desktop = false) {
  if (desktop)
    await page.addInitScript((apiBaseUrl) => {
      window.tydeDesktop = { getRuntimeConfig: async () => ({ ok: true, data: { apiBaseUrl } }) };
    }, origin);
  await page.goto(`${origin}/#/organization`);
  await expect(page.getByRole('heading', { name: '组织管理', exact: true })).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: '联调成员甲' })).toBeVisible();
}

for (const [mode, origin, desktop] of [
  ['Web 生产', 'http://127.0.0.1:5176', false],
  ['Web DEV', 'http://127.0.0.1:5177', false],
  ['Electron 运行配置', 'http://127.0.0.1:5176', true],
] as const) {
  test(`组织管理 ${mode} 资料差量保存、成员筛选分页、版本冲突和主管转让`, async ({ page }) => {
    const { state, requests } = await organizationBackend(page, origin);
    await openOrganization(page, origin, desktop);
    await page.getByRole('button', { name: '编辑组织资料', exact: true }).click();
    const edit = page.getByRole('dialog', { name: '编辑组织资料', exact: true });
    await expect(edit.getByLabel('Logo 地址', { exact: true })).not.toBeVisible();
    await edit.getByRole('button', { name: '使用图片链接', exact: true }).click();
    await edit.getByLabel('Logo 地址', { exact: true }).fill('javascript:alert(1)');
    await edit.getByRole('button', { name: '保存组织资料', exact: true }).click();
    await expect(
      edit
        .getByRole('region', { name: '组织 Logo', exact: true })
        .getByText(/请输入不含用户名和密码的 HTTPS 图片地址/),
    ).toBeVisible();
    expect(calls(requests, writePaths.organization)).toHaveLength(0);
    await edit.getByLabel('Logo 地址', { exact: true }).fill('https://logos.example.test/team.png');
    await edit.getByLabel('组织简介', { exact: true }).fill('  双端保存的组织简介  ');
    state.organizationUpdateStatus = 503;
    await edit.getByRole('button', { name: '保存组织资料', exact: true }).click();
    await expect(edit.getByText('组织资料服务暂不可用', { exact: true })).toBeVisible();
    await expect(edit.getByLabel('组织简介', { exact: true })).toHaveValue(
      '  双端保存的组织简介  ',
    );
    expect(calls(requests, writePaths.organization)).toHaveLength(1);
    state.organizationUpdateStatus = 200;
    await edit.getByRole('button', { name: '保存组织资料', exact: true }).click();
    await expect(edit).not.toBeVisible();
    expect(calls(requests, writePaths.organization).at(-1)?.body).toEqual({
      orgId,
      description: '双端保存的组织简介',
      logoUrl: 'https://logos.example.test/team.png',
    });
    await page.reload();
    await expect(
      page.getByLabel('组织基本信息').getByText('双端保存的组织简介', { exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: '编辑组织资料', exact: true }).click();
    await edit.getByRole('button', { name: '清除图片', exact: true }).click();
    await edit.getByRole('button', { name: '保存组织资料', exact: true }).click();
    await expect(edit).not.toBeVisible();
    expect(calls(requests, writePaths.organization).at(-1)?.body).toEqual({ orgId, logoUrl: '' });
    await page.getByRole('button', { name: '下一页', exact: true }).click();
    await expect(page.getByRole('navigation', { name: '分页', exact: true })).toContainText(
      /共 23 条记录\s*第 2 \/ 2 页/,
    );
    expect(calls(requests, '/api/v1/organizations/members').at(-1)?.body?.current).toBe(2);
    await page.getByRole('button', { name: '上一页', exact: true }).click();
    await page.getByRole('button', { name: '更多筛选', exact: true }).click();
    await page.getByLabel('项目 ID', { exact: true }).fill('42');
    await page.getByLabel('姓名 / UID / 完整手机号', { exact: true }).fill('联调成员甲');
    await page.getByRole('button', { name: '查询', exact: true }).click();
    await expect(page.getByRole('navigation', { name: '分页', exact: true })).toContainText(
      /共 1 条记录\s*第 1 \/ 1 页/,
    );
    expect(calls(requests, '/api/v1/organizations/members').at(-1)?.body).toEqual({
      orgId,
      current: 1,
      size: 20,
      projectId: 42,
      keyword: '联调成员甲',
    });
    const row = page.getByRole('row').filter({ hasText: '联调成员甲' });
    await row.getByRole('button', { name: '编辑成员', exact: true }).click();
    const memberEdit = page.getByRole('dialog', { name: '编辑组织成员', exact: true });
    await memberEdit.getByLabel('人员属性', { exact: true }).selectOption('PART_TIME');
    state.memberUpdateStatus = 409;
    await memberEdit.getByRole('button', { name: '保存成员资料', exact: true }).click();
    await expect(memberEdit.getByText('成员版本冲突', { exact: true })).toBeVisible();
    expect(calls(requests, writePaths.member)).toHaveLength(1);
    expect(calls(requests, writePaths.member)[0].body).toEqual({
      orgId,
      memberId: uuid(1003),
      versionNo: 4,
      employmentType: 'PART_TIME',
    });
    await memberEdit.getByRole('button', { name: '取消', exact: true }).click();
    state.members[2].versionNo = 5;
    state.memberUpdateStatus = 200;
    await page.getByRole('button', { name: '刷新人员', exact: true }).click();
    await expect(page.getByRole('button', { name: '刷新人员', exact: true })).toBeEnabled();
    await row.getByRole('button', { name: '编辑成员', exact: true }).click();
    await memberEdit.getByLabel('人员属性', { exact: true }).selectOption('PART_TIME');
    await memberEdit.getByRole('button', { name: '保存成员资料', exact: true }).click();
    await expect(memberEdit).not.toBeVisible();
    await expect(row.getByText('兼职', { exact: true })).toBeVisible();
    expect(calls(requests, writePaths.member)).toHaveLength(2);
    expect(calls(requests, writePaths.member).at(-1)?.body?.versionNo).toBe(5);
    state.departureStatus = 503;
    const removal = page.getByRole('dialog', { name: '移出组织', exact: true });
    for (const count of [1, 2]) {
      await row.getByRole('button', { name: '移出组织', exact: true }).click();
      await removal.getByLabel(/^拟离职日期（上海）\s*\*?\s*$/).fill('2099-01-01');
      await removal.getByLabel(/^退出原因\s*\*?\s*$/).fill('组织工作安排调整');
      await removal.getByRole('button', { name: '确认移出组织', exact: true }).click();
      await expect(removal.getByText('组织退出服务暂不可用', { exact: true })).toBeVisible();
      expect(calls(requests, writePaths.departure)).toHaveLength(count);
      if (count === 1) await removal.getByRole('button', { name: '取消', exact: true }).click();
    }
    const departures = calls(requests, writePaths.departure);
    expect(departures[0].headers['idempotency-key']).toBe(departures[1].headers['idempotency-key']);
    await removal.getByLabel(/^退出原因\s*\*?\s*$/).fill('组织工作安排调整后续说明');
    await removal.getByRole('button', { name: '确认移出组织', exact: true }).click();
    await expect(removal.getByText('组织退出服务暂不可用', { exact: true })).toBeVisible();
    await expect.poll(() => calls(requests, writePaths.departure).length).toBe(3);
    expect(calls(requests, writePaths.departure)[2].headers['idempotency-key']).not.toBe(
      departures[1].headers['idempotency-key'],
    );
    await removal.getByRole('button', { name: '取消', exact: true }).click();
    await row.getByRole('button', { name: '变更角色', exact: true }).click();
    const role = page.getByRole('dialog', { name: '变更组织角色', exact: true });
    await role.getByLabel(/^组织角色\s*\*?\s*$/).selectOption('OWNER');
    await expect(role.getByText(/已有待审批事项不会自动转派/)).toBeVisible();
    await role.getByRole('button', { name: '确认转让主管', exact: true }).click();
    expect(calls(requests, writePaths.role)).toHaveLength(0);
    await role.getByRole('checkbox', { name: '我确认将主管转让给该成员', exact: true }).check();
    await role.getByRole('button', { name: '确认转让主管', exact: true }).click();
    await expect(role).not.toBeVisible();
    await expect(page.getByRole('button', { name: '编辑组织资料', exact: true })).toHaveCount(0);
    expect(calls(requests, writePaths.role)).toHaveLength(1);
    expect(calls(requests, writePaths.role)[0].body).toEqual({
      orgId,
      memberId: uuid(1003),
      position: 'OWNER',
    });
    expect(
      requests.every((request) => request.authenticated && !request.headers.authorization),
    ).toBe(true);
  });

  test(`组织管理 ${mode} 审批双版本、拒绝必填与403/409不重放`, async ({ page }) => {
    const { state, requests } = await organizationBackend(page, origin);
    await openOrganization(page, origin, desktop);
    await page.getByRole('tab', { name: '审批中心', exact: true }).click();
    const first = page.getByRole('article').filter({ hasText: '联调退出申请1' });
    await first.getByRole('button', { name: '同意通过', exact: true }).click();
    const approval = page.getByRole('dialog', { name: '确认通过退出申请', exact: true });
    state.approvalStatus = 403;
    await approval.getByRole('button', { name: '确认通过', exact: true }).click();
    await expect(approval.getByText('当前账户无权审批', { exact: true })).toBeVisible();
    expect(calls(requests, writePaths.approval)).toHaveLength(1);
    await approval.getByRole('button', { name: '取消', exact: true }).click();
    await page.getByRole('radio', { name: '审批记录', exact: true }).check();
    await page.getByLabel('处理开始日期', { exact: true }).fill('2026-02-01');
    await page.getByLabel('处理结束日期', { exact: true }).fill('2026-01-01');
    await expect(page.getByText('开始日期不能晚于结束日期', { exact: true })).toBeVisible();
    await page.getByRole('radio', { name: '待审批', exact: true }).check();
    await expect(first).toBeVisible();
    await expect(page.getByRole('button', { name: '刷新审批列表', exact: true })).toBeEnabled();
    state.approvalStatus = 409;
    await first.getByRole('button', { name: '同意通过', exact: true }).click();
    await approval.getByRole('button', { name: '确认通过', exact: true }).click();
    await expect(approval).not.toBeVisible();
    await expect(page.getByText('审批版本冲突', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '刷新审批列表', exact: true })).toBeEnabled();
    expect(calls(requests, writePaths.approval)).toHaveLength(2);
    state.approvalStatus = 200;
    await first.getByRole('button', { name: '同意通过', exact: true }).click();
    await approval.getByRole('button', { name: '确认通过', exact: true }).click();
    await expect(approval).not.toBeVisible();
    await expect(first).toHaveCount(0);
    expect(calls(requests, writePaths.approval).at(-1)?.body).toEqual({
      orgId,
      flowNo: approvalFixture(1).flowNo,
      nodeId: uuid(2001),
      nodeVersionNo: 4,
      flowVersionNo: 8,
      action: 'APPROVE',
    });
    await page
      .getByRole('article')
      .filter({ hasText: '联调退出申请2' })
      .getByRole('button', { name: '驳回请求', exact: true })
      .click();
    const reject = page.getByRole('dialog', { name: '驳回退出申请', exact: true });
    await reject.getByRole('button', { name: '确认驳回', exact: true }).click();
    await expect(reject.getByText('驳回时请填写审批意见', { exact: true })).toBeVisible();
    expect(calls(requests, writePaths.approval)).toHaveLength(3);
    await reject.getByLabel(/^审批意见\s*\*?\s*$/).fill('  请先完成工作交接  ');
    await reject.getByRole('button', { name: '确认驳回', exact: true }).click();
    await expect(reject).not.toBeVisible();
    await expect(page.getByText('暂无待审批事项', { exact: true })).toBeVisible();
    expect(calls(requests, writePaths.approval)).toHaveLength(4);
    expect(calls(requests, writePaths.approval).at(-1)?.body).toEqual({
      orgId,
      flowNo: approvalFixture(2).flowNo,
      nodeId: uuid(2002),
      nodeVersionNo: 4,
      flowVersionNo: 8,
      action: 'REJECT',
      actionComment: '请先完成工作交接',
    });
    await page.getByRole('radio', { name: '审批记录', exact: true }).check();
    await page.getByLabel('处理状态', { exact: true }).selectOption('REJECTED');
    await page.getByLabel('处理开始日期', { exact: true }).fill('2026-01-01');
    await page.getByLabel('处理结束日期', { exact: true }).fill('2026-01-31');
    await expect(page.getByText('审批意见：请先完成工作交接', { exact: true })).toBeVisible();
    await expect
      .poll(() => calls(requests, '/api/v1/organizations/approvals/records').at(-1)?.body)
      .toEqual({
        orgId,
        businessType: 'ORG_MEMBER_EXIT',
        current: 1,
        size: 10,
        status: 'REJECTED',
        startAt: '2026-01-01 00:00:00',
        endAt: '2026-01-31 23:59:59',
      });
  });

  test(`组织管理 ${mode} 导入完整行错误、稳定幂等草稿、文件表单和模板下载`, async ({ page }) => {
    const { state, requests } = await organizationBackend(page, origin);
    await openOrganization(page, origin, desktop);
    await page.getByRole('button', { name: '批量导入成员', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '批量导入成员', exact: true });
    const pendingDownload = page.waitForEvent('download');
    await dialog.getByRole('button', { name: '下载中文模板', exact: true }).click();
    const download = await pendingDownload;
    expect(download.suggestedFilename()).toBe('成员导入模板.xlsx');
    expect(await readFile((await download.path())!)).toEqual(templateBytes);
    const name = importCell(dialog, 1, '姓名');
    const phone = importCell(dialog, 1, '手机号');
    await name.fill('导入联调成员');
    await phone.fill('13800009001');
    await selectImportCell(dialog, 1, '人员属性', '全职');
    await selectImportCell(dialog, 1, '组织角色', '管理员');
    await selectImportCell(dialog, 1, '组织角色', '成员');
    await dialog.getByRole('button', { name: '确认导入', exact: true }).click();
    await expect(
      dialog
        .getByRole('region', { name: '逐行导入错误', exact: true })
        .getByText(/第 1 行.*手机号格式不正确/),
    ).toBeVisible();
    await expect(name).toHaveValue('导入联调成员');
    await expect(phone).toHaveValue('13800009001');
    await expect(phone).toHaveAttribute('aria-invalid', 'true');
    await expect(
      dialog.getByText('总数 1 · 有效 0 · 无效 1 · 已导入 0', { exact: true }),
    ).toBeVisible();
    expect(calls(requests, writePaths.import)).toHaveLength(1);
    const invalidKey = calls(requests, writePaths.import)[0].headers['idempotency-key'];
    await phone.fill('13800009002');
    state.importMode = 'network';
    for (const count of [2, 3]) {
      await dialog.getByRole('button', { name: '确认导入', exact: true }).click();
      await expect.poll(() => calls(requests, writePaths.import).length).toBe(count);
      await expect(
        dialog.getByText('连接服务失败，请检查网络后重试', { exact: true }),
      ).toBeVisible();
      expect(calls(requests, writePaths.import)).toHaveLength(count);
    }
    const networkCalls = calls(requests, writePaths.import).slice(1);
    expect(networkCalls[0].headers['idempotency-key']).toBeTruthy();
    expect(networkCalls[0].headers['idempotency-key']).not.toBe(invalidKey);
    expect(networkCalls[0].headers['idempotency-key']).toBe(
      networkCalls[1].headers['idempotency-key'],
    );
    await selectImportCell(dialog, 1, '人员属性', '兼职');
    state.importMode = 'success';
    await dialog.getByRole('button', { name: '确认导入', exact: true }).click();
    await expect(dialog.getByText(/已成功导入 1 位成员。新建账号首次成功登录后激活/)).toBeVisible();
    await expect(name).toHaveValue('');
    const textCall = calls(requests, writePaths.import).at(-1)!;
    expect(textCall.form).toEqual({ orgId, memberText: '导入联调成员,13800009002,兼职,成员' });
    expect(textCall.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
    expect(textCall.headers['idempotency-key']).not.toBe(
      networkCalls[1].headers['idempotency-key'],
    );
    await dialog.getByRole('radio', { name: '上传表格', exact: true }).check();
    await dialog.locator('#organization-import-file').setInputFiles({
      name: 'members.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('导入联调成员,13800009002,全职,成员\n'),
    });
    await dialog.getByRole('button', { name: '确认导入', exact: true }).click();
    await expect(
      dialog
        .getByRole('region', { name: '成员导入结果', exact: true })
        .getByText(/^来源：CSV 表格/),
    ).toBeVisible();
    const fileCall = calls(requests, writePaths.import).at(-1)!;
    expect(fileCall.fileName).toBe('members.csv');
    expect(fileCall.form.orgId).toBe(orgId);
    expect(fileCall.form.csvFile).toContain('导入联调成员,13800009002,全职,成员');
    expect(fileCall.form.memberText).toBeUndefined();
    expect(calls(requests, writePaths.import)).toHaveLength(5);
    expect(requests.some((request) => request.path.includes('/files/'))).toBe(false);
  });
}

test('组织管理 ADMIN权限、MEMBER只读摘要和本人退出，不请求越权列表', async ({ page }) => {
  const origin = 'http://127.0.0.1:5176';
  const { state, requests } = await organizationBackend(page, origin, 'ADMIN');
  await page.goto(`${origin}/#/`);
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('link', { name: '组织管理', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: '组织管理', exact: true })).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: '联调成员甲' })).toBeVisible();
  await expect(page.getByRole('button', { name: '编辑组织资料', exact: true })).toHaveCount(0);
  const owner = page.getByRole('row').filter({ hasText: '测试主管' });
  await expect(owner.getByRole('button')).toHaveCount(0);
  const own = page.getByRole('row').filter({ hasText: '联调管理员' });
  await expect(own.getByRole('button', { name: '变更角色', exact: true })).toBeVisible();
  await page
    .getByRole('row')
    .filter({ hasText: '联调成员甲' })
    .getByRole('button', { name: '变更角色', exact: true })
    .click();
  const role = page.getByRole('dialog', { name: '变更组织角色', exact: true });
  await expect(role.getByRole('option', { name: '主管（转让）', exact: true })).toHaveCount(0);
  await role.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('tab', { name: '审批中心', exact: true }).click();
  await expect(page.getByRole('heading', { name: '联调退出申请1', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '同意通过', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '驳回请求', exact: true })).toHaveCount(0);
  state.user.id = uuid(3);
  state.user.organization = { ...state.organization, position: 'MEMBER', joinStatus: 'ACTIVE' };
  const before = requests.length;
  await page.goto(`${origin}/#/`);
  await page.reload();
  await expect(
    page
      .getByRole('navigation', { name: '主导航' })
      .getByRole('link', { name: '我的组织', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('link', { name: '我的组织', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: '我的组织', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '账户菜单', exact: true }).click();
  await page
    .getByRole('navigation', { name: '账户选项' })
    .getByRole('link', { name: '我的组织', exact: true })
    .click();
  await expect(page.getByRole('tablist', { name: '组织管理内容', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '批量导入成员', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '申请退出组织', exact: true }).click();
  const departure = page.getByRole('dialog', { name: '申请退出组织', exact: true });
  await departure.getByLabel(/^拟离职日期\s*\*?\s*$/).fill('2099-01-01');
  await departure.getByLabel(/^退出原因\s*\*?\s*$/).fill('本人工作安排调整');
  await departure.getByRole('button', { name: '提交退出申请', exact: true }).click();
  await expect(departure).not.toBeVisible();
  await expect(
    page.getByText('退出申请正在审批中，请等待组织主管处理。', { exact: true }),
  ).toBeVisible();
  expect(calls(requests, writePaths.departure)).toHaveLength(1);
  expect(calls(requests, writePaths.departure)[0].body).toEqual({
    orgId,
    reason: '本人工作安排调整',
    plannedLeaveDate: '2099-01-01',
  });
  expect(calls(requests, writePaths.departure)[0].headers['idempotency-key']).toBeTruthy();
  expect(
    requests
      .slice(before)
      .filter(
        (request) =>
          request.path.startsWith('/api/v1/organizations') && request.path !== writePaths.departure,
      ),
  ).toHaveLength(0);
});

/** 高级条件折叠后保留真实筛选状态，重置同时清空草稿与请求参数。 */
test('组织管理紧凑工具栏、高级筛选与桌面移动布局', async ({ page }) => {
  const origin = 'http://127.0.0.1:5176';
  const { requests } = await organizationBackend(page, origin);
  await page.setViewportSize({ width: 1280, height: 800 });
  await openOrganization(page, origin);
  const moreFilters = page.getByRole('button', { name: '更多筛选', exact: true });
  const project = page.getByLabel('项目 ID', { exact: true });
  const joinedStart = page.getByLabel('入组日期起', { exact: true });
  const joinedEnd = page.getByLabel('入组日期止', { exact: true });
  const employment = page.getByLabel('人员属性', { exact: true });
  const noOverflow = async () =>
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
  await expect(moreFilters).toHaveAttribute('aria-expanded', 'false');
  await expect(project).not.toBeVisible();
  await expect(joinedStart).not.toBeVisible();
  await expect(employment).not.toBeVisible();
  await noOverflow();

  await moreFilters.click();
  await expect(moreFilters).toHaveAttribute('aria-expanded', 'true');
  await project.fill('42');
  await joinedStart.fill('2026-01-01');
  await joinedEnd.fill('2026-01-31');
  await employment.selectOption('FULL_TIME');
  await page.getByRole('button', { name: '查询', exact: true }).click();
  await expect
    .poll(() => calls(requests, '/api/v1/organizations/members').at(-1)?.body)
    .toEqual({
      orgId,
      current: 1,
      size: 20,
      projectId: 42,
      joinedStartDate: '2026-01-01',
      joinedEndDate: '2026-01-31',
      employmentType: 'FULL_TIME',
    });
  await expect(page.getByText('已应用 4 项筛选', { exact: true })).toBeVisible();
  await moreFilters.click();
  await expect(project).not.toBeVisible();
  await expect(page.getByText('已应用 4 项筛选', { exact: true })).toBeVisible();
  await noOverflow();
  await page.screenshot({ path: 'artifacts/organization-ui-desktop.png' });

  await page.getByRole('button', { name: '重置筛选', exact: true }).click();
  await expect(page.getByText('显示全部成员', { exact: true })).toBeVisible();
  await expect(page.getByText('23 人', { exact: true })).toBeVisible();
  const beforeRefresh = calls(requests, '/api/v1/organizations/members').length;
  await page.getByRole('button', { name: '刷新人员', exact: true }).click();
  await expect
    .poll(() => calls(requests, '/api/v1/organizations/members').length)
    .toBeGreaterThan(beforeRefresh);
  expect(calls(requests, '/api/v1/organizations/members').at(-1)?.body).toEqual({
    orgId,
    current: 1,
    size: 20,
  });
  await page.setViewportSize({ width: 375, height: 812 });
  await noOverflow();
  await moreFilters.click();
  await expect(project).toHaveValue('');
  await expect(joinedStart).toHaveValue('');
  await expect(joinedEnd).toHaveValue('');
  await expect(employment).toHaveValue('');
  await noOverflow();
  await moreFilters.click();
  await expect(moreFilters).toHaveAttribute('aria-expanded', 'false');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: 'artifacts/organization-ui-mobile.png' });
});

test('组织管理375px列表与弹窗不撑出页面，无组织不查询组织接口', async ({ page }) => {
  const origin = 'http://127.0.0.1:5176';
  const { state, requests } = await organizationBackend(page, origin);
  await page.setViewportSize({ width: 375, height: 812 });
  await openOrganization(page, origin);
  const noOverflow = async () =>
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
  await noOverflow();
  await page.getByRole('button', { name: '编辑组织资料', exact: true }).click();
  await noOverflow();
  await page
    .getByRole('dialog', { name: '编辑组织资料', exact: true })
    .getByRole('button', { name: '取消', exact: true })
    .click();
  await page.getByRole('tab', { name: '审批中心', exact: true }).click();
  await expect(page.getByRole('heading', { name: '联调退出申请1', exact: true })).toBeVisible();
  await noOverflow();
  await page.getByRole('button', { name: '批量导入成员', exact: true }).click();
  await noOverflow();
  await page
    .getByRole('dialog', { name: '批量导入成员', exact: true })
    .getByRole('button', { name: '关闭', exact: true })
    .click();
  state.user.organization = null;
  const before = requests.length;
  await page.goto(`${origin}/#/`);
  await page.reload();
  await expect(
    page
      .getByRole('navigation', { name: '主导航' })
      .getByRole('link', { name: '我的组织', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('link', { name: '我的组织', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: '还没有组织', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: '创建组织', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '账户菜单', exact: true }).click();
  await page
    .getByRole('navigation', { name: '账户选项' })
    .getByRole('link', { name: '我的组织', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: '还没有组织', exact: true })).toBeVisible();
  await noOverflow();
  await page.setViewportSize({ width: 320, height: 740 });
  await noOverflow();
  expect(
    requests.slice(before).some((request) => request.path.startsWith('/api/v1/organizations')),
  ).toBe(false);
});

test('组织 Logo 本地预览在保存时上传，资料失败重试复用凭证，清除提交空值', async ({ page }) => {
  const origin = 'http://127.0.0.1:5176';
  const { state, requests } = await organizationBackend(page, origin);
  await page.setViewportSize({ width: 375, height: 812 });
  await openOrganization(page, origin);
  await page.getByRole('button', { name: '编辑组织资料', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '编辑组织资料', exact: true });
  const logo = dialog.getByRole('region', { name: '组织 Logo', exact: true });
  const input = logo.getByLabel('选择组织 Logo 图片', { exact: true });
  await expect(input).toHaveClass(/sr-only/);
  await expect(logo.getByRole('button', { name: '使用图片链接', exact: true })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  const choosing = page.waitForEvent('filechooser');
  await logo.getByText('上传图片', { exact: true }).click();
  await (
    await choosing
  ).setFiles({ name: logoReceipt.fileName, mimeType: 'image/png', buffer: logoBytes });
  const preview = logo.getByRole('img', { name: '组织 Logo 预览', exact: true });
  await expect(preview).toHaveAttribute('src', /^blob:/);
  const previewUrl = (await preview.getAttribute('src'))!;
  expect(calls(requests, '/api/v1/files/upload')).toHaveLength(0);
  expect(calls(requests, writePaths.organization)).toHaveLength(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
  await page.screenshot({ path: 'artifacts/organization-logo-edit-mobile.png', fullPage: false });
  state.organizationUpdateStatus = 503;
  await dialog.getByRole('button', { name: '保存组织资料', exact: true }).click();
  await expect(dialog.getByText('组织资料服务暂不可用', { exact: true })).toBeVisible();
  await expect(preview).toHaveAttribute('src', previewUrl);
  expect(calls(requests, '/api/v1/files/upload')).toHaveLength(1);
  const upload = calls(requests, '/api/v1/files/upload')[0]!;
  expect(upload.form).toMatchObject({ bizType: 'ORG_LOGO', category: 'IMAGE' });
  expect(upload.fileName).toBe(logoReceipt.fileName);
  expect(upload.authenticated).toBe(true);
  expect(upload.headers['x-tyde-client']).toBe('web');
  expect(upload.headers.authorization).toBeUndefined();
  expect(calls(requests, writePaths.organization)[0]?.body).toEqual({
    orgId,
    logoUrl: logoReceipt.objectKey,
    logoUploadToken: logoReceipt.uploadToken,
  });
  state.organizationUpdateStatus = 200;
  await dialog.getByRole('button', { name: '保存组织资料', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(calls(requests, '/api/v1/files/upload')).toHaveLength(1);
  expect(calls(requests, writePaths.organization)).toHaveLength(2);
  expect(calls(requests, writePaths.organization)[1]?.body).toEqual(
    calls(requests, writePaths.organization)[0]?.body,
  );
  expect(state.organization.logoUrl).toBe(logoReceipt.url);
  await page.getByRole('button', { name: '编辑组织资料', exact: true }).click();
  await logo.getByRole('button', { name: '清除图片', exact: true }).click();
  await dialog.getByRole('button', { name: '保存组织资料', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(calls(requests, writePaths.organization).at(-1)?.body).toEqual({ orgId, logoUrl: '' });
  expect(calls(requests, '/api/v1/files/upload')).toHaveLength(1);
});

test('组织 Logo 不支持的类型、空文件及超限图片本地拦截，取消不上传', async ({ page }) => {
  const origin = 'http://127.0.0.1:5176';
  const { requests } = await organizationBackend(page, origin);
  await openOrganization(page, origin);
  await page.getByRole('button', { name: '编辑组织资料', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '编辑组织资料', exact: true });
  const logo = dialog.getByRole('region', { name: '组织 Logo', exact: true });
  const input = logo.getByLabel('选择组织 Logo 图片', { exact: true });
  for (const file of [
    {
      name: 'invalid.svg',
      mimeType: 'image/svg+xml',
      buffer: Buffer.from('<svg/>'),
      message: '请选择非空的 JPG、PNG、GIF、BMP 或 WebP 图片',
    },
    {
      name: 'empty.png',
      mimeType: 'image/png',
      buffer: Buffer.alloc(0),
      message: '请选择非空的 JPG、PNG、GIF、BMP 或 WebP 图片',
    },
    {
      name: 'too-large.png',
      mimeType: 'image/png',
      buffer: Buffer.alloc(10 * 1024 * 1024 + 1),
      message: 'Logo 图片最大 10 MiB',
    },
  ]) {
    await input.setInputFiles(file);
    await expect(logo.getByText(file.message, { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: '保存组织资料', exact: true }).click();
    await expect(dialog.getByRole('button', { name: '保存组织资料', exact: true })).toBeEnabled();
    expect(calls(requests, '/api/v1/files/upload')).toHaveLength(0);
    expect(calls(requests, writePaths.organization)).toHaveLength(0);
    await logo.getByRole('button', { name: '清除图片', exact: true }).click();
    await expect(dialog.getByText(file.message, { exact: true })).toHaveCount(0);
  }
  await input.setInputFiles({
    name: logoReceipt.fileName,
    mimeType: 'image/png',
    buffer: logoBytes,
  });
  await expect(logo.getByRole('img', { name: '组织 Logo 预览', exact: true })).toHaveAttribute(
    'src',
    /^blob:/,
  );
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  expect(calls(requests, '/api/v1/files/upload')).toHaveLength(0);
  expect(calls(requests, writePaths.organization)).toHaveLength(0);
});

test('组织导入表格从Excel粘贴表头与多行，逐格修改增删并在错误行保留草稿', async ({ page }) => {
  const origin = 'http://127.0.0.1:5176';
  const { state, requests } = await organizationBackend(page, origin);
  state.importErrorRow = 2;
  await page.setViewportSize({ width: 1280, height: 900 });
  await openOrganization(page, origin);
  await page.getByRole('button', { name: '批量导入成员', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '批量导入成员', exact: true });
  const grid = dialog.getByRole('region', { name: '成员表格编辑区', exact: true });
  await pasteMembers(
    importCell(dialog, 1, '姓名'),
    '\uFEFF 姓名\t手机号\t人员属性\t组织角色\t入组日期\r\n  粘贴成员甲  \t 13800009002 \t 全职 \t 成员 \t 2026-10-01 \r\n粘贴成员乙\t13800009004\t兼职\t管理员\t\r\n',
  );
  await expect(importCell(dialog, 1, '姓名')).toHaveValue('粘贴成员甲');
  await expect(importCell(dialog, 1, '手机号')).toHaveValue('13800009002');
  await expect(importCell(dialog, 2, '姓名')).toHaveValue('粘贴成员乙');
  await expect(importCell(dialog, 2, '组织角色')).toHaveText('管理员');
  await expect(importCell(dialog, 1, '入组日期')).toHaveValue('2026-10-01');
  await dialog.getByRole('button', { name: '确认导入', exact: true }).click();
  await expect(importCell(dialog, 2, '手机号')).toHaveAttribute('aria-invalid', 'true');
  await expect(importCell(dialog, 1, '手机号')).not.toHaveAttribute('aria-invalid', 'true');
  await expect(
    dialog
      .getByRole('region', { name: '逐行导入错误', exact: true })
      .getByText('第 2 行 · 手机号：手机号格式不正确（138****0004）', { exact: true }),
  ).toBeVisible();
  await expect(importCell(dialog, 2, '手机号')).toHaveValue('13800009004');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
  await page.screenshot({ path: 'artifacts/organization-import-table-desktop.png' });
  await importCell(dialog, 2, '姓名').fill('编辑后的成员');
  await importCell(dialog, 2, '手机号').fill('13800009003');
  await pasteMembers(importCell(dialog, 2, '手机号'), '13800009003\t全职\t成员\t2026-10-02');
  await expect(importCell(dialog, 2, '姓名')).toHaveValue('编辑后的成员');
  await expect(importCell(dialog, 2, '入组日期')).toHaveValue('2026-10-02');
  const names = grid.getByLabel(/^第 \d+ 行 姓名$/);
  const beforeAdd = await names.count();
  await dialog.getByRole('button', { name: '添加成员', exact: true }).click();
  await expect(names).toHaveCount(beforeAdd + 1);
  await importCell(dialog, beforeAdd + 1, '姓名').fill('删除前的临时成员');
  await dialog.getByRole('button', { name: `删除第 ${beforeAdd + 1} 行`, exact: true }).click();
  await expect(names).toHaveCount(beforeAdd);
  state.importMode = 'success';
  await dialog.getByRole('button', { name: '确认导入', exact: true }).click();
  await expect(dialog.getByText(/已成功导入 2 位成员/)).toBeVisible();
  expect(calls(requests, writePaths.import)).toHaveLength(2);
  expect(calls(requests, writePaths.import).at(-1)?.form).toEqual({
    orgId,
    memberText:
      '粘贴成员甲,13800009002,全职,成员,2026-10-01\r\n编辑后的成员,13800009003,全职,成员,2026-10-02',
  });
  expect(calls(requests, writePaths.import).at(-1)?.headers['idempotency-key']).not.toBe(
    calls(requests, writePaths.import)[0]?.headers['idempotency-key'],
  );
});

test('组织导入表格拒绝超过500行或5列的整次粘贴，不截断也不覆盖原草稿', async ({ page }) => {
  const origin = 'http://127.0.0.1:5176';
  const { state, requests } = await organizationBackend(page, origin);
  state.importMode = 'success';
  await openOrganization(page, origin);
  await page.getByRole('button', { name: '批量导入成员', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '批量导入成员', exact: true });
  const grid = dialog.getByRole('region', { name: '成员表格编辑区', exact: true });
  await importCell(dialog, 1, '姓名').fill('保留原成员');
  await importCell(dialog, 1, '手机号').fill('13800009002');
  await selectImportCell(dialog, 1, '人员属性', '全职');
  const before = await grid.getByLabel(/^第 \d+ 行 姓名$/).count();
  const tooMany = Array.from(
    { length: 501 },
    (_, index) => `成员${index + 1}\t13800009002\t全职\t成员\t`,
  ).join('\n');
  await pasteMembers(importCell(dialog, 1, '姓名'), tooMany);
  await expect(
    dialog.getByText('单次最多导入 500 个成员，请分批粘贴或导入。', { exact: true }),
  ).toBeVisible();
  await expect(grid.getByLabel(/^第 \d+ 行 姓名$/)).toHaveCount(before);
  await expect(importCell(dialog, 1, '姓名')).toHaveValue('保留原成员');
  expect(calls(requests, writePaths.import)).toHaveLength(0);
  await pasteMembers(importCell(dialog, 1, '姓名'), '一\t二\t三\t四\t五\t六');
  await expect(dialog.getByText(/第 1 行超过 5 列/)).toBeVisible();
  await expect(importCell(dialog, 1, '手机号')).toHaveValue('13800009002');
  expect(calls(requests, writePaths.import)).toHaveLength(0);
  await dialog.getByRole('button', { name: '清空表格', exact: true }).click();
  await expect(importCell(dialog, 1, '姓名')).toHaveValue('');
  await pasteMembers(importCell(dialog, 1, '姓名'), '合法成员\t13800009004\t全职\t成员');
  await dialog.getByRole('button', { name: '确认导入', exact: true }).click();
  await expect(dialog.getByText(/已成功导入 1 位成员/)).toBeVisible();
  expect(calls(requests, writePaths.import)).toHaveLength(1);
  expect(calls(requests, writePaths.import)[0]?.form.memberText).toBe(
    '合法成员,13800009004,全职,成员',
  );
});

test('组织导入375文件区支持选择拖放、替换移除与CSV及Excel文件卡片，非法文件不提交', async ({
  page,
}) => {
  const origin = 'http://127.0.0.1:5176';
  const { state, requests } = await organizationBackend(page, origin);
  state.importMode = 'success';
  await page.setViewportSize({ width: 375, height: 812 });
  await openOrganization(page, origin);
  await page.getByRole('button', { name: '批量导入成员', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '批量导入成员', exact: true });
  await dialog.getByRole('radio', { name: '上传表格', exact: true }).check();
  const input = dialog.locator('#organization-import-file');
  await expect(input).toHaveClass(/sr-only/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
  await page.screenshot({ path: 'artifacts/organization-import-empty-mobile.png' });
  for (const file of [
    { name: 'invalid.txt', mimeType: 'text/plain', buffer: Buffer.from('invalid') },
    {
      name: 'empty.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: Buffer.alloc(0),
    },
  ]) {
    await input.setInputFiles(file);
    await expect(
      dialog.getByText('请选择非空 CSV、XLS 或 XLSX 文件，文件最大 50 MiB', { exact: true }),
    ).toBeVisible();
    expect(calls(requests, writePaths.import)).toHaveLength(0);
  }
  const choosing = page.waitForEvent('filechooser');
  await dialog.getByText('点击选择表格，或拖拽到这里', { exact: true }).click();
  await (
    await choosing
  ).setFiles({
    name: 'members.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('导入联调成员,13800009002,全职,成员'),
  });
  await expect(dialog.getByText('members.csv', { exact: true })).toBeVisible();
  await expect(dialog.getByText('更换表格', { exact: true })).toBeVisible();
  const replacing = page.waitForEvent('filechooser');
  await dialog.getByText('更换表格', { exact: true }).click();
  await (
    await replacing
  ).setFiles({
    name: 'replacement.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('替换后的成员,13800009003,兼职,成员'),
  });
  await expect(dialog.getByText('replacement.csv', { exact: true })).toBeVisible();
  await expect(dialog.getByText('members.csv', { exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: '移除表格', exact: true }).click();
  await expect(dialog.getByText('replacement.csv', { exact: true })).toHaveCount(0);
  await expect(dialog.getByText('members.csv', { exact: true })).toHaveCount(0);
  await expect(dialog.getByText('点击选择表格，或拖拽到这里', { exact: true })).toBeVisible();
  for (const [fileName, contentType] of [
    ['members.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['members.xls', 'application/vnd.ms-excel'],
  ] as const) {
    // 只验证选择区与multipart传输，Excel内容解析由服务端测试覆盖。
    await dialog.locator('[data-slot="file-upload-field"]').evaluate(
      (target, file) => {
        const transfer = new DataTransfer();
        transfer.items.add(new File([file.bytes], file.name, { type: file.type }));
        target.dispatchEvent(
          new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }),
        );
      },
      { name: fileName, type: contentType, bytes: 'spreadsheet-transport-fixture' },
    );
    await expect(dialog.getByText(fileName, { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
    if (fileName.endsWith('.xlsx'))
      await page.screenshot({ path: 'artifacts/organization-import-file-mobile.png' });
    await dialog.getByRole('button', { name: '确认导入', exact: true }).click();
    await expect(
      dialog
        .getByRole('region', { name: '成员导入结果', exact: true })
        .getByText(/^来源：Excel 表格/),
    ).toBeVisible();
    expect(calls(requests, writePaths.import).at(-1)?.fileName).toBe(fileName);
    expect(calls(requests, writePaths.import).at(-1)?.form.memberText).toBeUndefined();
    expect(calls(requests, writePaths.import).at(-1)?.form.orgId).toBe(orgId);
  }
  expect(calls(requests, writePaths.import)).toHaveLength(2);
  expect(requests.some((request) => request.path.includes('/files/'))).toBe(false);
});

test('组织导入手机号真实键盘限制11位数字，单格及整表非法粘贴整次拒绝保留草稿', async ({ page }) => {
  const origin = 'http://127.0.0.1:5176';
  const { requests } = await organizationBackend(page, origin);
  await openOrganization(page, origin);
  await page.getByRole('button', { name: '批量导入成员', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '批量导入成员', exact: true });
  const phone = importCell(dialog, 1, '手机号');
  await expect(phone).toHaveAttribute('maxlength', '11');
  await phone.pressSequentially('88888888888888888888888');
  await expect(phone).toHaveValue('88888888888');
  await phone.fill('');
  await phone.pressSequentially('a1b3c8d00009002!');
  await expect(phone).toHaveValue('13800009002');
  await pasteMembers(
    importCell(dialog, 1, '姓名'),
    '保留成员甲\t13800009002\t全职\t成员\n保留成员乙\t13800009003\t兼职\t管理员',
  );
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  for (const value of ['1380000900299', '1380000900a', '１３８００００９００２']) {
    await page.evaluate((text) => navigator.clipboard.writeText(text), value);
    await phone.selectText();
    await phone.press('ControlOrMeta+V');
    await expect(dialog.getByText('手机号只能填写最多 11 位数字', { exact: true })).toBeVisible();
    await expect(phone).toHaveValue('13800009002');
  }
  await page.evaluate(() => navigator.clipboard.writeText(' 13900009004 '));
  await phone.selectText();
  await phone.press('ControlOrMeta+V');
  await expect(phone).toHaveValue('13900009004');
  await expect(dialog.getByText('手机号只能填写最多 11 位数字', { exact: true })).toHaveCount(0);
  await page.evaluate(() => navigator.clipboard.writeText('5'));
  await phone.press('End');
  await phone.press('ControlOrMeta+V');
  await expect(dialog.getByText('手机号只能填写最多 11 位数字', { exact: true })).toBeVisible();
  await expect(phone).toHaveValue('13900009004');
  const original = await importDraft(dialog);
  for (const [target, text, row] of [
    ['姓名', '覆盖成员甲\t13800009002\t兼职\t管理员\n覆盖成员乙\t1380000900399\t全职\t成员', 2],
    ['姓名', '覆盖成员甲,1380000900a,兼职,管理员\n覆盖成员乙,13800009003,全职,成员', 1],
    ['手机号', '1380000900299\t兼职\t管理员', 1],
    ['手机号', '13900009009\t兼职\t管理员\n1380000900a\t全职\t成员', 2],
  ] as const) {
    await pasteMembers(importCell(dialog, 1, target), text);
    await expect(
      dialog.getByText(`第 ${row} 行手机号只能填写最多 11 位数字`, { exact: true }),
    ).toBeVisible();
    expect(await importDraft(dialog)).toEqual(original);
    expect(calls(requests, writePaths.import)).toHaveLength(0);
  }
});

test('组织导入手机号前缀、必填、短号和同批重复均逐行拦截，改正后才发送一次', async ({ page }) => {
  const origin = 'http://127.0.0.1:5176';
  const { state, requests } = await organizationBackend(page, origin);
  state.importMode = 'success';
  await openOrganization(page, origin);
  await page.getByRole('button', { name: '批量导入成员', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '批量导入成员', exact: true });
  await pasteMembers(
    importCell(dialog, 1, '姓名'),
    '前缀错误\t88888888888\t全职\t成员\n手机号缺失\t\t全职\t成员\n位数不足\t1380000\t兼职\t成员\n重复成员甲\t13800009002\t全职\t成员\n重复成员乙\t13800009002\t兼职\t成员',
  );
  await dialog.getByRole('button', { name: '确认导入', exact: true }).click();
  for (const [row, message] of [
    [1, '请输入 11 位大陆手机号码'],
    [2, '手机号不能为空'],
    [3, '请输入 11 位大陆手机号码'],
    [5, '同一批成员手机号重复'],
  ] as const) {
    await expect(importCell(dialog, row, '手机号')).toHaveAttribute('aria-invalid', 'true');
    await expect(importCell(dialog, row, '手机号')).toHaveAccessibleDescription(message);
  }
  await expect(dialog.getByText('请修正表格中的标记项后再导入', { exact: true })).toBeVisible();
  expect(calls(requests, writePaths.import)).toHaveLength(0);
  await importCell(dialog, 1, '手机号').fill('13900009001');
  await importCell(dialog, 2, '手机号').fill('13900009002');
  await importCell(dialog, 3, '手机号').fill('13900009003');
  await importCell(dialog, 5, '手机号').fill('13900009005');
  await dialog.getByRole('button', { name: '确认导入', exact: true }).click();
  await expect(dialog.getByText(/已成功导入 5 位成员/)).toBeVisible();
  expect(calls(requests, writePaths.import)).toHaveLength(1);
  expect(calls(requests, writePaths.import)[0]?.form).toEqual({
    orgId,
    memberText:
      '前缀错误,13900009001,全职,成员\r\n手机号缺失,13900009002,全职,成员\r\n位数不足,13900009003,兼职,成员\r\n重复成员甲,13800009002,全职,成员\r\n重复成员乙,13900009005,兼职,成员',
  });
});

test('组织导入人员属性和角色使用公共下拉，原生日期可填写清除且英文表格映射中文', async ({
  page,
}) => {
  const origin = 'http://127.0.0.1:5176';
  const { state, requests } = await organizationBackend(page, origin);
  state.importMode = 'success';
  await openOrganization(page, origin);
  await page.getByRole('button', { name: '批量导入成员', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '批量导入成员', exact: true });
  await importCell(dialog, 1, '姓名').fill('字段联调成员甲');
  await importCell(dialog, 1, '手机号').fill('13900009001');
  await expect(importCell(dialog, 1, '人员属性')).toHaveRole('combobox');
  await expect(importCell(dialog, 1, '人员属性')).toHaveText('请选择');
  await expect(importCell(dialog, 1, '组织角色')).toHaveText('成员');
  await selectImportCell(dialog, 1, '人员属性', '全职');
  await selectImportCell(dialog, 1, '人员属性', '兼职');
  await selectImportCell(dialog, 1, '组织角色', '管理员');
  await selectImportCell(dialog, 1, '组织角色', '成员');
  await selectImportCell(dialog, 1, '组织角色', '管理员');
  const date = importCell(dialog, 1, '入组日期');
  await expect(date).toHaveAttribute('type', 'date');
  await date.fill('2024-02-29');
  await expect(date).toHaveValue('2024-02-29');
  await date.fill('');
  await expect(date).toHaveValue('');
  await date.fill('2026-10-05');
  await dialog.getByRole('button', { name: '添加成员', exact: true }).click();
  await pasteMembers(
    importCell(dialog, 2, '姓名'),
    'English Member Alpha\t13900009002\tFull-time\tMember\t2026-10-06\nEnglish Member Beta\t13900009003\tPart-time\tAdministrator\t',
  );
  await expect(importCell(dialog, 2, '人员属性')).toHaveText('全职');
  await expect(importCell(dialog, 2, '组织角色')).toHaveText('成员');
  await expect(importCell(dialog, 3, '人员属性')).toHaveText('兼职');
  await expect(importCell(dialog, 3, '组织角色')).toHaveText('管理员');
  await expect(importCell(dialog, 2, '入组日期')).toHaveValue('2026-10-06');
  await expect(importCell(dialog, 3, '入组日期')).toHaveValue('');
  expect(calls(requests, writePaths.import)).toHaveLength(0);
  await importCell(dialog, 2, '人员属性').click();
  await expect(dialog.getByRole('option', { name: '全职', exact: true })).toBeVisible();
  await page.screenshot({ path: 'artifacts/organization-import-select-date-desktop.png' });
  await dialog.getByRole('option', { name: '全职', exact: true }).click();
  await page.setViewportSize({ width: 375, height: 812 });
  await importCell(dialog, 3, '组织角色').click();
  await expect(dialog.getByRole('option', { name: '管理员', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
  await page.screenshot({ path: 'artifacts/organization-import-select-mobile.png' });
  await dialog.getByRole('option', { name: '管理员', exact: true }).click();
  await dialog.getByRole('button', { name: '确认导入', exact: true }).click();
  await expect(dialog.getByText(/已成功导入 3 位成员/)).toBeVisible();
  expect(calls(requests, writePaths.import)).toHaveLength(1);
  expect(calls(requests, writePaths.import)[0]?.form).toEqual({
    orgId,
    memberText:
      '字段联调成员甲,13900009001,兼职,管理员,2026-10-05\r\nEnglish Member Alpha,13900009002,全职,成员,2026-10-06\r\nEnglish Member Beta,13900009003,兼职,管理员',
  });
});

test('组织导入姓名、枚举和日期拒绝非法粘贴保稿，必填项逐行提示且改正后才提交', async ({ page }) => {
  const origin = 'http://127.0.0.1:5176';
  const { state, requests } = await organizationBackend(page, origin);
  state.importMode = 'success';
  await openOrganization(page, origin);
  await page.getByRole('button', { name: '批量导入成员', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '批量导入成员', exact: true });
  const name = importCell(dialog, 1, '姓名');
  await name.pressSequentially('A'.repeat(70));
  await expect(name).toHaveValue('A'.repeat(64));
  await pasteMembers(name, '保留姓名\t13900009011\t全职\t成员\t2026-10-01');
  const original = await importDraft(dialog);
  for (const [text, message] of [
    [`${'长'.repeat(65)}\t13900009011\t全职\t成员\t2026-10-01`, '姓名最多填写 64 个字符'],
    ['8非法姓名\t13900009011\t全职\t成员\t2026-10-01', '姓名须以文字开头'],
    ['覆盖姓名\t13900009011\t外包\t成员\t2026-10-01', '人员属性必须填写全职或兼职'],
    ['覆盖姓名\t13900009011\t全职\t主管\t2026-10-01', '组织角色必须填写管理员或成员'],
    ['覆盖姓名\t13900009011\t全职\t成员\t2026-02-30', '入组日期必须为有效的 YYYY-MM-DD 日期'],
    ['覆盖姓名\t13900009011\t全职\t成员\t2026/10/01', '入组日期必须为有效的 YYYY-MM-DD 日期'],
  ] as const) {
    await pasteMembers(name, text);
    await expect(dialog.getByRole('alert')).toContainText(message);
    expect(await importDraft(dialog)).toEqual(original);
    expect(calls(requests, writePaths.import)).toHaveLength(0);
  }
  await name.fill('');
  await dialog.getByRole('button', { name: '添加成员', exact: true }).click();
  await importCell(dialog, 2, '姓名').fill('合法成员乙');
  await importCell(dialog, 2, '手机号').fill('13900009012');
  await dialog.getByRole('button', { name: '确认导入', exact: true }).click();
  await expect(name).toHaveAttribute('aria-invalid', 'true');
  await expect(name).toHaveAccessibleDescription('姓名不能为空');
  await expect(importCell(dialog, 2, '人员属性')).toHaveAttribute('aria-invalid', 'true');
  await expect(importCell(dialog, 2, '人员属性')).toHaveAccessibleDescription(
    '人员属性必须填写全职或兼职',
  );
  await expect(dialog.getByText('请修正表格中的标记项后再导入', { exact: true })).toBeVisible();
  expect(calls(requests, writePaths.import)).toHaveLength(0);
  await page.screenshot({ path: 'artifacts/organization-import-required-fields-desktop.png' });
  await name.fill('合法成员甲');
  await selectImportCell(dialog, 2, '人员属性', '兼职');
  await dialog.getByRole('button', { name: '确认导入', exact: true }).click();
  await expect(dialog.getByText(/已成功导入 2 位成员/)).toBeVisible();
  expect(calls(requests, writePaths.import)).toHaveLength(1);
  expect(calls(requests, writePaths.import)[0]?.form).toEqual({
    orgId,
    memberText: '合法成员甲,13900009011,全职,成员,2026-10-01\r\n合法成员乙,13900009012,兼职',
  });
});
