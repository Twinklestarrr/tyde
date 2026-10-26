import { PrismaClient } from '@prisma/client';
import { readConfig } from './config/index.js';
import { processDueMovements } from './modules/personnel/personnel-movement-effective.js';
const config = readConfig();
const db = new PrismaClient({ datasources: { db: { url: config.databaseUrl } } });
try {
  const result = await processDueMovements(db);
  console.info('到期人员变动处理结果:', result);
  if (result.failed) process.exitCode = 1;
} finally {
  await db.$disconnect();
}
