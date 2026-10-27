import { randomInt, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { request } from '@playwright/test';
import { MOCK_SMS_CODE } from '../../packages/shared/src/index';

const root = process.cwd();
const require = createRequire(resolve(root, 'apps/server/package.json'));
const { PrismaClient } =
  require('@prisma/client') as typeof import('../../apps/server/node_modules/@prisma/client');
const env = parseEnv(readFileSync(resolve(root, 'apps/server/.env.test'), 'utf8'));
const database = new URL(env.DATABASE_URL ?? 'invalid:');
if (
  env.APP_ENV !== 'test' ||
  env.TEST_DATABASE_RESET !== 'true' ||
  !database.pathname.endsWith('_test') ||
  !['localhost', '127.0.0.1'].includes(database.hostname)
)
  throw new Error('真实工作台联调只允许本机 .env.test 指向的专用 _test 库');

export const realApiOrigin = 'http://127.0.0.1:3100';
export const realPassword = 'Password123!';
type Role = 'NAVIGATOR' | 'PM' | 'EXPERT';
export interface RealAccount {
  id: string;
  uid: string;
  phone: string;
  nickname: string;
  realName: string;
  token: string;
}
export interface RealProject {
  id: number;
  projectNo: string;
  projectName: string;
  currentNodeCode: string;
}
export interface RealExpertCard {
  assignmentId: number;
  acceptanceStatus: string;
  sourceBizType: string;
  basicInfo: { projectId: number; projectName: string; organizationId: string | null };
  operations: { canAccept: boolean; canReject: boolean };
}

/** 业务状态经真实HTTP产生；Prisma只补分类/组织成员夹具并撤销本批测试会话，不清库。 */
export async function createRealWorkbenchFixture(mode: string) {
  const db = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } });
  const http = await request.newContext();
  const run = `${mode}-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
  const tokens: string[] = [];
  const userIds: string[] = [];
  async function api<T = Record<string, unknown>>(
    path: string,
    account?: Pick<RealAccount, 'token'>,
    data?: unknown,
  ): Promise<T> {
    const response = await http.fetch(realApiOrigin + '/api/v1' + path, {
      method: data === undefined ? 'GET' : 'POST',
      headers: {
        'x-tyde-client': 'desktop',
        ...(account ? { authorization: `Bearer ${account.token}` } : {}),
        ...(data === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(data === undefined ? {} : { data }),
    });
    const text = await response.text();
    if (response.status() !== 200) throw new Error(`${response.status()} ${path}: ${text}`);
    const payload = JSON.parse(text) as { code: number; data: T };
    if (payload.code !== 200) throw new Error(`${path}: ${text}`);
    return payload.data;
  }
  async function account(label: string, role: Role): Promise<RealAccount> {
    const phone = `138${String(randomInt(0, 100_000_000)).padStart(8, '0')}`;
    const nickname = `${label}${run}`;
    const realName = `联调${label}`;
    await api('/auth/sms/send', undefined, { phone, scene: 'login' });
    const grant = await api<{ registrationToken: string }>('/auth/sms/login', undefined, {
      phone,
      code: MOCK_SMS_CODE,
    });
    const user = await api<{ id: string; uid: string }>('/auth/register', undefined, {
      accountType: 'INDIVIDUAL',
      phone,
      registrationToken: grant.registrationToken,
      password: realPassword,
      confirmPassword: realPassword,
      nickname,
      realName,
      idCardNo: phone.padStart(17, '0') + 'X',
      email: `${phone}@example.invalid`,
    });
    userIds.push(user.id);
    const login = await api<{ accessToken: string }>('/auth/login', undefined, {
      account: phone,
      password: realPassword,
      role,
    });
    tokens.push(login.accessToken);
    return { ...user, phone, nickname, realName, token: login.accessToken };
  }
  try {
    const navigator = await account('领航', 'NAVIGATOR');
    const firstManager = await account('首任', 'PM');
    const manager = await account('继任', 'PM');
    const expert = await account('专家', 'EXPERT');
    const categories = [];
    for (const level of [1, 2, 3])
      categories.push(
        await db.projectCategory.create({
          data: {
            categoryCode: `REAL_${run}_${level}`,
            categoryName: `${run}分类${level}`,
            categoryLevel: level,
            createdBy: run,
            updatedBy: run,
          },
        }),
      );
    async function project(label: string) {
      const created = await api<{ id: number }>('/projects/create', navigator, {
        operation: 'CREATE_PROJECT',
        projectName: `${label}${run}`,
        projectDescription: '真实非空工作台项目，包含基础资料、人员画像与标准。',
        categoryLevel1Id: categories[0]!.id,
        categoryLevel2Id: categories[1]!.id,
        categoryLevel3Ids: [categories[2]!.id],
        difficultyLevel: 'MEDIUM',
        projectQuantity: 100,
        quantityUnit: '条',
        deadline: '2099-12-31 18:00:00',
        requiredHeadcount: 4,
        employmentType: 'PART_TIME',
        workSummary: '核对真实业务记录',
        standardContent: '逐条核对并记录结果',
        mandatoryRequirement: '遵守数据与作业规范',
      });
      return api<RealProject>(`/projects/${created.id}`, navigator);
    }
    const main = await project('主项目');
    const confirmPlan = (projectId: number) =>
      api(`/projects/production-plan/confirm?projectId=${projectId}`, manager, {
        operatorHeadcount: 4,
        operatorCpd: 10.25,
        needWrittenExam: false,
        needInterview: false,
        crowds: [{ crowdName: '熟练组', profileRequirement: '完成相关培训' }],
        stages: [
          {
            stageName: '稳定生产',
            startDate: '2099-01-05',
            endDate: '2099-01-09',
            workdayCountSource: 'MANUAL',
            workdayCount: 5,
            operatorHeadcount: 4,
          },
        ],
      });
    const materials = (projectId: number) =>
      api('/projects/standard-materials/update', manager, {
        projectId,
        standardContent: '真实标准与培训材料，按流程确认后下发专家。',
      });
    const recruit = (projectId: number, subjectType: string, subjectId: string) =>
      api('/projects/expert-recruitments/submit', manager, {
        projectId,
        assignments: [{ subjectType, subjectId, productionRequirement: 100, operatorHeadcount: 4 }],
      });
    const tasks = (who: RealAccount) =>
      api<RealExpertCard[]>('/expert-assignments/my-tasks', who, {});
    return {
      run,
      navigator,
      firstManager,
      manager,
      expert,
      main,
      api,
      tasks,
      async prepareExpertProjects() {
        // main 的计划由本次页面确认；不直接写共享节点、审批或等待状态。
        await materials(main.id);
        await recruit(main.id, 'INDIVIDUAL', expert.id);
        const rejected = await project('拒单项目');
        await api('/projects/manager-recruitments', navigator, {
          projectId: rejected.id,
          candidateUserId: manager.id,
        });
        await confirmPlan(rejected.id);
        await materials(rejected.id);
        await recruit(rejected.id, 'INDIVIDUAL', expert.id);
        return { accepted: main, rejected };
      },
      async prepareOrganizationProject() {
        // 使用已替换的首任策略官作为另一账号的组织主管，当前项目经理仍为manager。
        await api('/auth/switch-role', firstManager, { role: 'EXPERT' });
        const organization = await api<{ id: string }>('/organizations', firstManager, {
          name: `联调组织${run}`,
        });
        await db.userOrgRel.create({
          data: {
            orgId: organization.id,
            userId: expert.id,
            uid: expert.uid,
            position: 'MEMBER',
            joinStatus: 'ACTIVE',
          },
        });
        const organizationProject = await project('组织项目');
        await api('/projects/manager-recruitments', navigator, {
          projectId: organizationProject.id,
          candidateUserId: manager.id,
        });
        await confirmPlan(organizationProject.id);
        await materials(organizationProject.id);
        await recruit(organizationProject.id, 'ORGANIZATION', organization.id);
        return { organization, organizationProject };
      },
      async close() {
        try {
          await Promise.allSettled(tokens.map((token) => api('/auth/logout', { token }, {})));
          await db.session.updateMany({
            where: { userId: { in: userIds }, revokedAt: null },
            data: { revokedAt: new Date() },
          });
        } finally {
          await http.dispose();
          await db.$disconnect();
        }
      },
    };
  } catch (error) {
    try {
      await Promise.allSettled(tokens.map((token) => api('/auth/logout', { token }, {})));
      await db.session.updateMany({
        where: { userId: { in: userIds }, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    } finally {
      await http.dispose();
      await db.$disconnect();
    }
    throw error;
  }
}

export type RealWorkbenchFixture = Awaited<ReturnType<typeof createRealWorkbenchFixture>>;
