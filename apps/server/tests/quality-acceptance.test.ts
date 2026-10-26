import { Prisma, PrismaClient } from '@prisma/client';
import { afterEach, expect, test, vi } from 'vitest';
import {
  qualityAmounts,
  sumProductionQuantities,
  productionRange,
  QualityService,
} from '../src/modules/production/quality.service.js';
import {
  acceptanceReady,
  validateAcceptance,
  acceptanceDecision,
  AcceptanceService,
} from '../src/modules/production/acceptance.service.js';
import * as schemas from '../src/modules/production/quality-acceptance.schema.js';
import { AuthService, type AuthPrincipal } from '../src/modules/auth/auth.service.js';
import { createApp } from '../src/application.js';
import { readConfig } from '../src/config/index.js';
const p = {
  userId: '11111111-1111-4111-8111-111111111111',
  uid: '123456',
  role: 'PM',
  sessionId: 's',
  clientType: 'desktop',
} as AuthPrincipal;
afterEach(() => vi.restoreAllMocks());
test('quality uses exact decimal comparison, bounded positive inspection and Shanghai inclusive 31-day ranges', () => {
  const item = {
    outputReportId: 1,
    inspectedQuantity: '99999999999999999999999999.1234',
    qualifiedQuantity: '99999999999999999999999999.1233',
  };
  expect(
    qualityAmounts(item).inspectedQuantity.minus(qualityAmounts(item).qualifiedQuantity).toFixed(),
  ).toBe('0.0001');
  expect(
    sumProductionQuantities([
      new Prisma.Decimal(item.inspectedQuantity),
      new Prisma.Decimal('0.0001'),
    ]).toFixed(),
  ).toBe('99999999999999999999999999.1235');
  for (const [inspectedQuantity, qualifiedQuantity] of [
    [0, 0],
    [1, 2],
    [1, -1],
    ['1.00001', 0],
  ])
    expect(() =>
      qualityAmounts({
        outputReportId: 1,
        inspectedQuantity: inspectedQuantity!,
        qualifiedQuantity: qualifiedQuantity!,
      }),
    ).toThrow();
  expect(
    productionRange({ projectId: 1 }, new Date('2026-10-26T16:00:00Z')).start.toISOString(),
  ).toBe('2026-10-27T00:00:00.000Z');
  expect(() =>
    productionRange(
      { projectId: 1, reportDateStart: '2026-01-01', reportDateEnd: '2026-01-31' },
      new Date(),
    ),
  ).not.toThrow();
  for (const end of ['2026-02-01', '2025-12-31', '2026-02-30'])
    expect(() =>
      productionRange(
        { projectId: 1, reportDateStart: '2026-01-01', reportDateEnd: end },
        new Date(),
      ),
    ).toThrow();
});
test('acceptance requires verified data, exact quantity adjustment and non-past Shanghai delivery date', () => {
  expect(acceptanceReady({ verified: 1, pending: 0, returned: 0 })).toBe(true);
  for (const counts of [
    { verified: 0, pending: 0, returned: 0 },
    { verified: 1, pending: 1, returned: 0 },
    { verified: 1, pending: 0, returned: 1 },
  ])
    expect(acceptanceReady(counts)).toBe(false);
  const q = {
      projectId: 1,
      subtaskId: 1,
      actualQuantity: '99999999999999999999999999.1234',
      actualDeliveryDate: '2026-10-27',
    },
    now = new Date('2026-10-26T16:00:00Z');
  expect(
    validateAcceptance(
      { ...q, quantityAdjustmentRemark: '清空' },
      new Prisma.Decimal(q.actualQuantity),
      now,
    ).quantityAdjustmentRemark,
  ).toBeNull();
  expect(() =>
    validateAcceptance(q, new Prisma.Decimal('99999999999999999999999999.1233'), now),
  ).toThrow();
  expect(
    validateAcceptance({ ...q, quantityAdjustmentRemark: ' 精确调整 ' }, new Prisma.Decimal(1), now)
      .quantityAdjustmentRemark,
  ).toBe('精确调整');
  for (const partial of [{ actualQuantity: 0 }, { actualDeliveryDate: '2026-10-26' }])
    expect(() => validateAcceptance({ ...q, ...partial }, new Prisma.Decimal(1), now)).toThrow();
  expect(() =>
    acceptanceDecision({ projectId: 1, subtaskId: 1, decision: 'REJECT', rejectReason: '  ' }),
  ).toThrow();
  expect(() =>
    acceptanceDecision({ projectId: 1, subtaskId: 1, decision: 'ACCEPT', rejectReason: '原因' }),
  ).toThrow();
});
test('acceptance commands reject alternate roles before database access', async () => {
  const service = new AcceptanceService({} as never);
  await expect(
    service.submit(
      { projectId: 1, subtaskId: 1, actualQuantity: 1, actualDeliveryDate: '2099-12-31' },
      { ...p, role: 'EXPERT' },
    ),
  ).rejects.toMatchObject({ status: 403 });
  await expect(
    service.review({ projectId: 1, subtaskId: 1, decision: 'ACCEPT' }, p),
  ).rejects.toMatchObject({ status: 403 });
});
test('quality and acceptance six HTTP routes validate Swagger examples, response serialization and scope injection', async () => {
  vi.spyOn(AuthService.prototype, 'authenticate').mockResolvedValue(p);
  vi.spyOn(QualityService.prototype, 'list').mockResolvedValue(
    schemas.productionListResponse.examples[0]!,
  );
  vi.spyOn(QualityService.prototype, 'context').mockResolvedValue(
    schemas.qualityContextResponse.examples[0]!,
  );
  vi.spyOn(QualityService.prototype, 'save').mockResolvedValue(null);
  vi.spyOn(AcceptanceService.prototype, 'context').mockResolvedValue(
    schemas.acceptanceContextResponse.examples[0]!,
  );
  vi.spyOn(AcceptanceService.prototype, 'submit').mockResolvedValue(null);
  vi.spyOn(AcceptanceService.prototype, 'review').mockResolvedValue(null);
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
    for (const schema of Object.values(schemas)) {
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
        'project-personnel/production/list',
        schemas.productionListBody.examples[0],
        schemas.productionListResponse.examples[0],
      ],
      [
        'project-personnel/production/quality/context',
        schemas.qualityContextBody.examples[0],
        schemas.qualityContextResponse.examples[0],
      ],
      ['project-personnel/production/quality/save', schemas.qualitySaveBody.examples[0], null],
      [
        'production-tasks/acceptance/context',
        schemas.acceptanceContextBody.examples[0],
        schemas.acceptanceContextResponse.examples[0],
      ],
      ['production-tasks/acceptance/submit', schemas.acceptanceSubmitBody.examples[0], null],
      ['production-tasks/acceptance/review', schemas.acceptanceReviewBody.examples[0], null],
    ] as const) {
      const response = await app.inject({ method: 'POST', url: '/api/v1/' + path, payload: body });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().data).toEqual(data);
      expect(response.headers['cache-control']).toBe('no-store');
      const invalid = await app.inject({
        method: 'POST',
        url: '/api/v1/' + path,
        payload: { ...body, userId: p.userId },
      });
      expect(invalid.statusCode, invalid.body).toBe(400);
    }
    const large = await app.inject({
      method: 'POST',
      url: '/api/v1/project-personnel/production/quality/save',
      payload: {
        ...schemas.qualitySaveBody.examples[0],
        items: Array.from({ length: 100 }, () => ({
          outputReportId: 1,
          inspectedQuantity: 1,
          qualifiedQuantity: 0,
          unqualifiedReason: '字'.repeat(1000),
        })),
      },
    });
    expect(large.statusCode, large.body).toBe(200);
    const oversized = await app.inject({
      method: 'POST',
      url: '/api/v1/project-personnel/production/quality/save',
      payload: { padding: 'x'.repeat(512 * 1024) },
    });
    expect(oversized.statusCode, oversized.body).toBe(413);
  } finally {
    await app.close();
  }
});
