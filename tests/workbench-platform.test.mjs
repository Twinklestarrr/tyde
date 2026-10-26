import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpAuth } from '../packages/platform/src/web.ts';
import {
  AVATAR_MAX_BYTES,
  AVATAR_ACCEPT,
  ORG_LOGO_MAX_BYTES,
  ORG_LOGO_ACCEPT,
} from '../packages/shared/dist/index.js';

const orgId = '00000000-0000-4000-8000-000000000002';
const userId = '00000000-0000-4000-8000-000000000001';
const applicationId = '00000000-0000-4000-8000-000000000004';
const wallTime = '2026-10-21 09:30:00';
const attendanceApply = {
  orgId,
  attendanceDate: '2026-10-21',
  applicationType: 'LEAVE',
  finalStatus: 'LEAVE',
  reason: '个人安排',
  versionNo: 5,
  dailyId: 12,
  leaveStartAt: wallTime,
  leaveEndAt: '2026-10-21 12:00:00',
};
const attendanceApplied = {
  applicationId,
  flowNo: 'TEST-ATTENDANCE-1',
  flowVersionNo: 0,
  businessType: 'ATTENDANCE_LEAVE',
  applicationType: 'LEAVE',
  attendanceDate: attendanceApply.attendanceDate,
  finalStatus: 'LEAVE',
  status: 'PENDING',
  versionNo: 5,
  dailyId: 12,
  leaveStartAt: wallTime,
  leaveEndAt: attendanceApply.leaveEndAt,
  appliedAt: '2026-10-21T01:00:00.000Z',
  finishedAt: null,
};
const scheduleInput = {
  schedules: [
    { scheduleDate: '2026-10-21', dayType: 'WORK', startTime: '09:00', endTime: '18:00' },
    { scheduleDate: '2026-10-22', dayType: 'REST' },
  ],
  overwrite: false,
  timezone: 'Asia/Shanghai',
  idempotencyKey: 'fixture-personal-schedule-1',
};
const scheduled = {
  batchNo: 'TEST-SCHEDULE-1',
  createdCount: 1,
  updatedCount: 0,
  skippedCount: 1,
  conflicts: [{ scheduleDate: '2026-10-21', scheduleId: 9, versionNo: 3 }],
};
const project = {
  assignmentId: 23,
  projectId: 17,
  projectName: null,
  requesterName: '测试需求方',
  needWrittenExam: true,
  admissionStatus: 'PENDING',
  currentNodeCode: 'ENTRANCE_EXAM',
};
const detail = {
  assignmentId: 23,
  projectDetail: {
    id: 17,
    projectNo: 'P202610210001',
    requesterType: 'INDIVIDUAL',
    requesterId: userId,
    requesterName: '测试需求方',
    projectName: null,
    projectDescription: '项目说明',
    categoryLevel1Id: null,
    categoryLevel2Id: null,
    categoryLevel1Name: null,
    categoryLevel2Name: null,
    categoryLevel3Ids: [],
    categoryLevel3Names: [],
    difficultyLevel: null,
    projectQuantity: 120.5,
    quantityUnit: '条',
    deadline: wallTime,
    requiredHeadcount: null,
    educationRequirement: null,
    employmentType: null,
    experienceRequirement: null,
    workSummary: null,
    specialRequirement: null,
    mandatoryRequirement: null,
    standardContent: null,
    standardLink: null,
    status: 'PUBLISHED',
    currentNodeCode: null,
    versionNo: 2,
    creatorUid: 'TEST10001',
    creatorName: '测试发起人',
    createdAt: wallTime,
    updatedAt: wallTime,
    attachments: [
      {
        id: 1,
        attachmentType: 'OTHER',
        fileName: '说明.txt',
        objectKey: 'project-attachment/fixture.txt',
        extension: 'txt',
        contentType: 'text/plain',
        fileSize: 10,
        fileHash: 'b'.repeat(64),
        sortNo: 1,
        status: 'ACTIVE',
      },
    ],
  },
  productionPlan: {
    hasPlan: true,
    planId: 3,
    operatorHeadcount: 4,
    operatorCpd: 10.5,
    inspectorHeadcount: 1,
    inspectorCpd: null,
    totalExpectedOutput: 120.5,
    crowds: [{ id: null, sequenceNo: 1, crowdName: null, profileRequirement: null }],
    stages: [
      {
        id: 1,
        sequenceNo: 1,
        stageName: null,
        startDate: '2026-10-21',
        endDate: null,
        workdayCount: null,
        workdayCountSource: null,
        operatorHeadcount: null,
        operatorCpd: null,
        accuracyRate: 0.95,
        naturalDayCount: null,
        expectedOutput: null,
      },
    ],
  },
  currentNodeCode: 'PRODUCTION_TASK',
  availableOperations: ['VIEW_DETAIL'],
};
const application = {
  applicationId,
  flowNo: 'TEST-APPLICATION-1',
  flowVersionNo: 7,
  businessType: 'ATTENDANCE_LEAVE',
  businessId: applicationId,
  businessNo: null,
  title: '本人请假',
  applicantOrgId: orgId,
  applicantOrgName: '测试组织',
  applyReason: '个人安排',
  status: 'PENDING',
  currentNode: 1,
  currentNodeCode: 'OWNER_APPROVAL',
  formData: { scheduleDate: '2026-10-21' },
  targetMemberId: null,
  targetMemberName: null,
  plannedLeaveDate: null,
  appliedAt: wallTime,
  finishedAt: null,
};
const page = (records = [application]) => ({
  total: records.length,
  pages: records.length ? 1 : 0,
  current: 1,
  size: 20,
  records,
});
function attendance(organizationId = orgId) {
  const days = Array.from({ length: 31 }, (_, index) => ({
    scheduleDate: `2026-10-${String(index + 1).padStart(2, '0')}`,
    calendarStatus: 'UNSCHEDULED',
    scheduleId: null,
    dayType: null,
    shiftStartAt: null,
    shiftEndAt: null,
    timezone: null,
    sourceType: null,
    batchNo: null,
    status: null,
    versionNo: null,
    dailyId: null,
    autoStatus: null,
    finalStatus: null,
    firstClockInAt: null,
    lastClockOutAt: null,
    reviewRequired: null,
    reviewReason: null,
    manualOverride: null,
    dailyVersionNo: null,
    application: null,
    permissions: {
      canApplyLeave: false,
      canApplyCorrection: false,
      canWithdraw: false,
      canDirectUpdate: false,
    },
  }));
  days[20] = {
    ...days[20],
    calendarStatus: 'PENDING_ATTENDANCE',
    scheduleId: 9,
    dayType: 'WORK',
    shiftStartAt: wallTime,
    shiftEndAt: '2026-10-21 18:00:00',
    timezone: 'Asia/Shanghai',
    sourceType: 'MANUAL',
    batchNo: 'fixture-batch',
    status: 'ACTIVE',
    versionNo: 3,
    dailyId: 12,
    dailyVersionNo: 5,
    firstClockInAt: '2026-10-21 09:30:00.123',
    application: {
      applicationId,
      flowNo: 'TEST-APPLICATION-1',
      flowVersionNo: 7,
      applicationType: 'LEAVE',
      status: 'PENDING',
      finalStatus: 'LEAVE',
      canWithdraw: true,
    },
  };
  return {
    organizationId,
    independentSchedule: organizationId === null,
    month: '2026-10',
    memberId: organizationId ? '00000000-0000-4000-8000-000000000003' : null,
    userId,
    realName: null,
    nickname: '测试成员',
    summary: { presentCount: 1, lateCount: 2, earlyLeaveCount: 3, leaveCount: 4, absentCount: 5 },
    days,
    permissions: {
      canBatchSchedule: organizationId === null,
      canDirectUpdate: false,
      canApply: true,
      canWithdraw: true,
    },
  };
}
const holidays = {
  month: '2026-10',
  days: [
    {
      date: '2026-10-01',
      dayOfWeek: 4,
      weekName: '星期四',
      calendarDayType: 'PUBLIC_HOLIDAY',
      holidayName: '国庆节',
      defaultScheduleDayType: 'REST',
    },
  ],
};
const tokens = {
  accessToken: 'a'.repeat(43),
  refreshToken: 'r'.repeat(43),
  tokenType: 'Bearer',
  expiresIn: 1800,
};
const avatarResult = (file) => ({
  objectKey: 'avatar/2026/10/21/0123456789abcdef0123456789abcdef.png',
  uploadToken: 'u'.repeat(43),
  url: null,
  sensitive: false,
  fileName: file.name,
  extension: 'png',
  size: file.size,
  contentType: 'image/png',
  fileHash: 'c'.repeat(64),
});
const logoResult = (file) => ({
  ...avatarResult(file),
  objectKey: 'org-logo/2026/10/23/0123456789abcdef0123456789abcdef.png',
  url: 'https://images.example.test/logo.png',
});
const result = (data, status = 200) =>
  new Response(
    JSON.stringify({ code: status, message: status === 200 ? '操作成功' : '真实服务端错误', data }),
    { status, headers: { 'Content-Type': 'application/json' } },
  );
function adapter(t, desktop, responder) {
  const original = globalThis.fetch;
  const calls = [];
  const origin = desktop ? 'https://api.example.test' : '';
  globalThis.fetch = async (url, options) => {
    const call = {
      url,
      path: url.slice(origin.length),
      ...options,
      data:
        options.body instanceof FormData
          ? options.body
          : options.body
            ? JSON.parse(options.body)
            : undefined,
    };
    calls.push(call);
    return responder(call);
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return { api: createHttpAuth(async () => origin, desktop ? 'include' : 'same-origin'), calls };
}
function deferred() {
  let resolve;
  const promise = new Promise((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

for (const desktop of [false, true]) {
  const mode = desktop ? 'Electron renderer' : 'Web';
  test(`${mode} personal attendance writes preserve scope, independent versions and schedule idempotency`, async (t) => {
    const corrected = {
      ...attendanceApplied,
      businessType: 'ATTENDANCE_CORRECTION',
      applicationType: 'CORRECTION',
      finalStatus: 'PRESENT',
      versionNo: null,
      dailyId: null,
      leaveStartAt: null,
      leaveEndAt: null,
    };
    const withdrawn = {
      ...attendanceApplied,
      status: 'WITHDRAWN',
      flowVersionNo: 8,
      finishedAt: '2026-10-21T02:00:00.000Z',
    };
    const updateInput = {
      orgId,
      dailyId: 12,
      finalStatus: 'PRESENT',
      manualRemark: ' 核对出勤 ',
      versionNo: 5,
    };
    const updated = {
      id: 12,
      beforeStatus: null,
      finalStatus: 'PRESENT',
      manualOverride: true,
      manualRemark: '核对出勤',
      correctedBy: 'TEST10001',
      correctedAt: wallTime,
      versionNo: 6,
      adjustmentId: 10,
    };
    const { api, calls } = adapter(t, desktop, ({ path, data }) => {
      if (path.endsWith('/schedules/batch')) return result(scheduled);
      if (path.endsWith('/attendance/apply'))
        return result(data.applicationType === 'LEAVE' ? attendanceApplied : corrected);
      if (path.endsWith('/attendance/withdraw')) return result(withdrawn);
      if (path.endsWith('/attendance/update')) return result(updated);
      throw new Error(`Unexpected endpoint ${path}`);
    });
    assert.deepEqual(await api.batchMySchedules(scheduleInput), scheduled);
    assert.deepEqual(await api.applyMyAttendance(attendanceApply), attendanceApplied);
    const correction = {
      orgId,
      attendanceDate: attendanceApply.attendanceDate,
      applicationType: 'CORRECTION',
      finalStatus: 'PRESENT',
      reason: '核对出勤',
      versionNo: null,
    };
    assert.deepEqual(await api.applyMyAttendance(correction), corrected);
    const withdrawal = { applicationId, flowVersionNo: 7 };
    assert.deepEqual(await api.withdrawMyAttendance(withdrawal), withdrawn);
    assert.deepEqual(await api.updateMyAttendance(updateInput), updated);
    assert.deepEqual(
      calls.map(({ path, method }) => [path, method]),
      [
        ['/api/v1/users/me/schedules/batch', 'PUT'],
        ['/api/v1/organizations/attendance/apply', 'POST'],
        ['/api/v1/organizations/attendance/apply', 'POST'],
        ['/api/v1/organizations/attendance/withdraw', 'POST'],
        ['/api/v1/organizations/attendance/update', 'POST'],
      ],
    );
    const { idempotencyKey, ...body } = scheduleInput;
    assert.deepEqual(calls[0].data, body);
    assert.equal(calls[0].headers['Idempotency-Key'], idempotencyKey);
    assert.deepEqual(calls[1].data, attendanceApply);
    assert.deepEqual(calls[2].data, correction);
    assert.deepEqual(calls[3].data, withdrawal);
    assert.deepEqual(calls[4].data, updateInput);
    assert.ok(
      calls.every(
        ({ credentials, headers }) =>
          credentials === (desktop ? 'include' : 'same-origin') &&
          headers['X-Tyde-Client'] === 'web' &&
          headers.Authorization === undefined,
      ),
    );
  });

  test(`${mode} attendance write failures do not replay requests and retain server conflicts`, async (t) => {
    let networkFailure = false;
    const { api, calls } = adapter(t, desktop, () => {
      if (networkFailure) throw new TypeError('fixture network unavailable');
      return result(null, 409);
    });
    const operations = [
      () => api.batchMySchedules(scheduleInput),
      () => api.applyMyAttendance(attendanceApply),
      () => api.withdrawMyAttendance({ applicationId, flowVersionNo: 0 }),
      () => api.updateMyAttendance({ orgId, dailyId: 12, finalStatus: 'REST', versionNo: 5 }),
    ];
    for (const operation of operations) {
      const before = calls.length;
      await assert.rejects(operation(), (error) => error.status === 409);
      assert.equal(calls.length, before + 1);
    }
    networkFailure = true;
    for (const operation of operations) {
      const before = calls.length;
      await assert.rejects(operation());
      assert.equal(calls.length, before + 1);
    }
  });

  test(`${mode} avatar upload uses restricted multipart fields and accepts the exact size boundary`, async (t) => {
    const { api, calls } = adapter(t, desktop, ({ data }) =>
      result(avatarResult(data.get('file'))),
    );
    const file = new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], 'avatar.png', {
      type: 'image/png',
    });
    assert.deepEqual(await api.uploadAvatar(file), avatarResult(file));
    const call = calls[0];
    assert.equal(call.path, '/api/v1/files/upload');
    assert.equal(call.method, 'POST');
    assert.equal(call.credentials, desktop ? 'include' : 'same-origin');
    assert.deepEqual(call.headers, { 'X-Tyde-Client': 'web' });
    assert.deepEqual([...call.data.keys()], ['bizType', 'category', 'file']);
    assert.equal(call.data.get('bizType'), 'AVATAR');
    assert.equal(call.data.get('category'), 'IMAGE');
    assert.equal(call.data.get('file').name, file.name);
    assert.deepEqual(await call.data.get('file').arrayBuffer(), await file.arrayBuffer());
    assert.ok(AVATAR_ACCEPT.includes('.webp'));
    const boundary = new File([new Uint8Array(AVATAR_MAX_BYTES)], 'boundary.png', {
      type: 'image/png',
    });
    assert.equal((await api.uploadAvatar(boundary)).size, AVATAR_MAX_BYTES);
    const before = calls.length;
    await assert.rejects(
      api.uploadAvatar(new File([new Uint8Array(AVATAR_MAX_BYTES + 1)], 'too-large.png')),
      (error) => error.status === 413,
    );
    await assert.rejects(
      api.uploadAvatar(new File([], 'empty.png')),
      (error) => error.status === 400,
    );
    await assert.rejects(
      api.uploadAvatar(new File(['image'], 'png')),
      (error) => error.status === 400,
    );
    await assert.rejects(
      api.uploadAvatar(new File(['image'], 'folder.png/image')),
      (error) => error.status === 400,
    );
    await assert.rejects(
      api.uploadAvatar(new File(['<svg/>'], 'avatar.svg', { type: 'image/svg+xml' })),
      (error) => error.status === 400,
    );
    await assert.rejects(
      api.uploadAvatar(new File(['content'], 'wrong.png', { type: 'text/plain' })),
      (error) => error.status === 400,
    );
    assert.equal(calls.length, before);
  });

  test(`${mode} avatar upload preserves server errors and rejects malformed upload credentials`, async (t) => {
    const file = new File(['image'], 'avatar.png', { type: 'image/png' });
    let payload = avatarResult(file);
    let status = 503;
    const { api, calls } = adapter(t, desktop, () => result(payload, status));
    await assert.rejects(api.uploadAvatar(file), (error) => error.status === 503);
    assert.equal(calls.length, 1);
    status = 200;
    for (const patch of [
      { objectKey: 'image/2026/10/21/0123456789abcdef0123456789abcdef.png' },
      { uploadToken: 'invalid' },
      { sensitive: true },
      { size: file.size + 1 },
      { url: undefined },
      { contentType: 'text/plain' },
      { fileHash: 'invalid' },
    ]) {
      payload = { ...avatarResult(file), ...patch };
      await assert.rejects(
        api.uploadAvatar(file),
        (error) => error.status === 502 && error.code === 'INVALID_RESPONSE',
      );
    }
    assert.equal(calls.length, 8);
  });

  test(`${mode} avatar upload retries a single 401 with the same File through Cookie refresh`, async (t) => {
    const file = new File(['image'], 'avatar.png', { type: 'image/png' });
    let refreshed = false;
    const { api, calls } = adapter(t, desktop, ({ path }) => {
      if (path.endsWith('/auth/login')) return result(tokens);
      if (path.endsWith('/auth/refresh')) {
        refreshed = true;
        return result({ ...tokens, refreshToken: 's'.repeat(43) });
      }
      if (path.endsWith('/files/upload'))
        return refreshed ? result(avatarResult(file)) : result(null, 401);
      throw new Error(`Unexpected endpoint ${path}`);
    });
    await api.login({ account: '13812345678', password: 'FixturePass123!' });
    assert.deepEqual(await api.uploadAvatar(file), avatarResult(file));
    const uploads = calls.filter(({ path }) => path.endsWith('/files/upload'));
    assert.equal(uploads.length, 2);
    assert.equal(uploads[0].data, uploads[1].data);
    assert.equal(uploads[1].data.get('file'), file);
    assert.equal(calls.filter(({ path }) => path.endsWith('/auth/refresh')).length, 1);
    assert.ok(
      uploads.every(
        ({ headers }) =>
          headers['Content-Type'] === undefined && headers['X-Tyde-Client'] === 'web',
      ),
    );
  });

  test(`${mode} organization Logo upload uses its own image scope and validates size and format before sending`, async (t) => {
    const { api, calls } = adapter(t, desktop, ({ data }) => result(logoResult(data.get('file'))));
    const file = new File(['image'], 'logo.png', { type: 'image/png' });
    assert.deepEqual(await api.uploadOrganizationLogo(file), logoResult(file));
    const call = calls[0];
    assert.equal(call.path, '/api/v1/files/upload');
    assert.equal(call.method, 'POST');
    assert.equal(call.credentials, desktop ? 'include' : 'same-origin');
    assert.deepEqual(call.headers, { 'X-Tyde-Client': 'web' });
    assert.deepEqual([...call.data.keys()], ['bizType', 'category', 'file']);
    assert.equal(call.data.get('bizType'), 'ORG_LOGO');
    assert.equal(call.data.get('category'), 'IMAGE');
    assert.equal(call.data.get('file'), file);
    assert.ok(ORG_LOGO_ACCEPT.includes('.webp'));
    const boundary = new File([new Uint8Array(ORG_LOGO_MAX_BYTES)], 'boundary.png', {
      type: 'image/png',
    });
    assert.equal((await api.uploadOrganizationLogo(boundary)).size, ORG_LOGO_MAX_BYTES);
    const before = calls.length;
    for (const [invalidFile, status] of [
      [new File([new Uint8Array(ORG_LOGO_MAX_BYTES + 1)], 'too-large.png'), 413],
      [new File([], 'empty.png'), 400],
      [new File(['<svg/>'], 'logo.svg', { type: 'image/svg+xml' }), 400],
      [new File(['image'], 'wrong.png', { type: 'text/plain' }), 400],
    ])
      await assert.rejects(
        api.uploadOrganizationLogo(invalidFile),
        (error) => error.status === status,
      );
    assert.equal(calls.length, before);
  });

  test(`${mode} organization Logo upload rejects unrelated upload credentials and never replays failed writes`, async (t) => {
    const file = new File(['image'], 'logo.png', { type: 'image/png' });
    let payload = logoResult(file);
    let status = 503;
    const { api, calls } = adapter(t, desktop, () => result(payload, status));
    await assert.rejects(api.uploadOrganizationLogo(file), (error) => error.status === 503);
    assert.equal(calls.length, 1);
    status = 200;
    for (const patch of [
      { objectKey: avatarResult(file).objectKey },
      { uploadToken: 'invalid' },
      { sensitive: true },
      { size: file.size + 1 },
      { contentType: 'text/plain' },
    ]) {
      payload = { ...logoResult(file), ...patch };
      await assert.rejects(
        api.uploadOrganizationLogo(file),
        (error) => error.status === 502 && error.code === 'INVALID_RESPONSE',
      );
    }
    assert.equal(calls.length, 6);
  });

  test(`${mode} organization create and edit submit the uploaded Logo key and claim token together`, async (t) => {
    const upload = logoResult(new File(['image'], 'logo.png', { type: 'image/png' }));
    const created = {
      id: orgId,
      name: '测试组织',
      unifiedCreditCode: null,
      description: null,
      businessLicenseUrl: null,
      logoUrl: upload.url,
      expertiseTags: [],
      verifyStatus: 'APPROVED',
      status: 'ACTIVE',
      position: 'OWNER',
      createdAt: wallTime,
    };
    const updated = { id: orgId, description: null, logoUrl: upload.url, updatedAt: wallTime };
    const { api, calls } = adapter(t, desktop, ({ path }) =>
      result(path.endsWith('/update') ? updated : created),
    );
    const logo = { logoUrl: upload.objectKey, logoUploadToken: upload.uploadToken };
    assert.deepEqual(await api.createOrganization({ name: '测试组织', ...logo }), created);
    assert.deepEqual(await api.updateOrganization({ orgId, ...logo }), updated);
    assert.deepEqual(
      calls.map(({ path, data }) => ({ path, data })),
      [
        { path: '/api/v1/organizations', data: { name: '测试组织', ...logo } },
        { path: '/api/v1/organizations/update', data: { orgId, ...logo } },
      ],
    );
  });

  test(`${mode} personal reads preserve endpoint scope, wall clock, nullable fields and query defaults`, async (t) => {
    const { api, calls } = adapter(t, desktop, ({ path }) => {
      if (path.includes('/my-projects')) return result([project]);
      if (path.includes('/detail?')) return result(detail);
      if (path.endsWith('/applications')) return result(page());
      if (path.includes('/calendar/holidays?')) return result(holidays);
      if (path.includes('/attendance?'))
        return result(attendance(path.includes('orgId=') ? orgId : null));
      throw new Error(`Unexpected endpoint ${path}`);
    });
    assert.deepEqual(await api.getMyExpertProjects('  标注 & 复核  '), [project]);
    assert.deepEqual(await api.getExpertAssignmentDetail(23), detail);
    const input = {
      current: 1,
      size: 20,
      businessType: null,
      status: 'PENDING',
      startAt: wallTime,
    };
    assert.deepEqual(await api.listMyApplications(input), page());
    const month = await api.getMyAttendance({ month: '2026-10', orgId });
    assert.deepEqual(month, attendance());
    assert.equal(month.days[20].versionNo, 3);
    assert.equal(month.days[20].dailyVersionNo, 5);
    assert.equal(month.days[20].application.flowVersionNo, 7);
    assert.equal(month.days[20].shiftStartAt, wallTime);
    assert.equal(month.days[20].firstClockInAt, '2026-10-21 09:30:00.123');
    assert.deepEqual(await api.getAttendanceHolidays({ month: '2026-10', orgId }), holidays);
    assert.deepEqual(await api.getMyAttendance({ month: '2026-10' }), attendance(null));
    await api.listMyApplications({ current: 1, size: 20 });
    await api.getMyExpertProjects();
    assert.deepEqual(
      calls.map(({ path }) => path),
      [
        `/api/v1/expert-assignments/my-projects?${new URLSearchParams({ keyword: '  标注 & 复核  ' })}`,
        '/api/v1/expert-assignments/detail?assignmentId=23',
        '/api/v1/users/me/applications',
        `/api/v1/organizations/attendance?month=2026-10&orgId=${orgId}`,
        `/api/v1/organizations/calendar/holidays?month=2026-10&orgId=${orgId}`,
        '/api/v1/organizations/attendance?month=2026-10',
        '/api/v1/users/me/applications',
        '/api/v1/expert-assignments/my-projects',
      ],
    );
    assert.deepEqual(calls[2].data, input);
    assert.equal(Object.hasOwn(calls[6].data, 'businessType'), false);
    for (const call of calls) {
      assert.equal(call.credentials, desktop ? 'include' : 'same-origin');
      assert.equal(call.headers.Authorization, undefined);
      assert.equal(call.headers['X-Tyde-Role'], undefined);
      if (call.path.endsWith('/applications')) {
        assert.equal(call.method, 'POST');
        assert.deepEqual(call.headers, {
          'X-Tyde-Client': 'web',
          'Content-Type': 'application/json',
        });
      } else {
        assert.equal(call.method, 'GET');
        assert.deepEqual(call.headers, {});
        assert.equal(call.body, undefined);
      }
    }
  });

  test(`${mode} personal read failures remain errors without automatic request replay`, async (t) => {
    let status = 403;
    const { api, calls } = adapter(t, desktop, () => {
      if (status === 0) throw new Error('fixture offline');
      return result(null, status);
    });
    await assert.rejects(
      api.getExpertAssignmentDetail(23),
      (error) => error.status === 403 && error.message === '真实服务端错误',
    );
    status = 409;
    await assert.rejects(
      api.listMyApplications({ businessType: null }),
      (error) => error.status === 409,
    );
    status = 503;
    await assert.rejects(
      api.getAttendanceHolidays({ month: '2026-10' }),
      (error) => error.status === 503,
    );
    status = 0;
    await assert.rejects(
      api.getMyAttendance({ month: '2026-10' }),
      (error) => error.code === 'NETWORK_ERROR' && error.status === 0,
    );
    assert.equal(calls.length, 4);
  });

  test(`${mode} GET and POST personal reads share Cookie refresh and retry a 401 only once`, async (t) => {
    let refreshed = false;
    let rejectAgain = false;
    const { api, calls } = adapter(t, desktop, ({ path }) => {
      if (path.endsWith('/auth/login')) return result(tokens);
      if (path.endsWith('/auth/refresh')) {
        refreshed = true;
        return result({ ...tokens, refreshToken: 's'.repeat(43) });
      }
      if (!refreshed || rejectAgain) return result(null, 401);
      if (path.includes('/my-projects')) return result([]);
      if (path.endsWith('/applications')) return result(page([]));
      throw new Error(`Unexpected endpoint ${path}`);
    });
    await api.login({ account: '13812345678', password: 'FixturePass123!' });
    assert.deepEqual(
      await Promise.all([
        api.getMyExpertProjects(),
        api.listMyApplications({ businessType: null, current: 1, size: 20 }),
      ]),
      [[], page([])],
    );
    assert.equal(calls.filter(({ path }) => path.endsWith('/auth/refresh')).length, 1);
    assert.deepEqual(calls.find(({ path }) => path.endsWith('/auth/refresh')).data, {
      refreshToken: tokens.refreshToken,
    });
    const applications = calls.filter(({ path }) => path.endsWith('/applications'));
    assert.equal(applications.length, 2);
    assert.deepEqual(applications[0].data, applications[1].data);
    rejectAgain = true;
    const before = calls.length;
    await assert.rejects(api.getMyExpertProjects(), (error) => error.status === 401);
    assert.equal(calls.length - before, 3);
  });
}

test('attendance writes reject invalid dates, foreign scope and unrelated response resources', async (t) => {
  let response = attendanceApplied;
  const { api, calls } = adapter(t, false, () => result(response));
  for (const patch of [
    { attendanceDate: '2026-02-30' },
    { attendanceDate: '2026-99-99' },
    { orgId: 'not-a-uuid' },
    { versionNo: undefined },
    { reason: ' ' },
    { userId },
    { applicationType: 'CORRECTION' },
    { leaveStartAt: '2026-10-20 09:00:00' },
    { leaveEndAt: wallTime },
  ])
    await assert.rejects(
      api.applyMyAttendance({ ...attendanceApply, ...patch }),
      (error) => error.status === 400,
    );
  for (const schedules of [
    [],
    [{ ...scheduleInput.schedules[0], memberId: userId }],
    [{ scheduleDate: '2026-10-21', dayType: 'REST', startTime: '09:00' }],
    [{ ...scheduleInput.schedules[0], endTime: '08:00' }],
    [scheduleInput.schedules[0], scheduleInput.schedules[0]],
  ])
    await assert.rejects(
      api.batchMySchedules({ ...scheduleInput, schedules }),
      (error) => error.status === 400,
    );
  await assert.rejects(
    api.batchMySchedules({ ...scheduleInput, orgId }),
    (error) => error.status === 400,
  );
  await assert.rejects(
    api.batchMySchedules({ ...scheduleInput, timezone: 'invalid-zone' }),
    (error) => error.status === 400,
  );
  await assert.rejects(
    api.withdrawMyAttendance({ applicationId: 1, flowVersionNo: 0 }),
    (error) => error.status === 400,
  );
  await assert.rejects(
    api.updateMyAttendance({ orgId, dailyId: 12, finalStatus: 'LEAVE', versionNo: null }),
    (error) => error.status === 400,
  );
  assert.equal(calls.length, 0);
  for (const patch of [
    { applicationId: 1 },
    { applicationType: 'CORRECTION' },
    { attendanceDate: '2026-10-22' },
    { versionNo: 3 },
    { dailyId: 99 },
    { status: 'APPROVED' },
    { leaveEndAt: '2026-10-21 14:00:00' },
    { flowVersionNo: undefined },
  ]) {
    response = { ...attendanceApplied, ...patch };
    await assert.rejects(api.applyMyAttendance(attendanceApply), (error) => error.status === 502);
  }
  response = {
    ...attendanceApplied,
    applicationId: userId,
    status: 'WITHDRAWN',
    flowVersionNo: 1,
    finishedAt: '2026-10-21T02:00:00.000Z',
  };
  await assert.rejects(
    api.withdrawMyAttendance({ applicationId, flowVersionNo: 0 }),
    (error) => error.status === 502,
  );
  response = {
    ...scheduled,
    conflicts: [{ ...scheduled.conflicts[0], scheduleDate: '2026-10-23' }],
  };
  await assert.rejects(api.batchMySchedules(scheduleInput), (error) => error.status === 502);
  response = { ...scheduled, skippedCount: 0 };
  await assert.rejects(api.batchMySchedules(scheduleInput), (error) => error.status === 502);
  const update = { orgId, dailyId: 12, finalStatus: 'PRESENT', versionNo: 5 };
  const updated = {
    id: 12,
    beforeStatus: null,
    finalStatus: 'PRESENT',
    manualOverride: true,
    manualRemark: null,
    correctedBy: 'TEST10001',
    correctedAt: wallTime,
    versionNo: 6,
    adjustmentId: 10,
  };
  for (const patch of [
    { id: 99 },
    { versionNo: 5 },
    { finalStatus: 'REST' },
    { manualOverride: false },
  ]) {
    response = { ...updated, ...patch };
    await assert.rejects(api.updateMyAttendance(update), (error) => error.status === 502);
  }
});

test('optional personal application withdrawal permission remains explicit when returned', async (t) => {
  let canWithdraw = false;
  const { api } = adapter(t, false, () => result(page([{ ...application, canWithdraw }])));
  assert.equal((await api.listMyApplications({})).records[0].canWithdraw, false);
  canWithdraw = true;
  assert.equal((await api.listMyApplications({})).records[0].canWithdraw, true);
  canWithdraw = 'true';
  await assert.rejects(api.listMyApplications({}), (error) => error.status === 502);
});

test('personal read parsers reject incomplete nested data rather than filling missing nulls', async (t) => {
  let payload;
  const { api, calls } = adapter(t, false, () => result(payload));
  const check = async (valid, mutate, request) => {
    payload = structuredClone(valid);
    mutate(payload);
    await assert.rejects(
      request(),
      (error) => error.status === 502 && error.code === 'INVALID_RESPONSE',
    );
  };
  await check(
    [project],
    (data) => {
      data[0].admissionStatus = 'ACCEPTED';
    },
    () => api.getMyExpertProjects(),
  );
  await check(
    detail,
    (data) => {
      delete data.productionPlan.stages[0].workdayCountSource;
    },
    () => api.getExpertAssignmentDetail(23),
  );
  await check(
    detail,
    (data) => {
      delete data.projectDetail.standardContent;
    },
    () => api.getExpertAssignmentDetail(23),
  );
  await check(
    detail,
    (data) => {
      data.assignmentId = 24;
    },
    () => api.getExpertAssignmentDetail(23),
  );
  await check(
    page(),
    (data) => {
      delete data.records[0].formData;
    },
    () => api.listMyApplications({}),
  );
  await check(
    attendance(),
    (data) => {
      delete data.days[0].application;
    },
    () => api.getMyAttendance({ month: '2026-10', orgId }),
  );
  await check(
    attendance(),
    (data) => {
      data.days[20].application.finalStatus = 'UNSCHEDULED';
    },
    () => api.getMyAttendance({ month: '2026-10', orgId }),
  );
  await check(
    attendance(),
    (data) => {
      data.days[0].permissions.canDirectUpdate = 'false';
    },
    () => api.getMyAttendance({ month: '2026-10', orgId }),
  );
  await check(
    attendance(),
    (data) => {
      data.organizationId = null;
    },
    () => api.getMyAttendance({ month: '2026-10', orgId }),
  );
  await check(
    attendance(),
    (data) => {
      data.days.pop();
    },
    () => api.getMyAttendance({ month: '2026-10', orgId }),
  );
  await check(
    attendance(),
    (data) => {
      data.days.reverse();
    },
    () => api.getMyAttendance({ month: '2026-10', orgId }),
  );
  await check(
    holidays,
    (data) => {
      data.days[0].date = '2026-10-32';
    },
    () => api.getAttendanceHolidays({ month: '2026-10' }),
  );
  const before = calls.length;
  await assert.rejects(api.getExpertAssignmentDetail(0), (error) => error.status === 400);
  await assert.rejects(api.getExpertAssignmentDetail(2147483648), (error) => error.status === 400);
  await assert.rejects(api.getMyExpertProjects('a'.repeat(101)), (error) => error.status === 400);
  await assert.rejects(api.getMyAttendance({ month: '2026-13' }), (error) => error.status === 400);
  await assert.rejects(
    api.getAttendanceHolidays({ month: '1899-01' }),
    (error) => error.status === 400,
  );
  await assert.rejects(
    api.getMyAttendance({ month: '2026-10', orgId: 'invalid' }),
    (error) => error.status === 400,
  );
  assert.equal(calls.length, before);
});

test('a late personal read cannot restore data after logout', async (t) => {
  const started = deferred();
  const release = deferred();
  const { api } = adapter(t, false, async ({ path }) => {
    if (path.includes('/attendance?')) {
      started.resolve();
      await release.promise;
      return result(attendance(null));
    }
    if (path.endsWith('/logout')) return result(null);
    throw new Error(`Unexpected endpoint ${path}`);
  });
  const pending = api.getMyAttendance({ month: '2026-10' });
  await started.promise;
  await api.logout();
  release.resolve();
  await assert.rejects(
    pending,
    (error) => error.status === 401 && error.code === 'SESSION_CHANGED',
  );
});
