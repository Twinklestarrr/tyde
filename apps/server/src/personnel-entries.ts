import { PrismaClient } from '@prisma/client';
import { readConfig } from './config/index.js';
import { PersonnelService } from './modules/personnel/personnel.service.js';
const config = readConfig();
const db = new PrismaClient({ datasources: { db: { url: config.databaseUrl } } });
try {
  const result = await new PersonnelService(db).processDue();
  console.info('到期入项处理结果:', result);
  if (result.failed) process.exitCode = 1;
} finally {
  await db.$disconnect();
}
