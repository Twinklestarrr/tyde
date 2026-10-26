import { PrismaClient } from '@prisma/client';
import { readConfig } from './config/index.js';
import { reconcileMovementApprovers } from './modules/personnel/personnel-movement-approvers.js';
const config = readConfig();
const db = new PrismaClient({ datasources: { db: { url: config.databaseUrl } } });
try {
  const result = await reconcileMovementApprovers(db);
  console.info('人员变动审批人同步结果:', result);
  if (result.failed) process.exitCode = 1;
} finally {
  await db.$disconnect();
}
