import { PrismaClient } from '@prisma/client';
import type { Config } from '../../config/index.js';

export function createDatabase(config: Pick<Config, 'databaseUrl'>) {
  return new PrismaClient({ datasources: { db: { url: config.databaseUrl } } });
}
