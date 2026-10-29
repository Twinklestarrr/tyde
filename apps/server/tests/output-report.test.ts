import * as ownerProgress from '../src/modules/expert/expert-owner-command.js';
import * as managementCards from '../src/modules/projects/project-management-card-snapshot.js';
import { PrismaClient } from '@prisma/client';
import { afterEach, expect, test, vi } from 'vitest';
import { reportQuantity, reportDay } from '../src/modules/production/output-report.domain.js';
import {
  reportActions,
  isReportOwner,
  departed,
} from '../src/modules/production/output-report-access.js';
import { OutputReportService } from '../src/modules/production/output-report.service.js';
import { AuthService, type AuthPrincipal } from '../src/modules/auth/auth.service.js';
import { createApp } from '../src/application.js';
import { readConfig } from '../src/config/index.js';
import * as schemas from '../src/modules/production/output-report.schema.js';
const p: AuthPrincipal = {
  userId: '11111111-1111-4111-8111-111111111111',
  uid: '123456',
  role: 'EXPERT',
  sessionId: 'session',
  clientType: 'desktop',
};
afterEach(() => vi.restoreAllMocks());
test('output report validates exact nonnegative decimals and Shanghai midnight dates', () => {
  expect(reportQuantity('99999999999999999999999999.1234').toFixed()).toBe(
    '99999999999999999999999999.1234',
  );
  expect(reportQuantity(0).toFixed()).toBe('0');
  expect(reportQuantity(1e25).toFixed()).toBe('10000000000000000000000000');
  for (const q of [-1, NaN, Infinity, '1e3', '-0', '1.00001', '100000000000000000000000000'])
    expect(() => reportQuantity(q)).toThrow();
  expect(reportDay('2026-10-27', new Date('2026-10-26T16:00:00Z')).toISOString()).toBe(
    '2026-10-27T00:00:00.000Z',
  );
  for (const date of ['2026-10-28', '2026-02-30'])
    expect(() => reportDay(date, new Date('2026-10-26T16:00:00Z'))).toThrow();
});
test('output report actions distinguish read-only, owned scope, correction and writable status', () => {
  const scope = {
    readOnly: false,
    reviewer: true,
    memberIds: [1, 2],
    correctionIds: [2],
    organizationIds: ['org-a'],
    all: [
      { id: 1, organizationId: 'org-a' },
      { id: 2, organizationId: 'org-b' },
    ],
  } as never;
  expect(reportActions(scope, 1, 'PENDING', true)).toEqual(['VERIFY', 'RETURN']);
  expect(reportActions(scope, 2, 'PENDING', true)).toEqual([]);
  expect(reportActions(scope, 2, 'RETURNED', true)).toEqual(['SAVE_REPORT']);
  expect(reportActions(scope, 2, 'VERIFIED', true)).toEqual([]);
  expect(
    reportActions({ ...(scope as object), readOnly: true } as never, 1, 'PENDING', true),
  ).toEqual([]);
  expect(reportActions(scope, 1, 'PENDING', false)).toEqual([]);
});
test('output correction ownership rejects stale assignments and treats departure as transferred work', () => {
  const m = {
    status: 'ACTIVE',
    leftAt: null,
    userOrgRelId: 'rel',
    organizationMembership: { joinStatus: 'ACTIVE' },
    organizationId: 'org',
    projectId: 1,
    organization: { deleted: false },
    expertAssignment: {
      projectId: 1,
      status: 'ACCEPTED',
      organizationId: 'org',
      owners: [{ userId: p.userId, status: 'ACTIVE', user: { status: 'ACTIVE' } }],
    },
  } as never;
  expect(isReportOwner(m, p.userId)).toBe(true);
  expect(departed(m)).toBe(false);
  expect(departed({ ...(m as object), status: 'LEFT' } as never)).toBe(true);
  expect(
    departed({ ...(m as object), organizationMembership: { joinStatus: 'REMOVED' } } as never),
  ).toBe(true);
  expect(
    isReportOwner(
      { ...(m as object), expertAssignment: { projectId: 1, status: 'REFUSED' } } as never,
      p.userId,
    ),
  ).toBe(false);
});
test('output report command roles reject PM and navigator before touching the database', async () => {
  const s = new OutputReportService({} as never);
  for (const role of ['PM', 'NAVIGATOR'] as const) {
    await expect(s.save({ projectId: 1, reports: [] }, { ...p, role })).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      s.correct({ projectId: 1, reportId: 1, quantity: 0 }, { ...p, role }),
    ).rejects.toMatchObject({ status: 403 });
  }
});
test('output Swagger examples and six real HTTP routes validate nesting, null results and reject scope injection', async () => {
  vi.spyOn(AuthService.prototype, 'authenticate').mockResolvedValue(p);
  vi.spyOn(OutputReportService.prototype, 'reportable').mockResolvedValue(
    schemas.reportableResponse.examples[0]!,
  );
  vi.spyOn(OutputReportService.prototype, 'assignees').mockResolvedValue(
    schemas.assigneesResponse.examples[0]!,
  );
  vi.spyOn(OutputReportService.prototype, 'reports').mockResolvedValue(
    schemas.reportsResponse.examples[0]!,
  );
  vi.spyOn(OutputReportService.prototype, 'save').mockResolvedValue(null);
  vi.spyOn(OutputReportService.prototype, 'correct').mockResolvedValue(null);
  vi.spyOn(OutputReportService.prototype, 'review').mockResolvedValue(null);
  const app = await createApp(
    readConfig({
      APP_ENV: 'test',
      DATABASE_URL: 'postgresql://localhost/unused_test',
      CODE_HMAC_SECRET: 'x'.repeat(32),
      SMS_PROVIDER: 'mock',
      WEB_ORIGINS: 'http://127.0.0.1:3000',
      LOG_LEVEL: 'silent',
    }),
    new PrismaClient(),
  );
  try {
    await app.ready();
    for (const schema of Object.values(schemas))
      if ('examples' in schema) {
        const validate = app.validatorCompiler!({
          schema,
          method: 'POST',
          url: '/examples',
          httpPart: 'body',
        });
        for (const example of schema.examples)
          expect(validate(example), JSON.stringify(validate.errors)).toBe(true);
      }
    for (const [path, body, data] of [
      [
        'reportable-list',
        schemas.reportableBody.examples[0],
        schemas.reportableResponse.examples[0],
      ],
      ['member-list', schemas.assigneesBody.examples[0], schemas.assigneesResponse.examples[0]],
      ['reports', schemas.reportsBody.examples[0], schemas.reportsResponse.examples[0]],
      ['report/save', schemas.saveBody.examples[0], null],
      ['report/correct', schemas.correctBody.examples[0], null],
      ['report/review', schemas.reviewBody.examples[0], null],
    ] as const) {
      const r = await app.inject({
        method: 'POST',
        url: '/api/v1/production-tasks/' + path,
        headers: { authorization: 'Bearer token' },
        payload: body,
      });
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().data).toEqual(data);
      expect(r.headers['cache-control']).toBe('no-store');
    }
    for (const [path, payload] of [
      ['reports', { projectId: 1, userId: p.userId }],
      ['reports', { projectId: 1, reviewStatuses: ['BAD'] }],
      ['report/save', { projectId: 1, reports: [] }],
      ['report/save', { projectId: 1, reports: [{ reportDate: '2026-10-26', quantity: -1 }] }],
      ['report/correct', { projectId: 1, reportId: 1, quantity: 0, memberId: 2 }],
      ['member-list', { projectId: 1 }],
    ] as const) {
      const r = await app.inject({
        method: 'POST',
        url: '/api/v1/production-tasks/' + path,
        payload,
      });
      expect(r.statusCode, r.body).toBe(400);
    }
    const large = await app.inject({
      method: 'POST',
      url: '/api/v1/production-tasks/report/save',
      payload: {
        projectId: 1,
        reports: Array.from({ length: 100 }, (_, i) => ({
          memberId: i + 1,
          reportDate: '2026-10-26',
          quantity: 0,
          remark: '字'.repeat(1000),
        })),
      },
    });
    expect(large.statusCode, large.body).toBe(200);
    const oversized = await app.inject({
      method: 'POST',
      url: '/api/v1/production-tasks/report/save',
      payload: { projectId: 1, reports: [], padding: 'x'.repeat(512 * 1024) },
    });
    expect(oversized.statusCode, oversized.body).toBe(413);
    const spec = (await app.inject('/api/v1/docs/json')).json();
    for (const path of [
      'reportable-list',
      'member-list',
      'reports',
      'report/save',
      'report/correct',
      'report/review',
    ])
      expect(spec.paths['/api/v1/production-tasks/' + path].post.operationId).toBeTruthy();
  } finally {
    await app.close();
  }
});

test('output snapshots delegate to complete cross-domain arbitration and return expert recipients without altering task types', async () => {
  const recipients = { cardChangedRecipients: [{ userId: p.userId, role: 'EXPERT' as const }] };
  const refresh = vi
    .spyOn(managementCards, 'refreshManagementCardSnapshots')
    .mockResolvedValue(recipients);
  const { syncOutputSnapshots } =
    await import('../src/modules/production/output-report-progress.js');
  const progress = vi.spyOn(ownerProgress, 'refreshOwnerProgress').mockResolvedValue();
  const tx = {};
  const empty = { scopes: [], sources: [] };
  const correction = {
    scopes: [],
    sources: [
      {
        userId: p.userId,
        role: 'EXPERT' as const,
        taskType: 'OUTPUT_REPORT_CORRECTION',
        sources: ['OUTPUT_REPORT:1'],
      },
    ],
  };
  const now = new Date('2026-10-26T00:00Z');
  expect(await syncOutputSnapshots(tx as never, 1, empty, correction, now)).toEqual(recipients);
  expect(progress).toHaveBeenCalledWith(tx, 1, null, now);
  expect(progress.mock.invocationCallOrder[0]).toBeLessThan(refresh.mock.invocationCallOrder[0]!);
  expect(refresh).toHaveBeenCalledWith(tx, 1, now);
  expect(correction.sources[0]!.taskType).toBe('OUTPUT_REPORT_CORRECTION');
});
