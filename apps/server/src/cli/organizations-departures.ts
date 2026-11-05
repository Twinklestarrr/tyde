import { PrismaClient } from '@prisma/client';
import { readConfig } from '../config/index.js';
import { DepartureService } from '../modules/organizations/departure.service.js';
const config = readConfig();
const db = new PrismaClient({ datasources: { db: { url: config.databaseUrl } } });
try {
  const result = await new DepartureService(db).processDue();
  console.info('组织到期离职处理完成（项目清退仍待回补）:', result);
  if (result.failed) process.exitCode = 1;
} finally {
  await db.$disconnect();
}
