import { PrismaClient } from '@prisma/client';
import { readConfig } from './config/index.js';
import { compensateTransferResults } from './modules/personnel/personnel-transfer-exam.js';
const config = readConfig();
const db = new PrismaClient({ datasources: { db: { url: config.databaseUrl } } });
try {
  const result = await compensateTransferResults(db);
  console.info('转项考试结果补偿:', result);
  if (result.failed) process.exitCode = 1;
} finally {
  await db.$disconnect();
}
