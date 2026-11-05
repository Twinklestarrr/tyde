import { PrismaClient } from '@prisma/client';
import { readConfig } from '../config/index.js';
import { createObjectStorage } from '../infrastructure/storage/object-storage.js';
import { FileRegistryService } from '../modules/files/file-registry.service.js';
const config = readConfig();
const db = new PrismaClient({ datasources: { db: { url: config.databaseUrl } } });
const cutoff = new Date(Date.now() - 30 * 86_400_000);
try {
  const counts = await db.$transaction([
    db.verificationChallenge.deleteMany({ where: { expiresAt: { lt: cutoff } } }),
    db.registrationGrant.deleteMany({ where: { expiresAt: { lt: cutoff } } }),
    db.session.deleteMany({
      where: { OR: [{ expiresAt: { lt: cutoff } }, { revokedAt: { lt: cutoff } }] },
    }),
    db.memberImportReceipt.deleteMany({ where: { expiresAt: { lt: new Date() } } }),
    db.authRateLimit.deleteMany({ where: { expiresAt: { lt: cutoff } } }),
  ]);
  console.info(
    '清理完成，删除条数:',
    counts.map((x) => x.count),
  );
  if (config.files.provider !== 'disabled') {
    const result = await new FileRegistryService(
      db,
      createObjectStorage(config.files),
      config.files,
    ).cleanupExpired();
    console.info('文件清理完成:', result);
    if (result.failed) process.exitCode = 1;
  }
} finally {
  await db.$disconnect();
}
