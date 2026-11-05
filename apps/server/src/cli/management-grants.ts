import { PrismaClient } from '@prisma/client';
import { parseArgs } from 'node:util';
import { AppError } from '../common/errors.js';
import { readConfig } from '../config/index.js';
import { ManagementService, type GrantChange } from '../modules/management/management.service.js';

const { values } = parseArgs({
  options: Object.fromEntries(
    ['uid', 'role', 'action', 'actor', 'reason'].map((key) => [key, { type: 'string' as const }]),
  ),
  allowPositionals: false,
});
if (['uid', 'role', 'action', 'actor', 'reason'].some((key) => !values[key])) {
  throw new Error(
    '用法：--uid <用户UID> --role NAVIGATOR|PM --action GRANT|REVOKE --actor <运维操作人> --reason <原因>',
  );
}
const config = readConfig();
const db = new PrismaClient({ datasources: { db: { url: config.databaseUrl } } });
try {
  const result = await new ManagementService(db).change(values as unknown as GrantChange);
  console.info(result.changed ? '管理授权已更新并记录审计' : '授权状态已符合要求，无需更新');
} catch (error) {
  console.error(
    error instanceof AppError ? error.message : '管理授权更新失败，请检查数据库及迁移状态',
  );
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
