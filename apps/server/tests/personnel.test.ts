import { PrismaClient, type ProjectMember } from '@prisma/client';
import { afterEach, expect, test, vi } from 'vitest';
import { canSetEntry, validateEntry } from '../src/modules/personnel/personnel-domain.js';
import {
  personnelScope,
  qualifiedForEntry,
  type PersonnelMember,
} from '../src/modules/personnel/personnel-access.js';
import { PersonnelService } from '../src/modules/personnel/personnel.service.js';
import { AuthService, type AuthPrincipal } from '../src/modules/auth/auth.service.js';
import { createApp } from '../src/application.js';
import { readConfig } from '../src/config/index.js';
import {
  rosterBody,
  entryBody,
  rosterResponse,
  rosterExample,
} from '../src/modules/personnel/personnel.schema.js';
const userId = '00000000-0000-4000-8000-000000000001';
const p: AuthPrincipal = {
  userId,
  uid: 'test',
  role: 'PM',
  sessionId: 'session',
  clientType: 'desktop',
};
const now = new Date('2026-10-23T16:01:00Z');
afterEach(() => vi.restoreAllMocks());
test('entry dates use Shanghai midnight; only future pending entries remain editable', () => {
  const member = {
    status: 'PENDING_ENTRY',
    entryDecision: 'YES',
    plannedEntryDate: new Date('2026-10-24'),
  } as ProjectMember;
  expect(canSetEntry(member, '2026-10-23')).toBe(true);
  expect(canSetEntry(member, '2026-10-24')).toBe(false);
  expect(canSetEntry({ ...member, status: 'ACTIVE' }, '2026-10-23')).toBe(false);
  expect(
    validateEntry(
      { projectId: 1, memberIds: [2, 1, 2], entryDecision: 'YES', plannedEntryDate: '2026-10-24' },
      now,
    ),
  ).toEqual([1, 2]);
  for (const plannedEntryDate of ['2026-10-23', '2026-02-30', 'bad'])
    expect(() =>
      validateEntry({ projectId: 1, memberIds: [1], entryDecision: 'YES', plannedEntryDate }, now),
    ).toThrow();
  expect(() =>
    validateEntry({ projectId: 1, memberIds: [1], entryDecision: 'NO', declineReason: '  ' }, now),
  ).toThrow();
});
test('entry qualification binds specific accepted assignment, membership and original admitted attempt', () => {
  const m = {
    projectId: 1,
    userId,
    organizationId: null,
    userOrgRelId: null,
    admittedAt: now,
    user: { status: 'ACTIVE' },
    expertAssignment: {
      id: 1,
      projectId: 1,
      status: 'ACCEPTED',
      subjectType: 'INDIVIDUAL',
      expertUserId: userId,
    },
    admissionAttempt: null,
  } as unknown as PersonnelMember;
  expect(qualifiedForEntry(m, false)).toBe(true);
  expect(qualifiedForEntry(m, true)).toBe(false);
  m.admissionAttempt = {
    candidateUserId: userId,
    organizationId: null,
    userOrgRelId: null,
    finalResult: 'ADMITTED',
    exam: { projectId: 1 },
    sourceBizId: 1,
    cancelledAt: null,
  } as never;
  expect(qualifiedForEntry(m, true)).toBe(true);
  expect(
    qualifiedForEntry(
      { ...m, expertAssignment: { ...m.expertAssignment!, status: 'REJECTED' } },
      true,
    ),
  ).toBe(false);
  expect(
    qualifiedForEntry({ ...m, admissionAttempt: { ...m.admissionAttempt!, sourceBizId: 2 } }, true),
  ).toBe(false);
});
test('current PM primary writes, handler only reads; roles cannot reuse an account identity', async () => {
  const tx = {
    project: { findFirst: vi.fn().mockResolvedValue({ id: 1 }) },
    projectManagerRecruitment: {
      findFirst: vi
        .fn()
        .mockResolvedValue({ candidateUserId: 'other', expertRecruitmentHandlerUserId: userId }),
    },
  };
  expect((await personnelScope(tx as never, 1, p)).readOnly).toBe(true);
  await expect(personnelScope(tx as never, 1, p, true)).rejects.toMatchObject({ status: 403 });
  await expect(personnelScope(tx as never, 1, { ...p, role: 'NAVIGATOR' })).rejects.toMatchObject({
    status: 403,
  });
  tx.projectManagerRecruitment.findFirst.mockResolvedValue({ candidateUserId: userId } as never);
  expect((await personnelScope(tx as never, 1, p, true)).readOnly).toBe(false);
});
test('Swagger examples validate; Result responses preserve nested roster and reject malformed parameters', async () => {
  vi.spyOn(AuthService.prototype, 'authenticate').mockResolvedValue(p);
  vi.spyOn(PersonnelService.prototype, 'roster').mockResolvedValue({
    ...rosterExample,
    secret: 'hidden',
  } as never);
  vi.spyOn(PersonnelService.prototype, 'saveEntry').mockResolvedValue(null);
  const config = readConfig({
    APP_ENV: 'test',
    DATABASE_URL: 'postgresql://localhost/unused_test',
    CODE_HMAC_SECRET: 'x'.repeat(32),
    SMS_PROVIDER: 'mock',
    WEB_ORIGINS: 'http://127.0.0.1:3000',
    LOG_LEVEL: 'silent',
  });
  const app = await createApp(config, new PrismaClient());
  try {
    await app.ready();
    for (const schema of [rosterBody, entryBody, rosterResponse]) {
      const validate = app.validatorCompiler!({
        schema,
        method: 'POST',
        url: '/example',
        httpPart: 'body',
      });
      for (const example of schema.examples)
        expect(validate(example), JSON.stringify(validate.errors)).toBe(true);
    }
    const result = await app.inject({
      method: 'POST',
      url: '/api/v1/project-personnel/roster/list',
      headers: { authorization: 'Bearer token' },
      payload: { projectId: 1 },
    });
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json().data).toEqual(rosterExample);
    expect(result.headers['cache-control']).toBe('no-store');
    for (const payload of [
      { projectId: '1' },
      { projectId: 1, size: 101 },
      { projectId: 1, organizationIds: [1] },
      { projectId: 1, userId },
    ]) {
      const r = await app.inject({
        method: 'POST',
        url: '/api/v1/project-personnel/roster/list',
        payload,
      });
      expect(r.statusCode, r.body).toBe(400);
      expect(r.json()).toMatchObject({ code: 400, data: null });
    }
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/project-personnel/roster/entry/save',
      payload: entryBody.examples[1],
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().data).toBeNull();
  } finally {
    await app.close();
  }
});
